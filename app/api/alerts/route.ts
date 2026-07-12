import { getRedis } from "@/app/lib/redis";
import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, computeOpportunities, computeRegimeTailwind } from "@/app/lib/alerts";
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
    const [thesisRaw, regimeRaw, stocksRaw, snapsRaw, scoreRaw] = await Promise.all([
      redis.get("pm:thesis-health"),
      redis.get("pm:market-regime"),
      redis.get("pm:stocks"),
      redis.get("pm:analyst-snapshots"),
      redis.get("pm:score-history"),
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
    // A toward-Risk-On lean is a tailwind, not an alert — surfaced green.
    const regimeTailwind = computeRegimeTailwind(transition);

    // ── Opportunities: watchlist (non-held) names with improving signals ──
    const snaps: Record<string, { factset?: { revUp?: number; revDown?: number } }> = (() => {
      try {
        return snapsRaw ? JSON.parse(snapsRaw) : {};
      } catch {
        return {};
      }
    })();
    const scoreHist: Record<string, Array<{ date: string; total: number }>> = (() => {
      try {
        return scoreRaw ? JSON.parse(scoreRaw) : {};
      } catch {
        return {};
      }
    })();
    // Score change over ~45 calendar days from the per-ticker history.
    const scoreDeltaFor = (tk: string): number | null => {
      const hist = (scoreHist[tk] ?? scoreHist[tk.toUpperCase()] ?? [])
        .filter((e) => e && typeof e.total === "number" && typeof e.date === "string")
        .slice()
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (hist.length < 2) return null;
      const latest = hist[hist.length - 1];
      const [y, m, d] = latest.date.split("-").map(Number);
      const cutoff = new Date(Date.UTC(y, m - 1, d - 45)).toISOString().slice(0, 10);
      let baseline = hist[0].total;
      for (const e of hist) if (e.date <= cutoff) baseline = e.total;
      return Math.round((latest.total - baseline) * 10) / 10;
    };
    const watchlist = (risk ?? [])
      .filter((r) => r.bucket === "Watchlist" && r.ticker)
      .map((r) => {
        const tk = r.ticker.toUpperCase();
        const fs = snaps[tk]?.factset;
        const net = fs && (typeof fs.revUp === "number" || typeof fs.revDown === "number") ? (fs.revUp ?? 0) - (fs.revDown ?? 0) : null;
        return { ticker: tk, netRevisions: net, scoreDelta: scoreDeltaFor(tk), riskLevel: r.riskLevel };
      });
    const opportunities = computeOpportunities({ watchlist });

    return NextResponse.json({ alerts, opportunities, regimeTailwind, counts: alertCounts(alerts), generatedAt: new Date().toISOString() });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ alerts: [], opportunities: [], regimeTailwind: null, counts: { high: 0, medium: 0, total: 0 } });
  }
}
