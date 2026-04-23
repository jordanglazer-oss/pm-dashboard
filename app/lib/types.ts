import type { TechnicalIndicators, RiskAlert } from "./technicals";

// Re-export for convenience
export type { TechnicalIndicators, RiskAlert };

// ── Scoring category definitions ──
// Each sub-category has a max score and an input type:
//   AUTO  = Claude scores automatically
//   SEMI  = Claude provides initial score, PM can override
//   MANUAL = PM scores manually (defaults provided)

export type ScoreCategory = {
  key: string;
  label: string;
  max: number;
  inputType: "auto" | "semi" | "manual";
};

export type ScoreGroup = {
  name: string;
  color: string;
  icon: string;
  categories: ScoreCategory[];
  maxTotal: number;
};

// All score keys across all groups
export type ScoreKey =
  // Long-term
  | "brand"
  | "secular"
  // Research
  | "researchCoverage"
  | "externalSources"
  // Technicals
  | "charting"
  | "relativeStrength"
  | "aiRating"
  // Fundamental
  | "growth"
  | "relativeValuation"
  | "historicalValuation"
  | "leverageCoverage"
  | "cashFlowQuality"
  // Company Specific
  | "competitiveMoat"
  | "turnaround"
  | "catalysts"
  // Management
  | "trackRecord"
  | "ownershipTrends";

export type Scores = Record<ScoreKey, number>;

export type ScoreExplanations = Partial<Record<ScoreKey, string[]>>;

export const SCORE_GROUPS: ScoreGroup[] = [
  {
    name: "Long-term",
    color: "blue",
    icon: "○",
    maxTotal: 4,
    categories: [
      { key: "brand", label: "Generational / brand", max: 2, inputType: "manual" },
      { key: "secular", label: "Secular growth trend", max: 2, inputType: "auto" },
    ],
  },
  {
    name: "Research",
    color: "purple",
    icon: "◇",
    maxTotal: 8,
    categories: [
      { key: "researchCoverage", label: "Research coverage", max: 4, inputType: "semi" },
      { key: "externalSources", label: "External sources", max: 4, inputType: "manual" },
    ],
  },
  {
    name: "Technicals",
    color: "teal",
    icon: "◆",
    maxTotal: 7,
    categories: [
      { key: "charting", label: "Charting", max: 3, inputType: "manual" },
      { key: "relativeStrength", label: "SIA (relative strength)", max: 2, inputType: "manual" },
      { key: "aiRating", label: "BoostedAI (AI rating)", max: 2, inputType: "manual" },
    ],
  },
  {
    name: "Fundamental",
    color: "green",
    icon: "■",
    maxTotal: 11,
    categories: [
      { key: "growth", label: "Growth (rev / earnings / FCF)", max: 3, inputType: "auto" },
      { key: "relativeValuation", label: "Relative valuation", max: 3, inputType: "auto" },
      { key: "historicalValuation", label: "Historical valuation", max: 2, inputType: "auto" },
      { key: "leverageCoverage", label: "Leverage & coverage", max: 2, inputType: "auto" },
      { key: "cashFlowQuality", label: "Cash flow quality", max: 1, inputType: "auto" },
    ],
  },
  {
    name: "Company Specific",
    color: "amber",
    icon: "●",
    maxTotal: 7,
    categories: [
      { key: "competitiveMoat", label: "Competitive moat", max: 2, inputType: "semi" },
      { key: "turnaround", label: "Turnaround momentum", max: 2, inputType: "manual" },
      { key: "catalysts", label: "Potential catalysts", max: 3, inputType: "semi" },
    ],
  },
  {
    name: "Management",
    color: "red",
    icon: "◐",
    maxTotal: 3,
    categories: [
      { key: "trackRecord", label: "Track record", max: 1, inputType: "semi" },
      { key: "ownershipTrends", label: "Ownership trends", max: 2, inputType: "semi" },
    ],
  },
];

export const MAX_SCORE = SCORE_GROUPS.reduce((sum, g) => sum + g.maxTotal, 0); // 40

export type HealthData = {
  fiftyDayAvg?: number;
  twoHundredDayAvg?: number;
  pegRatio?: number;
  shortPercentOfFloat?: number;
  heldPercentInstitutions?: number;
  heldPercentInsiders?: number;
  earningsDate?: string;
  exDividendDate?: string;
  forwardPE?: number;
  trailingPE?: number;
  enterpriseToEbitda?: number;
  earningsCurrentEst?: number;
  earnings30dAgo?: number;
  earnings90dAgo?: number;
  fcfMargin?: number;
  roic?: number;
  revenueGrowth?: number;
  currentPrice?: number;
};

// ── Fund / ETF specific data ──

export type FundHolding = {
  symbol: string;
  name: string;
  weight: number; // percentage
};

export type FundSectorWeight = {
  sector: string;
  weight: number; // percentage
};

