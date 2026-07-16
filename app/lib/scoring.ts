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
 *   All sectors → 1.0x (pure pass-through, raw = adjusted)
 *
 *   Neutral means "no strong signal" — no multiplier effect at all.
 *   The regime only matters in Risk-On or Risk-Off.
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
    // Neutral = no strong signal → pure pass-through (1.0x for all sectors).
    // The regime multiplier only matters in Risk-On or Risk-Off.
    base = 1;
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

/**
 * Forward-looking regime blend (Phase 05).
 *
 * A PARALLEL score — never replaces `adjusted`. It blends the current-regime
 * multiplier with the multiplier for the regime we're LEANING TOWARD, weighted
 * by a transition-probability `p`, so a name held for months is scored partly
 * against the regime it's heading into. When p=0 (calm markets / Low transition
 * risk) or the lean is "stable", the forward multiplier equals the current one
 * and the forward score is identical to `adjusted`.
 */

/** Blend weight `p` from the regime-transition likelihood. Deliberately
 *  conservative: Low = 0 (forward score = today), capped at 0.5 so the
 *  anticipated regime never fully overrides the current one. */
export function transitionWeight(likelihood: string | undefined): number {
  switch (likelihood) {
    case "High":
      return 0.5;
    case "Elevated":
      return 0.35;
    case "Watch":
      return 0.15;
    default:
      return 0; // Low / undefined
  }
}

/** A name's "fit" for a regime, from its multiplier: >1 favored, <1 headwind. */
export function regimeFit(mult: number): "favored" | "neutral" | "headwind" {
  if (mult > 1.001) return "favored";
  if (mult < 0.999) return "headwind";
  return "neutral";
}

/** Forward (blended) multiplier: current blended with anticipated, weighted by
 *  p. No-op (returns the current multiplier) when there is no anticipated
 *  regime, it equals the current regime, or p ≤ 0. */
export function forwardMultiplier(
  sector: string,
  currentRegime: string,
  anticipatedRegime: string | undefined,
  p: number,
  scores?: Record<string, number>
): number {
  const cur = regimeMultiplier(sector, currentRegime, scores);
  if (!anticipatedRegime || anticipatedRegime === currentRegime || !(p > 0)) return cur;
  const ant = regimeMultiplier(sector, anticipatedRegime, scores);
  return Math.round((cur * (1 - p) + ant * p) * 1000) / 1000;
}

// Legacy aliases for backward compatibility
const OFFENSIVE_SECTORS = GROWTH_SECTORS;

// MarketEdge (ChartScout) covers US-listed stocks only. The category max.
const MARKETEDGE_MAX = 2;
// Canadian listings of INDIVIDUAL stocks (excludes the .U USD-ETF suffix,
// which is irrelevant here since ETFs aren't scored).
const CANADIAN_LISTING_RE = /(\.TO|\.V|\.NE|\.CN|-T)$/i;

/**
 * Whether the MarketEdge category applies to this stock's composite.
 * - US (and any non-Canadian) listing: always applies.
 * - Canadian listing: applies ONLY if MarketEdge data actually flowed in —
 *   i.e. a dual-listed name whose US listing's reading was matched onto it.
 *   A pure-Canadian (TSX-only) name MarketEdge can't cover gets N/A.
 * When N/A, the category is removed from BOTH the numerator and the
 * denominator and the remaining score is normalized back to the full
 * 0–MAX_SCORE scale, so the stock isn't penalized for a data source that
 * structurally can't reach it.
 */
export function marketEdgeApplies(stock: Stock): boolean {
  if (!CANADIAN_LISTING_RE.test(stock.ticker.trim())) return true;
  const me = stock.marketEdge;
  return !!(me && (me.powerRating != null || me.opinion != null || me.opinionScore != null));
}

// ── Absent ≠ bearish: external categories N/A until their data is imported ──
// A freshly-added name has NO BoostedAI / SIA / MarketEdge data yet — its
// seeded 0 in those categories is "not imported", not "rated poorly". Counting
// the 0 against the composite penalized every new watchlist add for data that
// simply hadn't arrived. Each category is N/A (dropped from numerator AND
// denominator, composite normalized back to the 0–MAX_SCORE scale) when its
// RAW source is absent — unless a nonzero score exists (legacy manual entry),
// which still counts. Once the weekly import lands, the category snaps in
// automatically.
const AIRATING_MAX = 2;
const RELSTRENGTH_MAX = 2;

