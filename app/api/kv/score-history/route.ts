import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { Scores } from "@/app/lib/types";

/**
 * Per-ticker score history — append-with-revisions change log.
 *
 * Every time the user rescores a stock we add (or revise) an entry for
 * that ticker. The Stock page reads this blob so the analyst can see
 * how the composite score has drifted over time (and which category
 * moved it).
 *
 * Storage shape (single JSON blob):
 *   {
 *     "AAPL": [
 *       { date: "2026-04-20", timestamp: "...", total: 72.5, raw: 70.0,
 *         adjusted: 72.5, scores: { growth: 7, ... } },
 *       ...
 *     ],
 *     "NVDA": [ ... ],
 *   }
 *
 * Two write modes (POST body field `mode`):
 *   - "append" (default): adds a new entry. Requires entry.date === today
 *     UTC; past-dated writes return 400. This is the path used by the
 *     per-stock Score button and Score All / Score Bucket.
 *   - "patch-recent": overwrites the latest entry's total/raw/adjusted/
 *     scores IF that entry was created within REVISION_WINDOW_HOURS.
 *     Used by the Stock page when the PM tweaks a MANUAL category in the
 *     days after a rescore — the score-history log is supposed to
 *     reflect the analyst's FINAL composite, not the AI-only number, so
 *     post-rescore manual adjustments roll into the most-recent entry
 *     rather than creating a stream of micro-entries. If the most-recent
 *     entry is older than the window, the PATCH is a no-op (returns
 *     { patched: false }) — manual edits do NOT create entries on their
 *     own.
 *
 * SAFETY INVARIANTS:
 *   1. GET returns {} on missing/error — never seed defaults.
 *   2. POST mode="append" validates entry.date === today UTC.
 *   3. POST is read-merge-write: existing ticker arrays preserved.
 *   4. No DELETE endpoint.
 *   5. patch-recent NEVER appends and NEVER changes the entry's `date`
 *      or `timestamp` — only the score-fact fields are revised.
 */

const KEY = "pm:score-history";

/**
 * How long a rescore entry stays "open" for revision via patch-recent.
 * 72 hours covers the normal weekly rescore cadence — the PM reviews
 * the AI-scored result, then tweaks manual categories (brand, charting,
 * externalSources, turnaround) over the next few days. All those edits
 * roll into the same entry rather than spawning new ones.
 */
const REVISION_WINDOW_HOURS = 72;
const REVISION_WINDOW_MS = REVISION_WINDOW_HOURS * 60 * 60 * 1000;

export type ScoreHistoryEntry = {
  date: string;          // YYYY-MM-DD (UTC, server-authoritative)
  timestamp: string;     // ISO timestamp
  total: number;         // stock.adjusted at time of score
  raw: number;           // stock.raw at time of score
  adjusted: number;      // stock.adjusted (duplicate of total for clarity)
  scores: Scores;
  /**
   * Whether this rescore used Anthropic web_search to verify and augment
   * the cached fundamentals. Optional for backward compat — entries written
   * before the verify feature don't have it.
   */
  verifiedSearch?: boolean;
  /** Web search queries the model issued during a verified rescore. */
  searchQueries?: string[];
  /** Web search citation URLs surfaced during a verified rescore (titles optional). */
  searchCitations?: Array<{ url: string; title?: string }>;
  /**
   * Verification audit status — distinguishes "verification ran and completed"
   * from "verification was attempted but produced no results" from "no
   * verification attempted at all". Optional for backward compat.
   *   - "complete": verifiedSearch=true and at least one search ran cleanly
   *   - "partial": verifiedSearch=true but the model issued fewer searches than
   *     the prompt asked for (likely rate-limited, refused, or no useful hits)
   *   - "skipped": verifiedSearch=false (verify mode was off — should not
   *     happen from the UI today since verify is always on)
   *   - "failed": verifiedSearch=true but zero searches ran (tool unavailable
   *     or upstream error)
   */
  verificationStatus?: "complete" | "partial" | "skipped" | "failed";
  /**
   * Set by a patch-recent revision. ISO timestamp of the most recent
   * manual-edit overwrite of this entry's total/scores. The entry's
   * original `date` and `timestamp` are preserved — `revisedAt` is the
   * one new field that records "this entry was tweaked after the
   * initial rescore."
   */
  revisedAt?: string;
};

