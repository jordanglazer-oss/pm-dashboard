/** Client-safe names + types for the weights-based sleeve series
 *  (the store and updater live in sleeve-performance.ts, server-only). */

export const SLEEVES = ["core", "thematic", "stocks", "nonCore"] as const;
export type SleeveId = (typeof SLEEVES)[number];
export const SLEEVE_LABELS: Record<SleeveId, string> = { core: "Core", thematic: "Thematic funds", stocks: "Stocks (Alpha)", nonCore: "Stocks + Thematic" };

export type SleevePoint = { date: string; value: number; dailyReturn: number };
export type SleeveSeries = {
  history: SleevePoint[];
  weights: Record<string, number>;
  targetsKey: string;
  /** Set when the history before `startedAt` was filled from an existing
   *  pm:pim-performance series (rescaled to meet this series at startedAt). */
  backfilledFrom?: { source: string; firstDate: string; lastDate: string; points: number; at: string };
};

/** Which existing ledger series fills each sleeve's past (Stocks + Thematic has none). */
export const BACKFILL_SOURCES: Partial<Record<SleeveId, { profile: string; label: string }>> = {
  core: { profile: "core", label: "Core series" },
  thematic: { profile: "thematic", label: "Thematic series" },
  stocks: { profile: "alpha", label: "Alpha series (units book — stocks only)" },
};
export type SleeveEvent = { date: string; sleeve: SleeveId; note: string };
export type SleevePerformance = {
  startedAt: string;
  lastDate: string;
  series: Record<SleeveId, SleeveSeries>;
  events: SleeveEvent[];
  updatedAt: string;
};