/** BoostedAI (aiRating) counts only once a rating/consensus was imported. */
export function boostedAiApplies(stock: Stock): boolean {
  if (typeof stock.boostedAi === "number" || stock.boostedAiConsensus != null) return true;
  return (stock.scores.aiRating || 0) !== 0;
}

/** SIA (relativeStrength) counts only once an SMAX was imported. */
export function siaApplies(stock: Stock): boolean {
  if (typeof stock.sia === "number") return true;
  return (stock.scores.relativeStrength || 0) !== 0;
}

/** MarketEdge in the COMPOSITE: the structural Canadian rule above, plus the
 *  same not-yet-imported rule for US names. Deliberately separate from
 *  marketEdgeApplies — the coverage UI keeps using that, because for a US name
 *  missing MarketEdge data is a gap to chase, not an N/A. */
function marketEdgeCountsInComposite(stock: Stock): boolean {
  if (!marketEdgeApplies(stock)) return false;
  const me = stock.marketEdge;
  if (me && (me.powerRating != null || me.opinion != null || me.opinionScore != null)) return true;
  return (stock.scores.marketEdge || 0) !== 0;
}

export function computeScores(
  stock: Stock,
  marketData: MarketData,
  /** Optional forward-looking regime context (Phase 05). When present, a
   *  PARALLEL `forwardAdjusted` score is computed alongside `adjusted` —
   *  `adjusted` is never changed by this. Absent → forward === current. */
  forward?: { anticipatedRegime?: string; transitionWeight?: number }
): ScoredStock {
  const rawSum = (Object.keys(stock.scores) as ScoreKey[]).reduce(
    (sum, key) => sum + (stock.scores[key] || 0),
    0
  );
  // External-category N/A handling: each of MarketEdge / BoostedAI / SIA drops
  // out of BOTH the numerator and the denominator when it doesn't apply
  // (structurally uncovered, or its data simply hasn't been imported yet), and
  // the remaining score is normalized back to the full 0–MAX_SCORE scale so
  // ratings stay comparable on the same thresholds. A fresh watchlist add is
  // judged only on the categories that actually have data.
  let applicableSum = rawSum;
  let effectiveMax = MAX_SCORE;
  if (!marketEdgeCountsInComposite(stock)) {
    applicableSum -= stock.scores.marketEdge || 0;
    effectiveMax -= MARKETEDGE_MAX;
  }
  if (!boostedAiApplies(stock)) {
    applicableSum -= stock.scores.aiRating || 0;
    effectiveMax -= AIRATING_MAX;
  }
  if (!siaApplies(stock)) {
    applicableSum -= stock.scores.relativeStrength || 0;
    effectiveMax -= RELSTRENGTH_MAX;
  }
  const normalizedSum = effectiveMax > 0 ? applicableSum * (MAX_SCORE / effectiveMax) : applicableSum;
  // Round to 1 decimal to avoid IEEE 754 floating-point noise
  // (e.g. 21.490000000000002 → 21.5)
  const raw = Math.round(normalizedSum * 10) / 10;

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

  // ── Forward (blended) score — PARALLEL to `adjusted`, never replaces it ──
  const p = forward?.transitionWeight ?? 0;
  const anticipated = forward?.anticipatedRegime;
  const fwdMult = forwardMultiplier(stock.sector, marketData.riskRegime, anticipated, p, stock.scores);
  const forwardAdjusted = Math.round(raw * fwdMult * 10) / 10;
  const regimeFitNow = regimeFit(regimeMultiplier(stock.sector, marketData.riskRegime, stock.scores));
  const regimeFitNext = anticipated
    ? regimeFit(regimeMultiplier(stock.sector, anticipated, stock.scores))
    : regimeFitNow;

  return {
    ...stock,
    raw,
    adjusted,
    rating,
    ratingLabel,
    risk,
    forwardAdjusted,
    forwardMult: fwdMult,
    regimeFitNow,
    regimeFitNext,
    anticipatedRegime: anticipated,
    transitionWeight: p,
  };
}

export function isOffensiveSector(sector: string): boolean {
  return OFFENSIVE_SECTORS.includes(normalizeSector(sector));
}

/** Returns true if the instrument can be scored (individual stocks only, not ETFs/funds) */
export function isScoreable(stock: Stock): boolean {
  return !stock.instrumentType || stock.instrumentType === "stock";
}

export function groupTotal(stock: Stock, group: typeof SCORE_GROUPS[number]): number {
  const sum = group.categories.reduce(
    (acc, cat) => acc + (stock.scores[cat.key as ScoreKey] || 0),
    0
  );
  // Round to 1 decimal to avoid IEEE 754 floating-point noise
  return Math.round(sum * 10) / 10;
}
