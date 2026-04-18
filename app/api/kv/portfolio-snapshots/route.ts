import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Daily portfolio snapshots — APPEND-ONLY history store.
 *
 * Persists one snapshot per (date, group, profile) tuple so we can render
 * trend charts later (sector drift, portfolio β over time, top-10
 * concentration, etc.) without back-filling from scratch.
 *
 * Storage shape (single JSON blob keyed by a composite field string):
 *   {
 *     "2026-04-17:PIM:all-equity":  { date, groupId, profile, totals, beta, sectors: [...], topHoldings: [...] },
 *     "2026-04-17:PIM:balanced":    { ... },
 *     "2026-04-17:CGF:balanced":    { ... },
 *     "2026-04-18:PIM:all-equity":  { ... },
 *     ...
 *   }
 *
 * SAFETY INVARIANTS — these exist to prevent the Mark-Newton-style
 * "previous data got clobbered" failure mode:
 *
 *   1. GET returns {} on missing or error (never seeds defaults).
 *   2. POST writes ONLY today's entries. Past-dated entries in a POST
 *      body are rejected with 400. This means a stale client with an
 *      outdated in-memory blob cannot overwrite history by re-POSTing.
 *   3. POST is read-merge-write: the existing blob is loaded, the
 *      incoming today-entries are merged in, and the result is written
 *      back. Every previously-stored date is preserved verbatim.
 *   4. There is NO DELETE endpoint. Snapshots, once written, are
 *      permanent for the lifetime of the Redis instance.
 */

const KEY = "pm:portfolio-snapshots";

export type PortfolioSnapshot = {
  date: string;          // YYYY-MM-DD (client-local)
  groupId: string;
  profile: string;
  totalValue?: number;
  portfolioBeta?: number;
  sectors: { sector: string; weight: number }[];
  topHoldings: { symbol: string; name: string; weight: number }[];
  savedAt: string;       // ISO timestamp of when the snapshot was saved
};

export type SnapshotStore = Record<string, PortfolioSnapshot>;

/** Today's date in YYYY-MM-DD (UTC). Keeps the server authoritative. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse the leading date off a composite field key. */
function dateFromField(field: string): string {
  return field.slice(0, 10);
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ entries: {} });
    return NextResponse.json({ entries: JSON.parse(raw) as SnapshotStore });
  } catch (e) {
    console.error("Redis read error (portfolio-snapshots):", e);
    // Per CLAUDE.md: return empty on read error so we never seed defaults
    // that could later overwrite real data via POST.
    return NextResponse.json({ entries: {} });
  }
}

/**
 * POST merges today's snapshot entries into the existing blob.
 * Request body: { entries: { [fieldKey]: PortfolioSnapshot } }
 *
 * Rejected with 400 if any entry's date is not today — stale writes
 * cannot clobber history.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const incoming = body?.entries;
    if (!incoming || typeof incoming !== "object") {
      return NextResponse.json({ error: "entries object required" }, { status: 400 });
    }

    const today = todayUTC();
    // Enforce: every incoming field must be dated today. Rejects
    // outright rather than silently dropping — the client needs to know.
    for (const field of Object.keys(incoming)) {
      const d = dateFromField(field);
      if (d !== today) {
        return NextResponse.json(
          { error: `Entry "${field}" is not dated today (${today}). Past-dated writes are not allowed.` },
          { status: 400 },
        );
      }
    }

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const current: SnapshotStore = raw ? JSON.parse(raw) : {};

    for (const [field, entry] of Object.entries(incoming as SnapshotStore)) {
      if (!entry || typeof entry !== "object") continue;
      current[field] = {
        ...entry,
        savedAt: entry.savedAt || new Date().toISOString(),
      };
    }

    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, size: Object.keys(current).length });
  } catch (e) {
    console.error("Redis write error (portfolio-snapshots):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
