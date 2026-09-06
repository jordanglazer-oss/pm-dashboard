import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, computeOpportunities, computeRegimeTailwind, entryAlerts, entryOpportunities } from "@/app/lib/alerts";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { getEntryScan, newlyReady } from "@/app/lib/entry-scan";

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
    const { thesis, transition, risk, context, watchlist, killWatch } = await loadAlertInputs();

    // Entry scorecard (cached 6h): newly-ready names are HIGH alerts (the push),
    // every ready name is an opportunity.
    const scan = await getEntryScan().catch(() => null);
    const ready = scan ? scan.rows.filter((r) => r.ready) : [];
    const fresh = scan ? newlyReady(scan) : [];
    const alerts = [...computeAlerts({ thesis, transition, risk, context, killWatch }), ...entryAlerts(fresh)];
    // A toward-Risk-On lean is a tailwind, not an alert — surfaced green.
    const regimeTailwind = computeRegimeTailwind(transition);
    const seen = new Set(ready.map((r) => r.ticker));
    const opportunities = [...entryOpportunities(ready), ...computeOpportunities({ watchlist, context }).filter((o) => !seen.has(o.ticker))];

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
