import { NextRequest, NextResponse } from "next/server";
import { computeRiskAnalytics, readRiskAnalytics, RISK_TTL_MS } from "@/app/lib/risk-analytics";

/**
 * Book-level risk lens feed. Serves the cached pm:risk-analytics blob when
 * fresh (< 6h); recomputes on miss/stale or ?refresh=1. Cookie-gated by the
 * auth middleware like every dashboard route. Reads pm:stocks / pm:market
 * READ-ONLY; writes only its own regenerable cache.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    const cached = await readRiskAnalytics();
    const fresh = cached && Date.now() - new Date(cached.computedAt).getTime() < RISK_TTL_MS;
    if (cached && fresh && !force) return NextResponse.json({ ok: true, cached: true, data: cached });

    const result = await computeRiskAnalytics();
    if ("error" in result) {
      // Serve the stale cache rather than blanking when compute fails.
      if (cached) return NextResponse.json({ ok: true, cached: true, stale: true, error: result.error, data: cached });
      return NextResponse.json({ ok: false, error: result.error });
    }
    return NextResponse.json({ ok: true, cached: false, data: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
