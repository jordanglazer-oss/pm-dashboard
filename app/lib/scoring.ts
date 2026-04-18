import type { Stock, ScoredStock, MarketData, ScoreKey } from "./types";
import { MAX_SCORE, SCORE_GROUPS } from "./types";

// ── Sector name normalization ──────────────────────────────────────────
// Yahoo Finance, fund data providers, and other sources use non-standard
// sector names. This map normalizes them to GICS standard labels so the
// regime multiplier and sector-based logic applies correctly.
// Canonical GICS labels we collapse everything down to.
//   Technology, Communication Services, Consumer Discretionary,
//   Consumer Staples, Financials, Materials, Health Care, Energy,
//   Utilities, Industrials, Real Estate
//
// Anything not in this map (after case-insensitive lookup) passes through
// unchanged — so a brand-new sector name from a provider would still show up
// in the chart, just not collapsed into one of the canonical buckets.
const SECTOR_ALIASES: Record<string, string> = {
  // ── Technology ────────────────────────────────────────────────────────
  "Information Technology": "Technology",
  "Info Tech": "Technology",
  "Tech": "Technology",
  "Technologies": "Technology",
  "information_technology": "Technology",
  "technology": "Technology",

  // ── Communication Services ────────────────────────────────────────────
  "Telecommunication Services": "Communication Services", // old GICS name
  "Telecom": "Communication Services",
  "Telecommunications": "Communication Services",
  "Telecom Services": "Communication Services",
  "Communication": "Communication Services", // BMO / some provider feeds use the bare label
  "Communications": "Communication Services",
  "Communication Svcs": "Communication Services",
  "Communication Svc": "Communication Services",
  "Commun Svs": "Communication Services", // Morningstar abbreviation
  "Media": "Communication Services",
  "communication_services": "Communication Services",

  // ── Consumer Discretionary ────────────────────────────────────────────
  "Consumer Cyclical": "Consumer Discretionary",
  "Consumer Cyclicals": "Consumer Discretionary",
  "Consumer Cycl": "Consumer Discretionary", // Morningstar abbreviation
  "Cyclical": "Consumer Discretionary",
  "Cons Disc": "Consumer Discretionary",
  "Consumer Services": "Consumer Discretionary",
  "Retail": "Consumer Discretionary",
  "consumer_cyclical": "Consumer Discretionary",
  "consumer_discretionary": "Consumer Discretionary",

  // ── Consumer Staples ──────────────────────────────────────────────────
  "Consumer Defensive": "Consumer Staples",
  "Consumer Def": "Consumer Staples", // Morningstar abbreviation
  "Defensive": "Consumer Staples",
  "Cons Stap": "Consumer Staples",
  "Consumer Goods": "Consumer Staples",
  "Food & Staples Retailing": "Consumer Staples",
  "consumer_defensive": "Consumer Staples",
  "consumer_staples": "Consumer Staples",

  // ── Financials ────────────────────────────────────────────────────────
  "Financial Services": "Financials",
  "Financial Svs": "Financials", // Morningstar abbreviation
  "Financial Svcs": "Financials",
  "Financial": "Financials",
  "Banks": "Financials",
  "Banking": "Financials",
  "Insurance": "Financials",
  "Diversified Financials": "Financials",
  "financial_services": "Financials",
  "financials": "Financials",

  // ── Materials ─────────────────────────────────────────────────────────
  "Basic Materials": "Materials",
  "Basic Matls": "Materials", // Morningstar abbreviation
  "Material": "Materials",
  "Mining": "Materials",
  "Metals & Mining": "Materials",
  "Chemicals": "Materials",
  "basic_materials": "Materials",
  "materials": "Materials",

  // ── Health Care ───────────────────────────────────────────────────────
  "Healthcare": "Health Care",
  "Health": "Health Care",
  "HealthCare": "Health Care",
  "Pharma": "Health Care",
  "Pharmaceuticals": "Health Care",
  "Biotech": "Health Care",
  "Biotechnology": "Health Care",
  "healthcare": "Health Care",
  "health_care": "Health Care",
  "healthCare": "Health Care",

  // ── Energy ────────────────────────────────────────────────────────────
  "Oil & Gas": "Energy",
  "Oil and Gas": "Energy",
  "Oil, Gas & Consumable Fuels": "Energy",
  "energy": "Energy",

  // ── Utilities ─────────────────────────────────────────────────────────
  "Utility": "Utilities",
  "Electric Utilities": "Utilities",
  "utilities": "Utilities",

  // ── Industrials ───────────────────────────────────────────────────────
  "Industrial": "Industrials",
  "Capital Goods": "Industrials",
  "Transportation": "Industrials",
  "industrials": "Industrials",

  // ── Real Estate ───────────────────────────────────────────────────────
  "Real Estate Investment Trusts": "Real Estate",
  "REITs": "Real Estate",
  "REIT": "Real Estate",
  "Equity REITs": "Real Estate",
  "real_estate": "Real Estate",
  "realestate": "Real Estate",
};

