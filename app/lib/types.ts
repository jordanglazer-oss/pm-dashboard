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

/**
 * A single data point referenced in a scoring explanation, with an
 * attributed source so the analyst can audit where each number came from.
 *
 * Sources:
 *   - "edgar": SEC XBRL (US filings) — most authoritative
 *   - "edgar-form4": SEC insider trades (Form 4)
 *   - "yahoo": Yahoo Finance data feed
 *   - "web": Anthropic web_search result (cite source name in sourceDetail)
 *   - "model": qualitative inference by the model with no specific data source
 */
export type ScoreDataPointSource =
  | "edgar"
  | "edgar-form4"
  | "yahoo"
  | "web"
  | "model";

export type ScoreDataPoint = {
  /** Short label (e.g. "Revenue (Q4 2025)", "Forward P/E", "Insider buys") */
  label: string;
  /** Value as a string (already formatted, e.g. "$5.62B", "23.4x", "+12% YoY") */
  value: string;
  /** Provenance — which pipe/source the value came from */
  source: ScoreDataPointSource;
  /** Optional human-readable detail: filing date, publication name, search query, etc. */
  sourceDetail?: string;
  /**
   * Optional URL to the underlying source so the analyst can click through
   * to verify the number directly. Required for `source: "web"` data points
   * (the model is instructed to include the actual cited URL). For Yahoo
   * sources, the UI computes a default Yahoo Finance subpage URL from the
   * label and ticker if this is absent.
   */
  url?: string;
};

/**
 * A free-text "External Source" note entered by the PM under the External
 * sources scoring category. Each note is a single source (e.g. a sell-side
 * analyst report, news article, trade pub) with a date stamp. The whole
 * list lives on the Stock and persists in pm:stocks so notes survive
 * refreshes and sync across devices.
 */
export type ExternalSourceNote = {
  id: string;
  /** YYYY-MM-DD; empty string allowed for partial entries */
  date: string;
  /** Free-text describing the source (analyst name, publication, URL, etc.) */
  text: string;
};

/**
 * The model's confidence in its score for this category, independent of the
 * score value itself. A 2/3 with "high" confidence is meaningfully different
 * from a 2/3 with "low" confidence — the latter flags scores that need a
 * second look. Surfaced as a small chip in the accordion UI.
 */
export type ScoreConfidence = "high" | "medium" | "low";

/**
 * Per-category scoring explanation. The "summary" is the dense prose the
 * analyst reads; "dataPoints" is the audit trail — every numeric or
 * qualitative claim the summary makes should be backed by an entry here.
 */
export type ScoreCategoryExplanation = {
  /** Dense paragraph (3-6 sentences) explaining the score */
  summary: string;
  /** Bulleted data points the summary cites, each with source attribution */
  dataPoints: ScoreDataPoint[];
  /** Optional confidence rating — emitted by the model on new scores; older
   *  scores predating this field render without the confidence chip. */
  confidence?: ScoreConfidence;
};

/**
 * Backward-compatible explanations type. Old entries are `string[]` (legacy
 * bullet form); new entries are `ScoreCategoryExplanation`. UI renderers
 * handle both shapes — see the stock page accordion.
 */
export type ScoreExplanations = Partial<Record<ScoreKey, string[] | ScoreCategoryExplanation>>;

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
  /**
   * PM-entered notes for the "External sources" scoring category (a manual
   * category). Each entry is a single source (analyst report, article, etc)
   * with its own date. Persisted with the rest of the stock blob in
   * pm:stocks so notes survive refreshes and sync across devices.
   */
  externalSourceNotes?: ExternalSourceNote[];
  /**
   * PM-entered notes for the "Research coverage" scoring category (semi-
   * automated). Same shape as externalSourceNotes — one row per analyst
   * report / sell-side note / coverage initiation, with a date stamp.
   * Surfaced into the scoring prompt so Claude can factor named-firm
   * coverage and PT changes into the researchCoverage score.
   */
  researchCoverageNotes?: ExternalSourceNote[];
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
  /** @deprecated Removed from the brief in 2026-05. Field kept for
   *  backward compat with persisted marketData blobs but no longer
   *  read or rendered. Safe to ignore. */
  equityFlows?: string;
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
  /** @deprecated Removed from the brief in 2026-05. Flows are
   *  inherently backward-looking and contrarianAnalysis already
   *  covers sentiment/positioning extremes — keeping flowsAnalysis
   *  was duplicative. Field kept on the type for backward compat
   *  with persisted briefs; nothing renders or generates it. */
  flowsAnalysis?: string;
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
