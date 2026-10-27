import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { THESIS_ARCHIVE_KEY as ARCHIVE_KEY, type ArchivedThesis } from "@/app/lib/thesis-archive";

/**
 * pm:position-theses-archive — theses removed from the Thesis desk (sold
 * names), kept so a removal can be undone. Written ONLY by
 * DELETE /api/kv/position-theses. Backed up (not in the exclude list).
 *
 * GET  → { archive: { [TICKER]: { removedAt, underwrittenAt? }[] } } (summary)
 * POST { ticker } → restores that name's most recent archived thesis into
 *      pm:position-theses. Refuses (409) if the name already has a live
 *      thesis, so a restore can never overwrite newer work. The archived copy
 *      is removed only after the live write succeeds.
 */

export async function GET() {
  try {
    const raw = await (await getRedis()).get(ARCHIVE_KEY);
    const archive: Record<string, ArchivedThesis[]> = raw ? JSON.parse(raw) : {};
    const summary = Object.fromEntries(
      Object.entries(archive).map(([tk, list]) => [tk, list.map((e) => ({ removedAt: e.removedAt, underwrittenAt: e.underwrittenAt }))]),
    );
    return NextResponse.json({ archive: summary });
  } catch (e) {
    console.error("Redis read error (position-theses archive):", e);
    return NextResponse.json({ archive: {} });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    const redis = await getRedis();
    const rawArchive = await redis.get(ARCHIVE_KEY);
    const archive: Record<string, ArchivedThesis[]> = rawArchive ? JSON.parse(rawArchive) : {};
    const list = archive[ticker] ?? [];
    const last = list[list.length - 1];
    if (!last) return NextResponse.json({ error: "nothing archived for this ticker" }, { status: 404 });

    const raw = await redis.get("pm:position-theses");
    const live = raw ? JSON.parse(raw) : {};
    if (live[ticker]) {
      return NextResponse.json({ error: `${ticker} already has a live thesis — not overwritten` }, { status: 409 });
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { removedAt, ...entry } = last;
    live[ticker] = entry;
    await redis.set("pm:position-theses", JSON.stringify(live));

    archive[ticker] = list.slice(0, -1);
    if (archive[ticker].length === 0) delete archive[ticker];
    await redis.set(ARCHIVE_KEY, JSON.stringify(archive));
    return NextResponse.json({ ok: true, ticker, restored: true });
  } catch (e) {
    console.error("Redis write error (position-theses restore):", e);
    return NextResponse.json({ error: "restore failed" }, { status: 500 });
  }
}
