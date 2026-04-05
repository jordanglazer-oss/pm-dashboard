// ── PIM Model Types ──

export type PimAssetClass = "fixedIncome" | "equity" | "alternative";

export type PimHolding = {
  name: string;
  symbol: string;
  currency: "CAD" | "USD";
  assetClass: PimAssetClass;
  weightInClass: number; // weight within the asset class (e.g., 0.5 = 50% of fixed income)
};

export type PimProfileWeights = {
  cash: number;
  fixedIncome: number;
  equity: number;
  alternatives: number;
};

export type PimProfileType = "balanced" | "growth" | "allEquity";

export type PimModelGroup = {
  id: string;
  name: string;
  profiles: Partial<Record<PimProfileType, PimProfileWeights>>;
  cadSplit: number; // fraction of cash in CAD (0-1)
  usdSplit: number; // fraction of cash in USD (0-1)
  holdings: PimHolding[];
};

// Computed holding row for display
export type PimComputedHolding = PimHolding & {
  weightInPortfolio: number; // weightInClass × asset class allocation
  cadModelWeight: number | null; // for CAD currency holdings
  usdModelWeight: number | null; // for USD currency holdings
};

export type PimModelData = {
  groups: PimModelGroup[];
  lastUpdated?: string;
};

// ── Performance Tracking ──

export type PimDailyReturn = {
  date: string; // YYYY-MM-DD
  value: number; // cumulative index value (starts at 100)
  dailyReturn: number; // daily % change
};

export type PimModelPerformance = {
  groupId: string;
  profile: PimProfileType;
  history: PimDailyReturn[];
  lastUpdated: string;
};

export type PimPerformanceData = {
  models: PimModelPerformance[];
  lastUpdated: string;
};
