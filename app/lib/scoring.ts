import type { Stock, ScoredStock, MarketData, ScoreKey } from "./types";
import { MAX_SCORE, SCORE_GROUPS } from "./types";

// Sector behavioral clusters for regime scoring.
//
// GROWTH: High-duration, multiple-expansion sectors that lead in risk-on
// and get hit hardest in risk-off. Sensitive to rates and liquidity.
const GROWTH_SECTORS = [
  "Technology",
  "Communication Services",
  "Consumer Discretionary",
];

// CYCLICAL: Economically sensitive sectors that benefit from expansion
// but suffer in contraction. Less rate-sensitive than growth, more tied
// to real economic activity, capex, and credit cycles.
const CYCLICAL_SECTORS = [
  "Financials",
  "Industrials",
  "Materials",
  "Energy",
];

// DEFENSIVE: Low-beta, income-oriented sectors that outperform in
// drawdowns and underperform in rallies. True safe havens.
const DEFENSIVE_SECTORS = [
  "Utilities",
  "Consumer Staples",
  "Health Care",
];

// NEUTRAL: Real Estate is rate-sensitive in both directions — benefits
// from falling rates but suffers from rising rates regardless of regime.
// No regime tilt applied (1.0x always).

/**
 * Regime multiplier system — three-tier sector model:
 *
 * Risk-Off (bearish macro):
 *   Growth   (Tech, Comm Svc, Consumer Disc) → 0.82x (penalized — drawdown leaders)
 *   Cyclical (Financials, Industrials, Materials, Energy) → 0.90x (penalized — economic sensitivity)
 *   Defensive (Utilities, Staples, Health Care) → 1.10x (boosted — capital preservation)
 *
 * Neutral (mixed/uncertain macro):
 *   Growth   → 0.95x (slight headwind)
 *   Cyclical → 0.97x (marginal headwind)
 *   Defensive → 1.03x (slight tailwind)
 *
 * Risk-On (bullish macro):
 *   Growth   → 1.10x (boosted — momentum/multiple expansion favored)
 *   Cyclical → 1.05x (boosted — economic activity tailwind)
 *   Defensive → 0.95x (slight headwind — safety less rewarded)
 */
export function regimeMultiplier(sector: string, riskRegime: string): number {
  if (riskRegime === "Risk-Off") {
    if (DEFENSIVE_SECTORS.includes(sector)) return 1.1;
    if (GROWTH_SECTORS.includes(sector)) return 0.82;
    if (CYCLICAL_SECTORS.includes(sector)) return 0.90;
    return 1;
  }
  if (riskRegime === "Neutral") {
    if (DEFENSIVE_SECTORS.includes(sector)) return 1.03;
    if (GROWTH_SECTORS.includes(sector)) return 0.95;
    if (CYCLICAL_SECTORS.includes(sector)) return 0.97;
    return 1;
  }
  // Risk-On
  if (GROWTH_SECTORS.includes(sector)) return 1.1;
  if (CYCLICAL_SECTORS.includes(sector)) return 1.05;
  if (DEFENSIVE_SECTORS.includes(sector)) return 0.95;
  return 1;
}

// Legacy aliases for backward compatibility
const OFFENSIVE_SECTORS = GROWTH_SECTORS;

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
  if (DEFENSIVE_SECTORS.includes(stock.sector)) risk = "Low";

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
