import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, computeOpportunities, computeRegimeTailwind } from "@/app/lib/alerts";
import { loadAlertInputs } from "@/app/lib/alert-inputs";

/**
 * GET /api/alerts — the proactive "needs your attention" digest (Phase 07).
 *
 * Pure aggregation of already-stored signals, all READ-ONLY (pm:thesis-health,
 * pm:market-regime, pm:stocks, pm:analyst-snapshots, pm:score-history). No writes.
 *
 * Shares loadAlertInputs() with the morning email digest, so the tile and the
 * email are computed from IDENTICAL data and carry the same enrichment
 * (supporting metrics + a concrete action per alert).
 */

const log = createLogger("Alerts");

export async function GET() {
  try {
    const { thesis, transition, risk, context, watchlist } = await loadAlertInputs();

    const alerts = computeAlerts({ thesis, transition, risk, context });
    // A toward-Risk-On lean is a tailwind, not an alert — surfaced green.
    const regimeTailwind = computeRegimeTailwind(transition);
    const opportunities = computeOpportunities({ watchlist, context });

    return NextResponse.json({
      alerts,
      opportunities,
      regimeTailwind,
      counts: alertCounts(alerts),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ alerts: [], opportunities: [], regimeTailwind: null, counts: { high: 0, medium: 0, total: 0 } });
  }
}