export type ScoreHistoryStore = Record<string, ScoreHistoryEntry[]>;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ history: {} });
    return NextResponse.json({ history: JSON.parse(raw) as ScoreHistoryStore });
  } catch (e) {
    console.error("Redis read error (score-history):", e);
    return NextResponse.json({ history: {} });
  }
}

/**
 * POST writes a history entry for a single ticker.
 *
 * Request body:
 *   {
 *     ticker: string,
 *     entry: ScoreHistoryEntry,
 *     mode?: "append" | "patch-recent"
 *   }
 *
 * mode="append" (default):
 *   - Validates entry.date === today UTC, rejects with 400 otherwise.
 *   - Appends a new entry to the ticker's array.
 *   - Response: { ok: true, count, mode: "append" }
 *
 * mode="patch-recent":
 *   - Looks up the latest entry for this ticker.
 *   - If it was created (timestamp) within REVISION_WINDOW_HOURS,
 *     overwrites its total/raw/adjusted/scores with the new values.
 *     Preserves the entry's original `date` and `timestamp`. Stamps
 *     `revisedAt` with `now`.
 *   - If outside the window, returns { patched: false } — manual edits
 *     long after a rescore are NOT logged as new entries.
 *   - entry.date is ignored in this mode (no date validation).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    const entry = body?.entry as ScoreHistoryEntry | undefined;
    const mode: "append" | "patch-recent" = body?.mode === "patch-recent" ? "patch-recent" : "append";
    if (!ticker) {
      return NextResponse.json({ error: "ticker required" }, { status: 400 });
    }
    if (!entry || typeof entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const current: ScoreHistoryStore = raw ? JSON.parse(raw) : {};
    const arr = Array.isArray(current[ticker]) ? current[ticker] : [];

    if (mode === "patch-recent") {
      // Find the most recent entry; if it's within the revision window
      // overwrite its score fields. Otherwise no-op (manual edits without
      // a recent rescore don't create entries on their own).
      const latest = arr[arr.length - 1];
      if (!latest) {
        return NextResponse.json({ patched: false, reason: "no entries yet" });
      }
      const latestMs = new Date(latest.timestamp).getTime();
      if (!Number.isFinite(latestMs)) {
        return NextResponse.json({ patched: false, reason: "latest entry has invalid timestamp" });
      }
      const ageMs = Date.now() - latestMs;
      if (ageMs > REVISION_WINDOW_MS) {
        return NextResponse.json({
          patched: false,
          reason: `latest entry is ${Math.round(ageMs / 3600000)}h old (>${REVISION_WINDOW_HOURS}h window)`,
        });
      }
      // Overwrite score-fact fields only. Preserve date, original
      // timestamp, and verification metadata from the original rescore.
      arr[arr.length - 1] = {
        ...latest,
        total: typeof entry.total === "number" ? entry.total : latest.total,
        raw: typeof entry.raw === "number" ? entry.raw : latest.raw,
        adjusted: typeof entry.adjusted === "number" ? entry.adjusted : latest.adjusted,
        scores: entry.scores ?? latest.scores,
        revisedAt: new Date().toISOString(),
      };
      current[ticker] = arr;
      await redis.set(KEY, JSON.stringify(current));
      return NextResponse.json({ patched: true, mode: "patch-recent", count: arr.length });
    }

    // mode === "append"
    if (typeof entry.date !== "string") {
      return NextResponse.json({ error: "entry.date required for append" }, { status: 400 });
    }
    const today = todayUTC();
    if (entry.date !== today) {
      return NextResponse.json(
        { error: `Entry date ${entry.date} is not today (${today}). Past-dated writes are not allowed.` },
        { status: 400 },
      );
    }
    arr.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    current[ticker] = arr;
    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, count: arr.length, mode: "append" });
  } catch (e) {
    console.error("Redis write error (score-history):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
