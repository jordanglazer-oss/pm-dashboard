import { NextRequest, NextResponse } from "next/server";
import { readSiaHistory, appendSiaHistory, type SiaHistoryEntry } from "@/app/lib/sia-history";

/**
 * pm:sia-history — append-only per-ticker log of SIA relative-strength
 * readings. See app/lib/sia-history.ts for what it's for and why it's scoped
 * to held names.
 *
 *   GET  /api/kv/sia-history            → the whole store ({} when empty)
 *   POST /api/kv/sia-history { readings } → append today's readings
 *
 * The emailed-CSV path calls appendSiaHistory directly from inbox-dispatch;
 * this route serves the Inbox page's manual upload (which parses client-side)
 * and any read of the log.
 *
 * DATE INVARIANT, copied from pm:portfolio-snapshots and pm:score-history:
 * entries are stamped SERVER-SIDE with today's UTC date, and a client-supplied
 * `date` that isn't today is rejected with 400 rather than quietly accepted.
 * That keeps the log honest as evidence — a backfilled row would be
 * indistinguishable from one observed at the time.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  // Never seed: an empty store must read as empty, not as defaults that a
  // later write could persist over real history.
  return NextResponse.json(await readSiaHistory());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw = body?.readings;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "readings object required" }, { status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (body?.date && body.date !== today) {
      return NextResponse.json(
        { error: `Refusing a past/future-dated write: got ${body.date}, server date is ${today}.` },
        { status: 400 },
      );
    }

    const readings: Record<string, Omit<SiaHistoryEntry, "date" | "timestamp">> = {};
    for (const [t, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!t || !v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      const num = (k: string, lo?: number, hi?: number): number | undefined => {
        const v = r[k];
        if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
        // Range-check rather than store nonsense: an out-of-range value in an
        // append-only log is permanent, and a percentile of 4,200 would read
        // as a genuine observation forever.
        if (lo != null && v < lo) return undefined;
        if (hi != null && v > hi) return undefined;
        return v;
      };
      readings[t.toUpperCase()] = {
        smax: num("smax", 0, 10),
        percentile: num("percentile", 0, 100),
        rank: num("rank", 1),
        universeSize: num("universeSize", 1),
      };
    }

    return NextResponse.json(await appendSiaHistory(readings, { date: today }));
  } catch (e) {
    console.error("sia-history POST failed:", e);
    return NextResponse.json({ error: "append failed" }, { status: 500 });
  }
}