export type FundPerformance = {
  ytd?: number;
  oneMonth?: number;
  threeMonth?: number;
  oneYear?: number;
  threeYear?: number;
  fiveYear?: number;
  tenYear?: number;
};

export type FundRiskStats = {
  alpha?: number;
  beta?: number;
  sharpeRatio?: number;
  treynorRatio?: number;
  rSquared?: number;
  stdDev?: number;
};

export type FundData = {
  expenseRatio?: number; // MER for Canadian funds
  totalAssets?: number; // AUM in dollars
  yield?: number;
  category?: string;
  fundFamily?: string;
  inceptionDate?: string;
  turnover?: number;
  topHoldings?: FundHolding[];
  sectorWeightings?: FundSectorWeight[];
  assetAllocation?: {
    stock?: number;
    bond?: number;
    cash?: number;
    other?: number;
  };
  performance?: FundPerformance;
  categoryPerformance?: FundPerformance; // for comparison
  riskStats?: FundRiskStats;
  equityMetrics?: {
    priceToEarnings?: number;
    priceToBook?: number;
    priceToSales?: number;
    priceToCashflow?: number;
  };
  starRating?: number; // Morningstar star rating (1-5)
  fundservCode?: string; // Canadian FUNDSERV code (e.g., TDB900)
  yahooTicker?: string; // Resolved Yahoo ticker for Canadian funds (e.g., 0P000071WA.TO)
  holdingsUrl?: string; // User-provided URL for scraping holdings from fund website
  holdingsLastUpdated?: string; // Timestamp when holdings were last fetched via URL
  holdingsSource?: string; // Where the current topHoldings came from (e.g. "iShares", "Morningstar", "Yahoo", or the hostname of a user URL). Useful for knowing whether to provide a URL manually.
  lastUpdated?: string;
};

export type InstrumentType = "stock" | "etf" | "mutual-fund";

export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  stock: "Stock",
  etf: "ETF",
  "mutual-fund": "Mutual Fund",
};

export type Stock = {
  ticker: string;
  name: string;
  instrumentType?: InstrumentType;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  beta: number;
  weights: { portfolio: number };
  scores: Scores;
  explanations?: ScoreExplanations;
  lastScored?: string;
  price?: number;
  costBasis?: number;
  notes: string;
  companySummary?: string;
  investmentThesis?: string;
  healthData?: HealthData;
  technicals?: TechnicalIndicators;
  riskAlert?: RiskAlert;
  fundData?: FundData;
  /** User-provided MER override for ETFs / mutual funds where the
   *  auto-fetch in /api/fund-data failed to resolve a value. Expressed
   *  as a percentage (e.g. 0.08 for an 8 bps ETF). When set, this
   *  takes precedence over `fundData.expenseRatio` in the Client
   *  Report blended-MER calculation. */
  manualExpenseRatio?: number;
  modelEligibility?: Record<string, boolean>; // PIM model group id → eligible (default all true)
  modelWeights?: Record<string, number>; // PIM model group id → weight% in Balanced (overrides weights.portfolio)
  designation?: "core" | "alpha"; // Core = indexed/passive, Alpha = active picks (default alpha)
};

export type ScoredStock = Stock & {
  raw: number;
  adjusted: number;
  rating: "Buy" | "Hold" | "Sell";
  ratingLabel?: string;
  risk: "High" | "Medium" | "Low";
  sensitivity?: "High" | "Moderate" | "Low";
};

export type MarketData = {
  date: string;
  compositeSignal: string;
  conviction: string;
  riskRegime: string;
  hedgeScore: number;
  hedgeTiming: string;
  fearGreed: number;
  aaiiBullBear: number;
  putCall: number;
  termStructure: string;
  spOscillator: number;
  equityFlows: string;
  aaiiBull: number;
  aaiiNeutral: number;
  aaiiBear: number;
  sp500SectorWeights?: Record<string, number>; // Live S&P 500 sector weights from SPY
  sp500SectorWeightsAt?: string; // ISO timestamp of last successful SPY weights refresh
  // ── Strategist notes (copy-pasted daily reports) ──
  // These get injected into the morning brief prompt so Claude can
  // incorporate Fundstrat/external research when forming its view.
  strategistNotes?: {
    newton?: string; // Mark Newton (Fundstrat Technical Strategy)
    newtonDate?: string; // YYYY-MM-DD date the Newton note pertains to
    lee?: string; // Tom Lee (Fundstrat Head of Research)
    leeDate?: string; // YYYY-MM-DD date the Lee note pertains to
  };
  // ── Deprecated manual fields ──
  // These were superseded by ForwardLookingData (auto-fetched). They remain
  // optional so cached briefs in Redis (pm:brief) decode without errors.
  // New briefs no longer set or read these.
  breadth?: number;
  vix?: number;
  move?: number;
  hyOas?: number;
  igOas?: number;
  nasdaqBreadth?: number;
  sp50dma?: number;
  nyseAdLine?: number;
  newHighsLows?: number;
};

