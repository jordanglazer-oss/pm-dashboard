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

export type Stock = {
  ticker: string;
  name: string;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  beta: number;
  weights: { portfolio: number };
  scores: Scores;
  explanations?: ScoreExplanations;
  lastScored?: string;
  price?: number;
  notes: string;
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
};

export type MorningBrief = {
  date: string;
  marketData: MarketData;
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
};
