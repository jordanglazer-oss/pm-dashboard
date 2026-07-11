/**
 * Performance Attribution — Phase 04 of the forward-looking roadmap
 * (docs/forward-looking-roadmap.md).
 *
 * Turns a single return number into a decomposition of WHERE it came from:
 *   Total return  =  Market (beta)  +  Currency (USD/CAD)  +  Selection (alpha)
 *
 * Everything here is a PURE function over already-sourced series/scalars — the
 * route layer reads Redis and calls Yahoo, then hands the numbers in. All
 * figures are in PERCENT (8.3 = 8.3%).
 *
 * HONESTY NOTES (surfaced on the UI too):
 *  - "Market" is a beta-based estimate: portfolioBeta × benchmarkReturn. It's
 *    the classic CAPM split, not a holdings-level regression.
 *  - "Currency" is a first-order estimate: USD-sleeve weight × USD/CAD move.
 *    It assumes the CAD-denominated portfolio return already bakes in FX (it
 *    does — daily values are standardised to CAD).
 *  - "Selection" is the residual (total − market − currency) = what name
 *    picking added beyond market + currency. It varies by benchmark.
 * Full Brinson allocation/selection-by-sector is deferred until we store
 * per-holding price history (needs per-sector portfolio + benchmark returns).
 */

export type PeriodKey = "MTD" | "QTD" | "YTD" | "1Y";

export const PERIODS: PeriodKey[] = ["MTD", "QTD", "YTD", "1Y"];

export type ValuePoint = { date: string; value: number };

export type BenchmarkDecomp = {
  label: string; // "S&P 500" | "S&P/TSX Composite"
  benchmarkReturnPct: number | null;
  marketContributionPct: number | null; // beta × benchmark
  selectionPct: number | null; // residual = total − market − currency
};

export type ReturnDecomposition = {
  period: PeriodKey;
  profile: string;
  portfolioReturnPct: number | null;
  portfolioBeta: number;
  usdSleeveWeightPct: number; // 0..100
  usdcadReturnPct: number | null;
  currencyContributionPct: number | null; // usdSleeveWeight × usdcad move
  benchmarks: BenchmarkDecomp[];
};

/** First calendar day of the period, as YYYY-MM-DD, given a reference date. */
export function periodStartDate(period: PeriodKey, ref: Date): string {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth(); // 0-11
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  switch (period) {
    case "MTD":
      return iso(new Date(Date.UTC(y, m, 1)));
    case "QTD": {
      const qStartMonth = Math.floor(m / 3) * 3;
      return iso(new Date(Date.UTC(y, qStartMonth, 1)));
    }
    case "YTD":
      return iso(new Date(Date.UTC(y, 0, 1)));
    case "1Y":
      return iso(new Date(Date.UTC(y - 1, m, ref.getUTCDate())));
  }
}

/** The value at or immediately before `targetDate` in a date-sorted series. */
export function valueOnOrBefore(series: ValuePoint[], targetDate: string): number | null {
  let chosen: number | null = null;
  for (const p of series) {
    if (!p || typeof p.value !== "number" || !isFinite(p.value)) continue;
    if (p.date <= targetDate) chosen = p.value;
    else break; // series is ascending; past the target
  }
  return chosen;
}

/** Latest finite value in a date-sorted series. */
export function latestValue(series: ValuePoint[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    if (p && typeof p.value === "number" && isFinite(p.value)) return p.value;
  }
  return null;
}

/**
 * % return over a period for a cumulative series. Baseline = the value on or
 * before the period start (for YTD that's the prior year-end print). Returns
 * null when the series doesn't reach back far enough.
 */
export function returnOverPeriod(series: ValuePoint[], period: PeriodKey, ref: Date): number | null {
  if (!series || series.length < 2) return null;
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const start = periodStartDate(period, ref);
  const base = valueOnOrBefore(sorted, start);
  const end = latestValue(sorted);
  if (base == null || end == null || base === 0) return null;
  return (end / base - 1) * 100;
}