// Shape matches ForwardLookingData in app/lib/forward-looking.ts
// (duplicated here to avoid server-only deps leaking into the client bundle).
export type ForwardPointStatus = "live" | "stale" | "failed" | "not-configured";

export type SparkPointBundle = { date: string; value: number };

// Mirror of TrendStats in app/lib/forward-looking.ts. Optional so older
// briefs cached in Redis still decode without errors.
export type TrendStatsBundle = {
  current: number;
  delta1w?: number | null;
  delta1m?: number | null;
  delta3m?: number | null;
  rangeLow: number;
  rangeHigh: number;
  percentile: number;
  trajectory: "falling fast" | "falling" | "stable" | "rising" | "rising fast";
};

export type ForwardPointBundle = {
  value: number | null;
  source: string;
  sourceLabel: string;
  asOf: string;
  previous?: number | null;
  note?: string;
  status: ForwardPointStatus;
  history?: SparkPointBundle[];
  trend?: TrendStatsBundle;
};

export type ForwardLookingBundle = {
  spxYtd: ForwardPointBundle;
  spxWeek: ForwardPointBundle;
  spyForwardPE: ForwardPointBundle;
  spyTrailingPE: ForwardPointBundle;
  impliedEpsGrowth: ForwardPointBundle;
  // Optional so briefs cached in Redis before this field was introduced
  // still decode without errors. New briefs populate it from SSGA.
  eps35Growth?: ForwardPointBundle;
  // Optional breadth tiles — also added post-launch, so must be optional
  // for Redis backward compatibility with existing cached briefs.
  breadth200Wk?: ForwardPointBundle;
  breadth200Mo?: ForwardPointBundle;
  breadth50Wk?: ForwardPointBundle;
  // Optional sentiment tiles (CNN F&G, AAII, S&P Oscillator) — added after
  // launch, must be optional for Redis-cached briefs to decode.
  fearGreed?: ForwardPointBundle;
  aaiiBullBear?: ForwardPointBundle;
  aaiiBull?: ForwardPointBundle;
  aaiiNeutral?: ForwardPointBundle;
  aaiiBear?: ForwardPointBundle;
  spOscillator?: ForwardPointBundle;
  putCallRatio?: ForwardPointBundle;
  yield10y: ForwardPointBundle;
  yield2y: ForwardPointBundle;
  yield3m: ForwardPointBundle;
  curve10y2y: ForwardPointBundle;
  curve10y3m: ForwardPointBundle;
  hyOasTrend: ForwardPointBundle;
  igOasTrend: ForwardPointBundle;
  vixWeek: ForwardPointBundle;
  moveWeek: ForwardPointBundle;
  fredEnabled: boolean;
  fetchedAt: string;
};

export type MorningBrief = {
  date: string;
  generatedAt?: string;
  marketData: MarketData;
  marketRegime?: string;
  regimeScore?: number; // Deterministic pre-classification score, -6 to +6
  regimeSignals?: string[]; // Drivers that produced the score
  forwardView?: string; // Legacy single-paragraph forward view; kept for backward compat with old briefs
  /**
   * Three-horizon forward outlook. New as of Phase 3 — old briefs in
   * pm:brief predate these and the UI must tolerate `undefined` (falls
   * back to the legacy `forwardView` paragraph).
   *
   *   tacticalView   — 1-3M flow/vol/momentum read; what to do this month
   *   cyclicalView   — 3-6M sector rotation + business cycle (ISM PMI)
   *   structuralView — 6-12M trend overlay (SPX 10M MA, PMI direction)
   *
   * Each is 2-3 sentences, written to be readable in isolation but
   * intentionally interlocking — tactical sets the near-term action,
   * cyclical confirms or contests the rotation thesis, structural is
   * the don't-fight-the-tape veto.
   */
  tacticalView?: string;
  cyclicalView?: string;
  structuralView?: string;
  forwardLooking?: ForwardLookingBundle; // Automated data powering Forward View
  bottomLine: string;
  compositeAnalysis: string;
  creditAnalysis: string;
  volatilityAnalysis: string;
  breadthAnalysis: string;
  flowsAnalysis: string;
  hedgingAnalysis: string;
  contrarianAnalysis: string;
  sectorRotation?: {
    summary: string;
    leading: string[];
    lagging: string[];
    pmImplication: string;
  };
  riskScan?: {
    ticker: string;
    priority: "High" | "Medium-High" | "Medium" | "Low-Medium";
    summary: string;
    action: string;
  }[];
  forwardActions: {
    priority: "High" | "Medium" | "Low";
    title: string;
    detail: string;
  }[];
};

export type ScoreResponse = {
  ticker: string;
  name: string;
  sector: string;
  beta: number;
  scores: Partial<Scores>;
  explanations: ScoreExplanations;
  notes: string;
  healthData?: HealthData;
  technicals?: TechnicalIndicators;
  riskAlert?: RiskAlert;
};
