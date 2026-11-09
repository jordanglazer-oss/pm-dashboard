/** Client-safe types for per-holding history (built server-side in holding-history.ts). */

export type HoldingDecision = {
  date: string;
  kind: "bought" | "raised target" | "cut target" | "rebalanced" | "sold out";
  direction: "buy" | "sell";
  /** Recorded fill price (native currency); null for a pending fund trade. */
  price: number | null;
  /** Model target at the time (the All-Equity profile's weight = weight in equity, when present). */
  target: number | null;
  pending: boolean;
  notes?: string;
  /** Price return from this fill to today. */
  sincePricePct: number | null;
  /** Total return incl. dividends from this date's close to today. */
  sinceTotalPct: number | null;
};

export type HoldingHistory = {
  symbol: string;
  name?: string;
  held: boolean;
  /** Weight in the equity / fixed-income class today (0-1). */
  currentWeight: number | null;
  assetClass?: string;
  firstDate: string;
  /** false = no buy on file; the start is the group's tracking start. */
  firstFromLog: boolean;
  firstPrice: number | null;
  price: number | null;
  /** From the first fill to today (or to the exit fill for a name sold out). */
  sinceFirstPricePct: number | null;
  sinceFirstTotalPct: number | null;
  exitDate: string | null;
  decisions: HoldingDecision[];
};
