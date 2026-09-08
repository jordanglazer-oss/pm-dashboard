/**
 * Server loader for the ranked research table (stage 1 of the funnel).
 * Reads pm:research + pm:stocks READ-ONLY and hands them to the pure ranker.
 * Used by the Suggested Watchlist refresh and the Synthesis screen so every
 * stage ranks the same way the Research page displays.
 */

import { getRedis } from "./redis";
import { rankResearch, type RankedRow, type HeldStockLike } from "./research-ranked";
import type { ResearchState } from "./defaults";

export async function loadRankedResearch(): Promise<{ rows: RankedRow[]; stocks: HeldStockLike[] }> {
  const redis = await getRedis();
  const [researchRaw, stocksRaw] = await Promise.all([redis.get("pm:research"), redis.get("pm:stocks")]);
  let research: Partial<ResearchState> = {};
  let stocks: HeldStockLike[] = [];
  try {
    if (researchRaw) research = JSON.parse(researchRaw) as Partial<ResearchState>;
  } catch {
    research = {};
  }
  try {
    const parsed = stocksRaw ? JSON.parse(stocksRaw) : [];
    stocks = Array.isArray(parsed) ? (parsed as HeldStockLike[]) : [];
  } catch {
    stocks = [];
  }
  return { rows: rankResearch(research, stocks), stocks };
}
