import { NextRequest, NextResponse } from "next/server";
import { computeJournalAttribution, readJournalAttribution, ATTRIB_TTL_MS } from "@/app/lib/journal-attribution";

/**
 * Decision-journal attribution feed. Serves the cached pm:journal-attribution
 * blob when fresh (< 6h); recomputes on miss/stale or ?refresh=1. Reads
 * pm:decision-journal / pm:stocks READ-ONLY; writes only its own regenerable
 * cache. Zero Anthropic spend.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    const cached = await readJournalAttribution();
    const fresh = cached && Date.now() - new Date(cached.computedAt).getTime() < ATTRIB_TTL_MS;
    if (cached && fresh && !force) return NextResponse.json({ ok: true, cached: true, data: cached });

    const result = await computeJournalAttribution();
    return NextResponse.json({ ok: true, cached: false, data: result });
  } catch (e) {
    // Serve the stale cache rather than blanking when compute fails.
    const cached = await readJournalAttribution().catch(() => null);
    if (cached) return NextResponse.json({ ok: true, cached: true, stale: true, data: cached });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
