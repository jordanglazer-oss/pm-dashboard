/**
 * Market Regime — unified risk-on / risk-off snapshot.
 *
 * Computes a handful of well-known regime signals from Yahoo Finance
 * daily/monthly bars and rolls them into a single composite label.
 *
 * Signals (each either "risk-on", "risk-off", or "neutral"):
 *
 *   1. SPX 10-month trend — monthly close vs 10-month SMA.
 *      Paul Tudor Jones / Meb Faber classic trend filter.
 *
 *   2. Breadth proxy — RSP/SPY ratio 20-day change.
 *      Rising = equal-weighted index keeping up with cap-weighted =
 *      broad participation. Falling = mega-cap narrowness.
 *
 *   3. Sector ratio: XLY/XLP (consumer discretionary / staples).
 *      Above 50D SMA of the ratio = offensive bias.
 *
 *   4. Sector ratio: XLK/XLU (tech / utilities).
 *      Above 50D SMA = growth/risk appetite.
 *
 *   5. Sector ratio: MTUM/USMV (momentum / low-vol).
 *      Above 50D SMA = momentum in control.
 *
 *   6. VIX level — < 20 risk-on, > 25 risk-off, else neutral.
 *
 * Cross-asset (DXY, 10Y, Oil) and global (^STOXX, ^N225) are included
 * as informational context but do not currently feed the composite
 * score — they are surfaced for the brief + dashboard to render.
 *
 * All state is computed from Yahoo on demand; no manual inputs. The
 * API route caches the last successful compute in `pm:market-regime`
 * so repeated page loads don't re-fetch.
 */

import type { OHLCVBar } from "./technicals";
import { computeSMA, resampleToMonthly } from "./technicals";

// ── Public types ──────────────────────────────────────────────────

export type RegimeDirection = "risk-on" | "risk-off" | "neutral";

export type TrendReadout = {
  price: number;
  ma: number;
  distancePct: number;
  direction: RegimeDirection;
};

export type RatioReadout = {
  ratio: number;
  sma50: number;
  distancePct: number; // ratio vs 50D SMA
  change20dPct: number; // pct change of the ratio over last 20 trading days
  direction: RegimeDirection;
};

export type CrossAssetReadout = {
  symbol: string;
  price: number;
  change1dPct: number | null;
  change20dPct: number | null;
};

export type VixReadout = CrossAssetReadout & {
  direction: RegimeDirection; // <20 risk-on, >25 risk-off
};

export type MarketRegimeData = {
  computedAt: string; // ISO timestamp of when this snapshot was computed
  spx10m: TrendReadout | null;
  breadth: RatioReadout | null; // RSP/SPY
  sectorRatios: {
    xlyXlp: RatioReadout | null;
    xlkXlu: RatioReadout | null;
    mtumUsmv: RatioReadout | null;
  };
  crossAsset: {
    vix: VixReadout | null;
    dxy: CrossAssetReadout | null; // US Dollar Index
    tnx: CrossAssetReadout | null; // 10-year yield (^TNX, in %)
    oil: CrossAssetReadout | null; // WTI front-month (CL=F)
  };
  global: {
    stoxx: CrossAssetReadout | null;
    nikkei: CrossAssetReadout | null;
  };
  composite: {
    score: number; // count of risk-on signals (0..6)
    total: number; // total signals evaluated (max 6)
    label: "Risk-On" | "Neutral" | "Risk-Off";
    signals: { name: string; direction: RegimeDirection; detail: string }[];
  };
};

// ── Helpers ──────────────────────────────────────────────────────

