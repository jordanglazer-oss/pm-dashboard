/**
 * Signal grid settings (Nov 26 2026 team session) — THE ONE PLACE the team
 * tunes. Every threshold and metric list used by the Holdings and Ideas
 * signal grid is here; nothing is hard-coded in the calculation or the page.
 *
 * All values are PLACEHOLDERS until the team confirms them (see
 * docs/background-systems-record.md). Changing a number here changes the
 * Positive / Neutral / Negative shown, nothing else: the grid is read-only,
 * stores nothing, and never feeds a score, a weight or a trade.
 */

export const SIGNAL_CONFIG = {
  /** Upside to the average street target. */
  upside: { positiveAbovePct: 10, negativeBelowPct: 0 },

  /** Analyst consensus: 30-day estimate revisions, net (up − down) as a share of the analyst count. */
  analyst: { positiveAboveShare: 0.1, negativeBelowShare: -0.1, minAnalysts: 3 },

  /** Relative strength: SIA SMAX, 0 to 10. */
  relStrength: { positiveAtOrAbove: 7, negativeAtOrBelow: 3 },

  /**
   * Fundamentals: each metric reads positive / negative / neutral on its own;
   * the signal is positive when (positives − negatives) ≥ `netForPositive`,
   * negative when ≤ `netForNegative`, and "source pending" when fewer than
   * `minMetrics` have data. `better` says which direction is good.
   */
  fundamentals: {
    minMetrics: 3,
    netForPositive: 2,
    netForNegative: -2,
    metrics: [
      { id: "peVsOwn5y", label: "Forward P/E vs own 5-year average", better: "lower", positive: -10, negative: 10, unit: "% vs avg" },
      { id: "evEbitdaVsOwn5y", label: "EV/EBITDA vs own 5-year average", better: "lower", positive: -10, negative: 10, unit: "% vs avg" },
      { id: "peg", label: "PEG ratio", better: "lower", positive: 1.5, negative: 3, unit: "x" },
      { id: "fcfMargin", label: "Free cash flow margin", better: "higher", positive: 10, negative: 0, unit: "%" },
      { id: "roic", label: "Return on invested capital", better: "higher", positive: 12, negative: 6, unit: "%" },
      { id: "revenueGrowth", label: "Revenue growth", better: "higher", positive: 8, negative: 0, unit: "%" },
      // No source on file yet — shown as "source pending", never guessed.
      { id: "peVsMarket", label: "P/E vs the market", better: "lower", positive: -10, negative: 10, unit: "% vs market", pending: true },
      { id: "peVsIndustry", label: "P/E vs the industry", better: "lower", positive: -10, negative: 10, unit: "% vs industry", pending: true },
      { id: "interestCoverage", label: "Interest coverage", better: "higher", positive: 6, negative: 2, unit: "x", pending: true },
      { id: "leverage", label: "Net debt / EBITDA", better: "lower", positive: 1.5, negative: 3.5, unit: "x", pending: true },
    ],
  },

  /** Technicals: same counting rule as fundamentals. */
  technicals: {
    minChecks: 3,
    netForPositive: 2,
    netForNegative: -2,
    rsi: { overbought: 70, oversold: 30 },
    /** Distance below the 52-week high, in %. */
    high52: { positiveWithinPct: 10, negativeBeyondPct: 25 },
    /** MarketEdge opinion. */
    marketEdge: { positive: "long", negative: "avoid" },
    /** On-balance volume: no source on file yet. */
    obvPending: true,
  },

  /** Ideas: a name off every source list for this many days leaves the active view (unless pinned). */
  ideas: { dropAfterDays: 90 },
} as const;

export type SignalConfig = typeof SIGNAL_CONFIG;
