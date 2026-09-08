import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { KillCondition } from "@/app/lib/kill-conditions";
import { loadKillSignalSources, killSignalExtrasFor } from "@/app/lib/metric-resolver";

/**
 * GET /api/thesis-signals?ticker=X — the server-resolved half of KillSignals
 * for one name (metric readings from the ingested Metrics Recap, SIA
 * percentile, Equate rank, MarketEdge), so the stock-page ThesisTile can run
 * the same pure checker the nightly sweep runs. Read-only; zero tokens.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tk = (new URL(req.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  try {
    const [src, thesesRaw] = await Promise.all([loadKillSignalSources(), (await getRedis()).get("pm:position-theses")]);
    let conditions: KillCondition[] = [];
    try {
      const theses = thesesRaw ? (JSON.parse(thesesRaw) as Record<string, { killConditions?: KillCondition[] }>) : {};
      conditions = theses[tk]?.killConditions ?? [];
    } catch {
      conditions = [];
    }
    return NextResponse.json({ ticker: tk, extras: killSignalExtrasFor(tk, conditions, src) });
  } catch (e) {
    console.error("thesis-signals failed:", e);
    return NextResponse.json({ ticker: tk, extras: {} });
  }
}
