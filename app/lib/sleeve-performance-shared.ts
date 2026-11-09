/** Client-safe names + types for the weights-based sleeve series
 *  (the store and updater live in sleeve-performance.ts, server-only). */

export const SLEEVES = ["core", "thematic", "stocks", "nonCore"] as const;
export type SleeveId = (typeof SLEEVES)[number];
export const SLEEVE_LABELS: Record<SleeveId, string> = { core: "Core", thematic: "Thematic funds", stocks: "Stocks (Alpha)", nonCore: "Stocks + Thematic" };

export type SleevePoint = { date: string; value: number; dailyReturn: number };
export type SleeveSeries = { history: SleevePoint[]; weights: Record<string, number>; targetsKey: string };
export type SleeveEvent = { date: string; sleeve: SleeveId; note: string };
export type SleevePerformance = {
  startedAt: string;
  lastDate: string;
  series: Record<SleeveId, SleeveSeries>;
  events: SleeveEvent[];
  updatedAt: string;
};