function pct(a: number, b: number): number {
  if (!isFinite(a) || !isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function last<T>(arr: readonly T[]): T | null {
  return arr.length > 0 ? arr[arr.length - 1] : null;
}

/** Align two bar series by date and return aligned close arrays. */
function alignByDate(a: readonly OHLCVBar[], b: readonly OHLCVBar[]): { dates: string[]; aCloses: number[]; bCloses: number[] } {
  const bMap = new Map<string, number>();
  for (const bar of b) bMap.set(bar.date, bar.close);
  const dates: string[] = [];
  const aCloses: number[] = [];
  const bCloses: number[] = [];
  for (const bar of a) {
    const bClose = bMap.get(bar.date);
    if (bClose == null || !isFinite(bClose) || bClose <= 0) continue;
    if (!isFinite(bar.close) || bar.close <= 0) continue;
    dates.push(bar.date);
    aCloses.push(bar.close);
    bCloses.push(bClose);
  }
  return { dates, aCloses, bCloses };
}

// ── Signal computation ──────────────────────────────────────────

/**
 * SPX 10-month trend. Expects daily ^GSPC bars spanning at least ~2-3
 * years so monthly resampling yields ≥ 10 closes.
 */
export function computeSpx10mTrend(dailyBars: readonly OHLCVBar[]): TrendReadout | null {
  const monthly = resampleToMonthly(dailyBars);
  if (monthly.length < 10) return null;
  // Use the first 9 *completed* months plus the latest close. Simpler:
  // 10-month SMA of the last 10 monthly closes (includes the current,
  // still-forming month — consistent with how Newton reads it).
  const lastTen = monthly.slice(-10).map((b) => b.close);
  const ma = lastTen.reduce((s, x) => s + x, 0) / 10;
  const priceBar = last(dailyBars);
  if (!priceBar) return null;
  const price = priceBar.close;
  const distancePct = pct(price, ma);
  return {
    price,
    ma,
    distancePct,
    direction: price >= ma ? "risk-on" : "risk-off",
  };
}

/**
 * Ratio signal: compute series of a/b, take last value + 50D SMA +
 * 20-day change. Any of these dimensions failing → null.
 */
export function computeRatioSignal(a: readonly OHLCVBar[], b: readonly OHLCVBar[]): RatioReadout | null {
  const { aCloses, bCloses } = alignByDate(a, b);
  if (aCloses.length < 55) return null;
  const ratios: number[] = [];
  for (let i = 0; i < aCloses.length; i++) {
    const r = aCloses[i] / bCloses[i];
    if (!isFinite(r)) return null;
    ratios.push(r);
  }
  const ratio = ratios[ratios.length - 1];
  const sma50 = computeSMA(ratios, 50);
  const twentyAgo = ratios[ratios.length - 21];
  if (!isFinite(sma50) || !isFinite(twentyAgo)) return null;
  const distancePct = pct(ratio, sma50);
  const change20dPct = pct(ratio, twentyAgo);
  // Direction: above 50D SMA AND expanding (20d) → risk-on.
  // Below SMA AND contracting → risk-off. Otherwise neutral.
  let direction: RegimeDirection = "neutral";
  if (distancePct >= 0 && change20dPct >= 0) direction = "risk-on";
  else if (distancePct < 0 && change20dPct < 0) direction = "risk-off";
  return { ratio, sma50, distancePct, change20dPct, direction };
}

/**
 * Cross-asset readout — spot + 1d and 20d changes from daily bars.
 */
export function computeCrossAssetReadout(symbol: string, bars: readonly OHLCVBar[]): CrossAssetReadout | null {
  if (bars.length < 2) return null;
  const latest = bars[bars.length - 1];
  const prior = bars[bars.length - 2];
  const twentyAgo = bars.length >= 22 ? bars[bars.length - 22] : null;
  return {
    symbol,
    price: latest.close,
    change1dPct: isFinite(prior.close) && prior.close > 0 ? pct(latest.close, prior.close) : null,
    change20dPct: twentyAgo && isFinite(twentyAgo.close) && twentyAgo.close > 0 ? pct(latest.close, twentyAgo.close) : null,
  };
}

export function vixReadout(bars: readonly OHLCVBar[]): VixReadout | null {
  const base = computeCrossAssetReadout("^VIX", bars);
  if (!base) return null;
  let direction: RegimeDirection = "neutral";
  if (base.price < 20) direction = "risk-on";
  else if (base.price > 25) direction = "risk-off";
  return { ...base, direction };
}

// ── Composite ───────────────────────────────────────────────────

export function composeRegime(parts: Omit<MarketRegimeData, "computedAt" | "composite">): MarketRegimeData["composite"] {
  const signals: { name: string; direction: RegimeDirection; detail: string }[] = [];

  if (parts.spx10m) {
    signals.push({
      name: "SPX 10-Month Trend",
      direction: parts.spx10m.direction,
      detail: `${parts.spx10m.distancePct >= 0 ? "+" : ""}${parts.spx10m.distancePct.toFixed(1)}% vs 10M MA`,
    });
  }
  if (parts.breadth) {
    signals.push({
      name: "Breadth (RSP/SPY)",
      direction: parts.breadth.direction,
      detail: `20d ${parts.breadth.change20dPct >= 0 ? "+" : ""}${parts.breadth.change20dPct.toFixed(2)}%`,
    });
  }
  if (parts.sectorRatios.xlyXlp) {
    signals.push({
      name: "XLY/XLP (Discretionary/Staples)",
      direction: parts.sectorRatios.xlyXlp.direction,
      detail: `${parts.sectorRatios.xlyXlp.distancePct >= 0 ? "+" : ""}${parts.sectorRatios.xlyXlp.distancePct.toFixed(1)}% vs 50D`,
    });
  }
  if (parts.sectorRatios.xlkXlu) {
    signals.push({
      name: "XLK/XLU (Tech/Utilities)",
      direction: parts.sectorRatios.xlkXlu.direction,
      detail: `${parts.sectorRatios.xlkXlu.distancePct >= 0 ? "+" : ""}${parts.sectorRatios.xlkXlu.distancePct.toFixed(1)}% vs 50D`,
    });
  }
  if (parts.sectorRatios.mtumUsmv) {
    signals.push({
      name: "MTUM/USMV (Momentum/LowVol)",
      direction: parts.sectorRatios.mtumUsmv.direction,
      detail: `${parts.sectorRatios.mtumUsmv.distancePct >= 0 ? "+" : ""}${parts.sectorRatios.mtumUsmv.distancePct.toFixed(1)}% vs 50D`,
    });
  }
  if (parts.crossAsset.vix) {
    signals.push({
      name: "VIX Level",
      direction: parts.crossAsset.vix.direction,
      detail: `${parts.crossAsset.vix.price.toFixed(1)} (<20 on, >25 off)`,
    });
  }

  const riskOn = signals.filter((s) => s.direction === "risk-on").length;
  const riskOff = signals.filter((s) => s.direction === "risk-off").length;
  const total = signals.length;

  // Label thresholds scale with the number of signals we have:
  //   score ≥ total * 0.66  → Risk-On
  //   risk-off majority     → Risk-Off
  //   otherwise             → Neutral
  let label: "Risk-On" | "Neutral" | "Risk-Off" = "Neutral";
  if (total > 0) {
    if (riskOn >= Math.ceil(total * 0.66)) label = "Risk-On";
    else if (riskOff >= Math.ceil(total * 0.66)) label = "Risk-Off";
    else label = "Neutral";
  }

  return { score: riskOn, total, label, signals };
}
