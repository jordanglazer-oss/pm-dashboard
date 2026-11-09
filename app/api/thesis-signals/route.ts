import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { KillCondition, ThesisPillar } from "@/app/lib/kill-conditions";
import { loadKillSignalSources, killSignalExtrasFor, pillarTrends, recapLineLabels } from "@/app/lib/metric-resolver";

/**
 * GET /api/thesis-signals?ticker=X — the server-resolved half of KillSignals
 * for one name (metric readings from the ingested Metrics Recap, SIA
 * percentile, Equate rank, MarketEdge), so the stock-page ThesisTile can run
 * the same pure checker the nightly sweep runs. Read-only; zero tokens.
 *
 * Also returns each pillar's evidence trend (its `measures` read across every
 * Metrics Recap on file) and the recap line labels the pillar editor offers.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tk = (new URL(req.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  try {
    const [src, thesesRaw] = await Promise.all([loadKillSignalSources(), (await getRedis()).get("pm:position-theses")]);
    let conditions: KillCondition[] = [];
    let pillars: ThesisPillar[] = [];
    try {
      const theses = thesesRaw ? (JSON.parse(thesesRaw) as Record<string, { killConditions?: KillCondition[]; pillars?: ThesisPillar[] }>) : {};
      conditions = theses[tk]?.killConditions ?? [];
      pillars = Array.isArray(theses[tk]?.pillars) ? theses[tk]!.pillars! : [];
    } catch {
      conditions = [];
    }
    return NextResponse.json({
      ticker: tk,
      extras: killSignalExtrasFor(tk, conditions, src),
      pillarTrends: pillarTrends(src.takeaways, tk, pillars),
      recapLines: recapLineLabels(src.takeaways, tk),
    });
  } catch (e) {
    console.error("thesis-signals failed:", e);
    return NextResponse.json({ ticker: tk, extras: {} });
  }
}
