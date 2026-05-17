import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { Scores } from "@/app/lib/types";

/**
 * Per-ticker score history — APPEND-ONLY change log.
 *
 * Every time the user rescores a stock, we append a new entry for that
 * ticker. The tile on the stock page reads this blob so the analyst can
 * see how the composite score has drifted over time (and which category
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
 * SAFETY INVARIANTS (same pattern as pm:portfolio-snapshots):
 *   1. GET returns {} on missing/error — never seed defaults.
 *   2. POST validates `entry.date === today` server-side. Past-dated
 *      writes return 400 so a stale client can't rewrite history.
 *   3. POST is read-merge-write: existing ticker arrays preserved,
 *      new entry appended only to the targeted ticker.
 *   4. No DELETE endpoint.
 */

const KEY = "pm:score-history";

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
 * POST appends a single entry for a single ticker.
 * Request body: { ticker: string, entry: ScoreHistoryEntry }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    const entry = body?.entry as ScoreHistoryEntry | undefined;
    if (!ticker) {
      return NextResponse.json({ error: "ticker required" }, { status: 400 });
    }
    if (!entry || typeof entry !== "object" || typeof entry.date !== "string") {
      return NextResponse.json({ error: "entry with date required" }, { status: 400 });
    }

    const today = todayUTC();
    if (entry.date !== today) {
      return NextResponse.json(
        { error: `Entry date ${entry.date} is not today (${today}). Past-dated writes are not allowed.` },
        { status: 400 },
      );
    }

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const current: ScoreHistoryStore = raw ? JSON.parse(raw) : {};

    const arr = Array.isArray(current[ticker]) ? current[ticker] : [];
    arr.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    current[ticker] = arr;

    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, count: arr.length });
  } catch (e) {
    console.error("Redis write error (score-history):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