// Case-insensitive lookup table built once from SECTOR_ALIASES — lets us
// catch odd casings ("INFORMATION TECHNOLOGY", "information_technology")
// without having to enumerate every variant explicitly.
const SECTOR_ALIASES_CI: Record<string, string> = Object.fromEntries(
  Object.entries(SECTOR_ALIASES).map(([k, v]) => [k.toLowerCase(), v])
);

/** Normalize a sector name to GICS standard (case-insensitive). */
export function normalizeSector(sector: string): string {
  if (!sector) return sector;
  // Exact match wins (preserves any case-sensitive disambiguation).
  if (SECTOR_ALIASES[sector]) return SECTOR_ALIASES[sector];
  // Case-insensitive fallback.
  const ci = SECTOR_ALIASES_CI[sector.toLowerCase()];
  if (ci) return ci;
  return sector;
}

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
];

// DEFENSIVE: Low-beta, income-oriented sectors that outperform in
// drawdowns and underperform in rallies. True safe havens.
const DEFENSIVE_SECTORS = [
  "Utilities",
  "Consumer Staples",
  "Health Care",
];

// NEUTRAL: Always 1.0x — sectors whose drivers don't map cleanly to
// risk-on/risk-off dynamics.
//
// Real Estate is rate-sensitive in both directions — benefits from
// falling rates but suffers from rising rates regardless of regime.
//
// Energy is commodity-price-driven rather than risk-appetite-driven.
// It can rally in Risk-Off (geopolitical supply shocks, inflation
// hedging) and lag in Risk-On (tech/AI-led rallies). The correlation
// with the broader risk-on trade has weakened meaningfully — a blanket
// cyclical classification would penalize Energy in Risk-Off and boost
// it in Risk-On, both of which assume a correlation that isn't reliable.

// ── Quality dampening ──────────────────────────────────────────────────
// Quality score categories used to dampen the regime multiplier.
// These capture whether a business can sustain itself through a cycle:
//   growth (max 3) + leverageCoverage (max 2) + cashFlowQuality (max 1)
//   + competitiveMoat (max 2) = max 8.
// A stock scoring 7-8/8 is high quality; 0-2/8 is low quality.
const QUALITY_KEYS: ScoreKey[] = [
  "growth",
  "leverageCoverage",
  "cashFlowQuality",
  "competitiveMoat",
];
const QUALITY_MAX = 8; // sum of individual maxes: 3 + 2 + 1 + 2

/**
 * Compute a quality factor (0 → 1) from the stock's quality-related scores.
 * 0 = lowest quality (all zeros), 1 = highest quality (all maxed out).
 */
function qualityFactor(scores: Record<string, number> | undefined): number {
  if (!scores) return 0.5; // unknown quality → no adjustment
  const sum = QUALITY_KEYS.reduce((s, k) => s + (scores[k] || 0), 0);
  return sum / QUALITY_MAX; // 0..1
}

