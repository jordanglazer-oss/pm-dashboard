import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { mergeCandidates, type CandidateStore, type SourceHit } from "@/app/lib/watchlist-candidates";

const KEY = "pm:watchlist-candidates";

/**
 * pm:watchlist-candidates — the Suggested Watchlist.
 *
 * GET  returns the store as-is.
 * POST folds a fresh set of source hits in (see mergeCandidates) and persists.
 *
 * The weekly refresh is a MERGE, never a replace: history is the point. A
 * candidate carries when it was first seen, when it was last seen, and — if
 * every source has dropped it — when it fell off and what it fell from.
 *
 * `sourcesSeen` must list the sources that actually reported. Without it, a
 * week where one export failed to arrive would read as every one of its names
 * dropping off at once.
 *
 * SAFETY:
 *   - GET returns { candidates: [] } on missing/error — never seeds.
 *   - Writes ONLY this key. Nothing here touches pm:stocks: promoting a
 *     candidate to the real watchlist stays a deliberate, separate action.
 */

async function read(): Promise<CandidateStore> {
  try {
    const raw = await (await getRedis()).get(KEY);
    if (!raw) return { candidates: [] };
    const parsed = JSON.parse(raw) as CandidateStore;
    return Array.isArray(parsed?.candidates) ? parsed : { candidates: [] };
  } catch (e) {
    console.error("Redis read error (watchlist-candidates):", e);
    return { candidates: [] };
  }
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const hits: SourceHit[] = Array.isArray(body?.hits) ? body.hits : [];
    const sourcesSeen: string[] = Array.isArray(body?.sourcesSeen) ? body.sourcesSeen : [];
    if (sourcesSeen.length === 0) {
      return NextResponse.json(
        { error: "sourcesSeen is required — without it a missing export looks like a mass fall-off" },
        { status: 400 },
      );
    }
    const asOf = typeof body?.asOf === "string" ? body.asOf : new Date().toISOString();

    const prev = await read();
    const next = mergeCandidates(prev, hits, asOf, sourcesSeen);

    if (body?.dryRun) {
      return NextResponse.json({ dryRun: true, candidates: next.candidates.length, preview: next });
    }
    await (await getRedis()).set(KEY, JSON.stringify(next));
    return NextResponse.json({
      ok: true,
      generatedAt: next.generatedAt,
      total: next.candidates.length,
      live: next.candidates.filter((c) => !c.fallenOffAt).length,
      fellOff: next.candidates.filter((c) => c.fallenOffAt === asOf).length,
    });
  } catch (e) {
    console.error("Redis write error (watchlist-candidates):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
