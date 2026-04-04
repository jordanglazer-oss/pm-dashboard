import type { Stock, ScoredStock, MarketData, ScoreKey } from "./types";
import { MAX_SCORE, SCORE_GROUPS } from "./types";

const OFFENSIVE_SECTORS = [
  "Technology",
  "Communication Services",
  "Consumer Discretionary",
];

const DEFENSIVE_SECTORS = [
  "Energy",
  "Utilities",
  "Consumer Staples",
  "Financials",
  "Materials",
  "Industrials",
];

/**
 * Regime multiplier system:
 *
 * Risk-Off (bearish macro):
 *   Offensive sectors (Tech, Comm Svc, Consumer Disc) → 0.82x (penalized)
 *   Defensive sectors (Energy, Utilities, Staples, Financials, Materials, Industrials) → 1.10x (boosted)
 *
 * Neutral (mixed/uncertain macro):
 *   Offensive sectors → 0.95x (slight headwind)
 *   Defensive sectors → 1.03x (slight tailwind)
 *
 * Risk-On (bullish macro):
 *   Offensive sectors → 1.10x (boosted — growth/momentum favored)
 *   Defensive sectors → 0.95x (slight headwind — less need for safety)
 */
export function regimeMultiplier(sector: string, riskRegime: string): number {
  if (riskRegime === "Risk-Off") {
    if (DEFENSIVE_SECTORS.includes(sector)) return 1.1;
    if (OFFENSIVE_SECTORS.includes(sector)) return 0.82;
    return 1;
  }
  if (riskRegime === "Neutral") {
    if (DEFENSIVE_SECTORS.includes(sector)) return 1.03;
    if (OFFENSIVE_SECTORS.includes(sector)) return 0.95;
    return 1;
  }
  // Risk-On
  if (OFFENSIVE_SECTORS.includes(sector)) return 1.1;
  if (DEFENSIVE_SECTORS.includes(sector)) return 0.95;
  return 1;
}

export function computeScores(
  stock: Stock,
  marketData: MarketData
): ScoredStock {
  const raw = (Object.keys(stock.scores) as ScoreKey[]).reduce(
    (sum, key) => sum + (stock.scores[key] || 0),
    0
  );

  const multiplier = regimeMultiplier(stock.sector, marketData.riskRegime);
  const adjusted = Math.round(raw * multiplier * 10) / 10;

  let rating: "Buy" | "Hold" | "Sell" = "Hold";
  if (adjusted >= 30) rating = "Buy";
  else if (adjusted <= 18) rating = "Sell";

  let ratingLabel = "Hold";
  if (adjusted >= 30) ratingLabel = "Strong Buy";
  else if (adjusted >= 26) ratingLabel = "Moderate Buy";
  else if (adjusted >= 22) ratingLabel = "Hold";
  else if (adjusted >= 18) ratingLabel = "Underweight";
  else ratingLabel = "Sell";

  let risk: "High" | "Medium" | "Low" = "Medium";
  if (marketData.riskRegime === "Risk-Off" && stock.beta >= 1.15)
    risk = "High";
  if (["Utilities", "Consumer Staples"].includes(stock.sector)) risk = "Low";

  return { ...stock, raw, adjusted, rating, ratingLabel, risk };
}

export function isOffensiveSector(sector: string): boolean {
  return OFFENSIVE_SECTORS.includes(sector);
}

/** Returns true if the instrument can be scored (individual stocks only, not ETFs/funds) */
export function isScoreable(stock: Stock): boolean {
  return !stock.instrumentType || stock.instrumentType === "stock";
}

export function groupTotal(stock: Stock, group: typeof SCORE_GROUPS[number]): number {
  return group.categories.reduce(
    (sum, cat) => sum + (stock.scores[cat.key as ScoreKey] || 0),
    0
  );
}