/**
 * Regime multiplier system — three-tier sector model with quality dampening.
 *
 * Base multipliers by sector tier and regime:
 *
 * Risk-Off (bearish macro):
 *   Growth   (Tech, Comm Svc, Consumer Disc) → 0.85x base
 *   Cyclical (Financials, Industrials, Materials, Energy) → 0.90x base
 *   Defensive (Utilities, Staples, Health Care) → 1.10x base
 *
 * Neutral (mixed/uncertain macro):
 *   Growth   → 0.98x base
 *   Cyclical → 0.99x base
 *   Defensive → 1.01x base
 *
 *   Neutral means "no strong signal" — multipliers are near 1.0x to avoid
 *   systematically biasing scores toward defensive names when the regime
 *   doesn't call for it. Just enough tilt to stay directionally aware.
 *
 * Risk-On (bullish macro):
 *   Growth   → 1.10x base
 *   Cyclical → 1.05x base
 *   Defensive → 0.92x base
 *
 * Quality dampening (applied to all sectors):
 *   The regime effect is dampened toward 1.0x for high-quality names and
 *   amplified for low-quality names. This recognizes that a high-quality
 *   growth name (GOOGL) holds up better in Risk-Off than a pre-revenue
 *   SaaS company, and a high-quality cyclical (JPM) is more resilient
 *   than a leveraged regional bank.
 *
 *   quality factor (qf) = sum of quality scores / 8 → 0..1
 *   dampening = (qf - 0.5) × QUALITY_DAMPENING_STRENGTH
 *
 *   At qf=1.0 (max quality): regime effect softened by 35%
 *   At qf=0.5 (average):     no adjustment
 *   At qf=0.0 (min quality): regime effect amplified by 35%
 *
 *   Example — Growth in Risk-Off (base 0.85x, deviation = -0.15):
 *     High quality (qf=1.0): 0.85 + 0.15 × 0.35 = 0.903x  (~10% penalty)
 *     Average     (qf=0.5):  0.85 (unchanged)               (~15% penalty)
 *     Low quality (qf=0.0):  0.85 - 0.15 × 0.35 = 0.797x  (~20% penalty)
 *
 *   Quality is the dominant factor in determining how much regime matters:
 *   a 14pp spread between max and min quality within the same sector/regime.
 */
const QUALITY_DAMPENING_STRENGTH = 0.7;

export function regimeMultiplier(
  sector: string,
  riskRegime: string,
  scores?: Record<string, number>
): number {
  const s = normalizeSector(sector);
  let base: number;
  if (riskRegime === "Risk-Off") {
    if (DEFENSIVE_SECTORS.includes(s)) base = 1.10;
    else if (GROWTH_SECTORS.includes(s)) base = 0.85;
    else if (CYCLICAL_SECTORS.includes(s)) base = 0.90;
    else base = 1;
  } else if (riskRegime === "Neutral") {
    if (DEFENSIVE_SECTORS.includes(s)) base = 1.01;
    else if (GROWTH_SECTORS.includes(s)) base = 0.98;
    else if (CYCLICAL_SECTORS.includes(s)) base = 0.99;
    else base = 1;
  } else {
    // Risk-On
    if (GROWTH_SECTORS.includes(s)) base = 1.10;
    else if (CYCLICAL_SECTORS.includes(s)) base = 1.05;
    else if (DEFENSIVE_SECTORS.includes(s)) base = 0.92;
    else base = 1;
  }

  // No dampening needed if multiplier is neutral or scores unavailable
  if (base === 1 || !scores) return base;

  // Dampen: shift the multiplier toward 1.0 for high quality, away for low quality
  const qf = qualityFactor(scores);
  const deviation = base - 1; // negative for penalties, positive for boosts
  const dampening = (qf - 0.5) * QUALITY_DAMPENING_STRENGTH;
  // For penalties (deviation < 0): high quality reduces the penalty (dampening > 0)
  // For boosts (deviation > 0): high quality also reduces the boost slightly —
  //   which is correct: high-quality defensives don't need as big a boost because
  //   their quality already provides resilience.
  return Math.round((base - deviation * dampening) * 1000) / 1000;
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

  const multiplier = regimeMultiplier(stock.sector, marketData.riskRegime, stock.scores);
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
  if (DEFENSIVE_SECTORS.includes(normalizeSector(stock.sector))) risk = "Low";

  return { ...stock, raw, adjusted, rating, ratingLabel, risk };
}

export function isOffensiveSector(sector: string): boolean {
  return OFFENSIVE_SECTORS.includes(normalizeSector(sector));
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
