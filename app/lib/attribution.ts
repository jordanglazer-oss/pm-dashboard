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

/**
 * The value strictly before `targetDate` in a date-sorted series. This is the
 * correct BASELINE for a calendar period: MTD measures from the prior
 * month-end close, so if the 1st is a trading day its move belongs IN the
 * period — `valueOnOrBefore` would silently drop day one.
 */
export function valueBefore(series: ValuePoint[], targetDate: string): number | null {
  let chosen: number | null = null;
  for (const p of series) {
    if (!p || typeof p.value !== "number" || !isFinite(p.value)) continue;
    if (p.date < targetDate) chosen = p.value;
    else break; // series is ascending; at/past the target
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
 * % return over a period for a cumulative series. Baseline = the last value
 * strictly before the period start (for YTD that's the prior year-end print;
 * for MTD the prior month-end close, so day one's move counts). Returns
 * null when the series doesn't reach back far enough.
 */
export function returnOverPeriod(series: ValuePoint[], period: PeriodKey, ref: Date): number | null {
  if (!series || series.length < 2) return null;
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const start = periodStartDate(period, ref);
  const base = valueBefore(sorted, start);
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
 * Period contribution breakdown (view 2) — pure. Each row's return is measured
 * from its baseline price (the period-start close, or — when the position was
 * initiated mid-period — the actual purchase) to the current price, so a name
 * only contributes for the time it was actually owned.
 */
export type HoldingContribution = {
  ticker: string;
  sector: string;
  currency: "CAD" | "USD";
  weightPct: number; // share of portfolio market value incl. cash (CAD)
  returnPct: number; // (price − baseline) / baseline, both CAD
  contributionPct: number; // weight × return
  /** YYYY-MM-DD when the measurement window starts at a mid-period purchase
   *  instead of the period start (position initiated during the period). */
  ownedSince?: string;
  /** YYYY-MM-DD when the position was fully exited during the period. The
   *  window ends at the sale (at the sale price) and the weight is an
   *  ESTIMATE from the model weight recorded on the sell transaction. */
  soldOn?: string;
};

export type ContributionBreakdown = {
  holdings: HoldingContribution[]; // sorted by contribution desc
  bySector: { key: string; contributionPct: number }[];
  byCurrency: { key: "CAD" | "USD"; contributionPct: number }[];
  totalContributionPct: number;
  /** Positions that couldn't be priced for this period (no match / no
   *  history / no live price) and are missing from `holdings`. */
  excludedCount?: number;
};

export function computeContributions(
  rows: Array<{
    ticker: string;
    sector: string;
    currency: "CAD" | "USD";
    marketValueCad: number; // current value in CAD (for weighting)
    // Baseline and current price must BOTH be in CAD — otherwise a USD name's
    // return is corrupted by the FX gap.
    costBasisCad: number; // baseline price/unit, CAD (period start or purchase)
    priceCad: number; // current price/unit, CAD (or sale price for sold rows)
    ownedSince?: string;
    soldOn?: string;
    /** For SOLD rows (no current market value): use this weight directly
     *  instead of deriving it from marketValueCad / total. */
    fixedWeightPct?: number;
  }>,
  opts?: {
    /** Cash sitting in the accounts (CAD). Included in the weighting
     *  denominator so holdings aren't overstated; contributes 0 itself. */
    cashCad?: number;
    excludedCount?: number;
  },
): ContributionBreakdown {
  const cash = isFinite(opts?.cashCad ?? NaN) && (opts?.cashCad ?? 0) > 0 ? (opts!.cashCad as number) : 0;
  const totalMv =
    rows.reduce(
      (s, r) => s + (r.fixedWeightPct == null && isFinite(r.marketValueCad) ? r.marketValueCad : 0),
      0,
    ) + cash;
  const holdings: HoldingContribution[] = [];
  for (const r of rows) {
    if (!isFinite(r.costBasisCad) || r.costBasisCad <= 0 || !isFinite(r.priceCad)) continue;
    const weightPct =
      r.fixedWeightPct != null
        ? r.fixedWeightPct
        : totalMv > 0
          ? (r.marketValueCad / totalMv) * 100
          : NaN;
    if (!isFinite(weightPct)) continue;
    const returnPct = (r.priceCad / r.costBasisCad - 1) * 100;
    holdings.push({
      ticker: r.ticker,
      sector: r.sector || "Unclassified",
      currency: r.currency,
      weightPct,
      returnPct,
      contributionPct: (weightPct / 100) * returnPct,
      ...(r.ownedSince ? { ownedSince: r.ownedSince } : {}),
      ...(r.soldOn ? { soldOn: r.soldOn } : {}),
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
    ...(opts?.excludedCount != null ? { excludedCount: opts.excludedCount } : {}),
  };
}
