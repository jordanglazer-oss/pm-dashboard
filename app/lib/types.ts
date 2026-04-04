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
  breadth: number;
  vix: number;
  move: number;
  fearGreed: number;
  hyOas: number;
  igOas: number;
  aaiiBullBear: number;
  putCall: number;
  termStructure: string;
  spOscillator: number;
  equityFlows: string;
  nasdaqBreadth: number;
  sp50dma: number;
  nyseAdLine: number;
  newHighsLows: number;
  aaiiBull: number;
  aaiiNeutral: number;
  aaiiBear: number;
  sp500SectorWeights?: Record<string, number>; // Live S&P 500 sector weights from SPY
};

export type MorningBrief = {
  date: string;
  generatedAt?: string;
  marketData: MarketData;
  marketRegime?: string;
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