/** Pure decomposition. All inputs/outputs in percent. */
export function decompose(input: {
  period: PeriodKey;
  profile: string;
  portfolioReturnPct: number | null;
  portfolioBeta: number;
  usdSleeveWeightPct: number; // 0..100
  usdcadReturnPct: number | null;
  benchmarks: { label: string; returnPct: number | null }[];
}): ReturnDecomposition {
  const total = input.portfolioReturnPct;
  const currency =
    input.usdcadReturnPct == null ? null : (input.usdSleeveWeightPct / 100) * input.usdcadReturnPct;

  const benchmarks: BenchmarkDecomp[] = input.benchmarks.map((b) => {
    const market = b.returnPct == null ? null : input.portfolioBeta * b.returnPct;
    const selection =
      total == null || market == null || currency == null ? null : total - market - currency;
    return {
      label: b.label,
      benchmarkReturnPct: b.returnPct,
      marketContributionPct: market,
      selectionPct: selection,
    };
  });

  return {
    period: input.period,
    profile: input.profile,
    portfolioReturnPct: total,
    portfolioBeta: input.portfolioBeta,
    usdSleeveWeightPct: input.usdSleeveWeightPct,
    usdcadReturnPct: input.usdcadReturnPct,
    currencyContributionPct: currency,
    benchmarks,
  };
}

/**
 * Cost-basis contribution breakdown (view 2) — pure. Since-purchase, not
 * period-bounded (that's what the stored cost basis supports cleanly).
 */
export type HoldingContribution = {
  ticker: string;
  sector: string;
  currency: "CAD" | "USD";
  weightPct: number; // share of portfolio market value (CAD)
  returnPct: number; // (price − cost) / cost, native currency
  contributionPct: number; // weight × return
};

export type ContributionBreakdown = {
  holdings: HoldingContribution[]; // sorted by contribution desc
  bySector: { key: string; contributionPct: number }[];
  byCurrency: { key: "CAD" | "USD"; contributionPct: number }[];
  totalContributionPct: number;
};

export function computeContributions(
  rows: Array<{
    ticker: string;
    sector: string;
    currency: "CAD" | "USD";
    marketValueCad: number; // current value in CAD (for weighting)
    costBasisNative: number; // avg cost/unit, native currency
    priceNative: number; // current price, native currency
  }>,
): ContributionBreakdown {
  const totalMv = rows.reduce((s, r) => s + (isFinite(r.marketValueCad) ? r.marketValueCad : 0), 0);
  const holdings: HoldingContribution[] = [];
  for (const r of rows) {
    if (!isFinite(r.costBasisNative) || r.costBasisNative <= 0 || !isFinite(r.priceNative)) continue;
    if (totalMv <= 0) continue;
    const weightPct = (r.marketValueCad / totalMv) * 100;
    const returnPct = (r.priceNative / r.costBasisNative - 1) * 100;
    holdings.push({
      ticker: r.ticker,
      sector: r.sector || "Unclassified",
      currency: r.currency,
      weightPct,
      returnPct,
      contributionPct: (weightPct / 100) * returnPct,
    });
  }
  holdings.sort((a, b) => b.contributionPct - a.contributionPct);

  const sectorMap = new Map<string, number>();
  const currencyMap = new Map<"CAD" | "USD", number>();
  let total = 0;
  for (const h of holdings) {
    sectorMap.set(h.sector, (sectorMap.get(h.sector) ?? 0) + h.contributionPct);
    currencyMap.set(h.currency, (currencyMap.get(h.currency) ?? 0) + h.contributionPct);
    total += h.contributionPct;
  }
  return {
    holdings,
    bySector: [...sectorMap.entries()]
      .map(([key, contributionPct]) => ({ key, contributionPct }))
      .sort((a, b) => b.contributionPct - a.contributionPct),
    byCurrency: [...currencyMap.entries()].map(([key, contributionPct]) => ({ key, contributionPct })),
    totalContributionPct: total,
  };
}
