import type { Stock, MarketData } from "./types";

export const defaultMarketData: MarketData = {
  date: "March 23, 2026",
  compositeSignal: "Bearish",
  conviction: "High",
  riskRegime: "Risk-Off",
  hedgeScore: 78,
  hedgeTiming: "Favorable",
  fearGreed: 24,
  aaiiBullBear: -18,
  putCall: 1.08,
  termStructure: "Contango",
  spOscillator: 0,
  equityFlows: "Mixed",
  aaiiBull: 30,
  aaiiNeutral: 17,
  aaiiBear: 52,
};

export const holdingsSeed: Stock[] = [
  {
    ticker: "META",
    name: "Meta Platforms, Inc.",
    bucket: "Portfolio",
    sector: "Communication Services",
    beta: 1.18,
    weights: { portfolio: 7.2 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 1, aiRating: 1, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "Ad resilience still good, but cyclical growth multiple risk is rising in a weak-breadth market.",
  },
  {
    ticker: "CRM",
    name: "Salesforce, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.27,
    weights: { portfolio: 5.6 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 1, growth: 2, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 1 },
    notes: "Strong SaaS franchise, but regime fit is poor while spreads widen and growth leadership fades.",
  },
  {
    ticker: "BN",
    name: "Brookfield Corporation",
    bucket: "Portfolio",
    sector: "Financials",
    beta: 0.92,
    weights: { portfolio: 4.3 },
    scores: { brand: 2, secular: 1, researchCoverage: 4, externalSources: 0, charting: 2, relativeStrength: 2, aiRating: 2, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 1, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "More resilient than pure growth and better aligned with real-asset and capital rotation themes.",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.06,
    weights: { portfolio: 6.0 },
    scores: { brand: 2, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 1, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 2, leverageCoverage: 2, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 0 },
    notes: "Search dominance intact, AI investment heavy but funded by cash generation. Regulatory overhang persists.",
  },
  {
    ticker: "AMZN",
    name: "Amazon.com, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.15,
    weights: { portfolio: 5.5 },
    scores: { brand: 2, secular: 2, researchCoverage: 4, externalSources: 0, charting: 0, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "AWS growth re-accelerating but retail margins under pressure. Expensive on most metrics.",
  },
  {
    ticker: "JPM",
    name: "JPMorgan Chase & Co.",
    bucket: "Portfolio",
    sector: "Financials",
    beta: 1.05,
    weights: { portfolio: 4.0 },
    scores: { brand: 1, secular: 1, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Best-in-class bank but credit cycle risk rising. NII tailwinds fading as rate curve shifts.",
  },
  {
    ticker: "UNH",
    name: "UnitedHealth Group Inc.",
    bucket: "Portfolio",
    sector: "Health Care",
    beta: 0.65,
    weights: { portfolio: 4.5 },
    scores: { brand: 1, secular: 1, researchCoverage: 3, externalSources: 0, charting: 0, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Defensive quality name under political pressure. Medical loss ratio trending higher.",
  },
  {
    ticker: "UBER",
    name: "Uber Technologies, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.35,
    weights: { portfolio: 3.5 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 2, leverageCoverage: 2, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "Network effects strengthening, FCF inflecting positive. Autonomous vehicle risk is overstated near-term.",
  },
  {
    ticker: "PANW",
    name: "Palo Alto Networks, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.2,
    weights: { portfolio: 3.5 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Platformization working but billings deceleration spooked the street. Valuation still full.",
  },
  {
    ticker: "XLE",
    name: "Energy Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Energy",
    beta: 1.05,
    weights: { portfolio: 0 },
    scores: { brand: 1, secular: 1, researchCoverage: 4, externalSources: 0, charting: 3, relativeStrength: 2, aiRating: 2, growth: 2, relativeValuation: 3, historicalValuation: 2, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 2, catalysts: 3, trackRecord: 1, ownershipTrends: 1 },
    notes: "Tactical fit is strong in inflation, geopolitics, and risk-off rotation.",
  },
  {
    ticker: "XLU",
    name: "Utilities Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Utilities",
    beta: 0.48,
    weights: { portfolio: 0 },
    scores: { brand: 1, secular: 0, researchCoverage: 4, externalSources: 0, charting: 2, relativeStrength: 2, aiRating: 2, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 1 },
    notes: "Useful defensive ballast when PMs need capital preservation over beta exposure.",
  },
  {
    ticker: "MDT",
    name: "Medtronic plc",
    bucket: "Portfolio",
    sector: "Health Care",
    beta: 0.78,
    weights: { portfolio: 3.0 },
    scores: { brand: 1, secular: 1, researchCoverage: 3, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 1, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Turnaround story with new CEO. Pipeline refresh underway but execution risk remains.",
  },
];

export type RBCEntry = {
  ticker: string;
  sector: string;
  weight: number;
  dateAdded: string;
};

export type SectorView = "overweight" | "neutral" | "underweight";

export type SectorViewEntry = {
  sector: string;
  view: SectorView;
};

// The 11 GICS sectors pre-populated so the PM only has to toggle views.
export const GICS_SECTORS = [
  "Technology",
  "Health Care",
  "Financials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Industrials",
  "Materials",
  "Communication Services",
  "Real Estate",
] as const;

export type LeeFocusArea = {
  label: string; // free-text theme, e.g. "AI infrastructure", "GARP names"
};

export type ResearchState = {
  newtonUpticks: UptickEntry[];
  fundstratTop: IdeaEntry[];
  fundstratBottom: IdeaEntry[];
  rbcCanadianFocus: RBCEntry[];
  // Seeking Alpha Alpha Picks — institutional buy recommendations
  // populated from the Alpha Picks dashboard screenshot. Same shape
  // as IdeaEntry (ticker + entry price) for consistency with the
  // Fundstrat lists.
  alphaPicks?: IdeaEntry[];
  generalNotes: string;
  attachments?: import("@/app/components/ImageUpload").BriefAttachment[];
  // Newton's sector overweight/underweight views. Pre-populated with all
  // 11 GICS sectors defaulting to "neutral"; the PM toggles as needed.
  newtonSectors?: SectorViewEntry[];
  // Tom Lee's sector overweight/underweight views. Same format as Newton's.
  leeSectors?: SectorViewEntry[];
  // Tom Lee's areas to focus on — free-text labels the PM types in because
  // Lee's themes often aren't standard GICS sectors (e.g. "AI beneficiaries",
  // "GARP names", "epicenter stocks").
  leeFocusAreas?: LeeFocusArea[];
};

export type UptickEntry = {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  support: string;
  resistance: string;
  dateAdded: string;
  priceWhenAdded: number;
};

export type IdeaEntry = {
  ticker: string;
  priceWhenAdded: number;
};

export const defaultResearch: ResearchState = {
  newtonUpticks: [],
  fundstratTop: [],
  fundstratBottom: [],
  rbcCanadianFocus: [],
  alphaPicks: [],
  generalNotes: "",
  attachments: [],
  newtonSectors: GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView })),
  leeSectors: GICS_SECTORS.map((s) => ({ sector: s, view: "neutral" as SectorView })),
  leeFocusAreas: [],
};
