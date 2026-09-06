/**
 * Regime section — the canonical composite (label, raw label, 0-100 dial,
 * pending flip, distance to flip), the three horizon dials, the transition
 * gauge, the last 30 sessions of the dial, and the sector implication map
 * (sector/industry ETF returns joined with the book's active sector weights).
 * READ-ONLY over pm:market-regime / pm:regime-history / pm:market-drivers /
 * pm:risk-analytics.
 */

import { readRegimeCache } from "@/app/lib/market-regime-refresh";
import { readRegimeHistory } from "@/app/lib/regime-history";
import { computeRegimeTransition, type RegimeTransition } from "@/app/lib/regime-transition";
import {
  HORIZONS,
  type FlipPlan,
  type Horizon,
  type SignalContribution,
  flipCandidates,
  signalContributions,
} from "@/app/lib/horizons";
import { readRiskAnalytics } from "@/app/lib/risk-analytics";
import type { MarketRegimeData, RegimeComposite } from "@/app/lib/market-regime";
import type { MarketDrivers } from "@/app/lib/market-drivers";

export type SectorMapRow = {
  symbol: string;
  label: string;
  kind: "sector" | "industry";
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  ret3m: number | null;
  /** Book weight in this sector (%), when the ETF maps to a GICS sector. */
  bookWeightPct: number | null;
  spWeightPct: number | null;
  activePct: number | null;
};

export type RegimeSection = {
  available: boolean;
  computedAt: string | null;
  composite: RegimeComposite | null;
  horizons: { id: Horizon; label: string; shortLabel: string; weight: number; score: number | null; label_: string; riskOn: number; riskOff: number; total: number }[];
  transition: RegimeTransition | null;
  /** What each signal is worth on the 0..100 dial; sums to score100 − 50. */
  contributions: SignalContribution[];
  /** The cheapest set of signals that would move the label, and where to. */
  flip: FlipPlan | null;
  history: { date: string; score100: number | null; label: string; rawLabel: string }[];
  informational: { dxy: number | null; tnx: number | null; oil: number | null; stoxx: number | null; nikkei: number | null };
  sectorMap: SectorMapRow[];
};

/** ETF → the GICS sector label risk-analytics uses (best-effort join). */
const ETF_TO_SECTOR: Record<string, string[]> = {
  XLK: ["Technology", "Information Technology"],
  XLF: ["Financials", "Financial Services"],
  XLV: ["Health Care", "Healthcare"],
  XLY: ["Consumer Discretionary", "Consumer Cyclical"],
  XLP: ["Consumer Staples", "Consumer Defensive"],
  XLI: ["Industrials"],
  XLE: ["Energy"],
  XLB: ["Materials", "Basic Materials"],
  XLC: ["Communication Services"],
  XLU: ["Utilities"],
  XLRE: ["Real Estate"],
};

export async function buildRegimeSection(drivers: MarketDrivers | null): Promise<RegimeSection> {
  const [regime, history, risk] = await Promise.all([
    readRegimeCache().catch(() => null as MarketRegimeData | null),
    readRegimeHistory().catch(() => []),
    readRiskAnalytics().catch(() => null),
  ]);

  let transition: RegimeTransition | null = null;
  if (regime?.composite) {
    try {
      transition = computeRegimeTransition(regime);
    } catch {
      transition = null;
    }
  }

  const horizons = regime?.horizons
    ? HORIZONS.map((h) => {
        const b = regime.horizons!.byHorizon[h.id];
        return { id: h.id, label: h.label, shortLabel: h.shortLabel, weight: h.weight, score: isFinite(b.score) ? parseFloat(b.score.toFixed(2)) : null, label_: b.label_, riskOn: b.riskOn, riskOff: b.riskOff, total: b.total };
      })
    : [];

  const contributions = regime?.horizons ? signalContributions(regime.horizons) : [];
  // Where could it go from here? From Neutral, whichever pole is cheaper;
  // from a committed pole, the step back to Neutral.
  let flip: FlipPlan | null = null;
  if (regime?.horizons) {
    const label = regime.horizons.weightedLabel;
    if (label === "Neutral") {
      const on = flipCandidates(regime.horizons, "Risk-On");
      const off = flipCandidates(regime.horizons, "Risk-Off");
      flip = !on ? off : !off ? on : on.count <= off.count ? on : off;
    } else {
      flip = flipCandidates(regime.horizons, "Neutral");
    }
  }

  const sectorWeight = new Map<string, { weight: number; sp: number | null }>();
  for (const s of risk?.sectors ?? []) sectorWeight.set(s.sector.toLowerCase(), { weight: s.weight, sp: s.spWeight });

  const sectorMap: SectorMapRow[] = (drivers?.etfs ?? [])
    .filter((e) => e.kind !== "benchmark")
    .map((e) => {
      let bw: number | null = null;
      let sp: number | null = null;
      for (const name of ETF_TO_SECTOR[e.symbol] ?? []) {
        const hit = sectorWeight.get(name.toLowerCase());
        if (hit) {
          bw = parseFloat((hit.weight * 100).toFixed(1));
          sp = hit.sp == null ? null : parseFloat((hit.sp * 100).toFixed(1));
          break;
        }
      }
      return {
        symbol: e.symbol,
        label: e.label,
        kind: e.kind as "sector" | "industry",
        ret1d: e.ret1d,
        ret1w: e.ret1w,
        ret1m: e.ret1m,
        ret3m: e.ret3m,
        bookWeightPct: bw,
        spWeightPct: sp,
        activePct: bw != null && sp != null ? parseFloat((bw - sp).toFixed(1)) : null,
      };
    });

  return {
    available: Boolean(regime?.composite),
    computedAt: regime?.computedAt ?? null,
    composite: regime?.composite ?? null,
    horizons,
    transition,
    contributions,
    flip,
    history: history.slice(-30).map((r) => ({ date: r.date, score100: r.score100, label: r.label, rawLabel: r.rawLabel })),
    informational: {
      dxy: regime?.crossAsset?.dxy?.change20dPct ?? null,
      tnx: regime?.crossAsset?.tnx?.price ?? null,
      oil: regime?.crossAsset?.oil?.change20dPct ?? null,
      stoxx: regime?.global?.stoxx?.change20dPct ?? null,
      nikkei: regime?.global?.nikkei?.change20dPct ?? null,
    },
    sectorMap,
  };
}
