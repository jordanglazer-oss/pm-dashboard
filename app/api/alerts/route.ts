import { getRedis } from "@/app/lib/redis";
import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts } from "@/app/lib/alerts";
import { computeRegimeTransition } from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";

/**
 * GET /api/alerts — the proactive "needs your attention" digest (Phase 07).
 *
 * Pure aggregation of already-stored signals, all READ-ONLY:
 *   pm:thesis-health (verdicts) + pm:market-regime (→ transition) + pm:stocks
 *   (critical risk levels). No writes.
 */

const log = createLogger("Alerts");

export async function GET() {
  try {
    const redis = await getRedis();
    const [thesisRaw, regimeRaw, stocksRaw] = await Promise.all([
      redis.get("pm:thesis-health"),
      redis.get("pm:market-regime"),
      redis.get("pm:stocks"),
    ]);

    const thesis = (() => {
      try {
        return thesisRaw ? JSON.parse(thesisRaw) : null;
      } catch {
        return null;
      }
    })();

    let transition = null;
    try {
      if (regimeRaw) {
        const regime = JSON.parse(regimeRaw) as MarketRegimeData;
        if (regime?.composite) transition = computeRegimeTransition(regime);
      }
    } catch {
      /* skip */
    }

    const risk = (() => {
      try {
        const parsed = stocksRaw ? JSON.parse(stocksRaw) : [];
        if (!Array.isArray(parsed)) return null;
        return (
          parsed as Array<{
            ticker?: string;
            bucket?: string;
            riskAlert?: { level?: string; summary?: string; signals?: Array<{ name: string; status: string }> };
          }>
        ).map((s) => ({
          ticker: s.ticker ?? "",
          bucket: s.bucket,
          riskLevel: s.riskAlert?.level,
          riskSummary: s.riskAlert?.summary,
          dangerSignals: (s.riskAlert?.signals ?? []).filter((sig) => sig.status === "danger").map((sig) => sig.name),
        }));
      } catch {
        return null;
      }
    })();

    const alerts = computeAlerts({ thesis, transition, risk });
    return NextResponse.json({ alerts, counts: alertCounts(alerts), generatedAt: new Date().toISOString() });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ alerts: [], counts: { high: 0, medium: 0, total: 0 } });
  }
}
