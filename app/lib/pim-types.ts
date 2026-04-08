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

export type PimProfileType = "balanced" | "growth" | "allEquity" | "alpha";
export type AppendixProfileType = PimProfileType;

// ── Appendix: Immutable Daily Value Ledger ──

export type AppendixDailyValue = {
  date: string;       // YYYY-MM-DD
  value: number;      // cumulative index value
  dailyReturn: number; // daily % change
  addedAt: string;    // ISO timestamp when this entry was recorded
};

export type AppendixModelLedger = {
  profile: AppendixProfileType;
  entries: AppendixDailyValue[];
};

export type AppendixData = {
  ledgers: AppendixModelLedger[];
};

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
  weightInPortfolio: number; // weightInClass × asset class allocation (target)
  cadModelWeight: number | null; // for CAD currency holdings
  usdModelWeight: number | null; // for USD currency holdings
  liveWeight?: number; // current drifted weight based on price changes
  driftBps?: number; // drift in basis points (live - target)
  currentPrice?: number; // latest price
  rebalancePrice?: number; // price at last rebalance
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

// ── Position / Holdings Data ──

export type PimPosition = {
  symbol: string;
  units: number; // shares or fund units held
  costBasis: number; // average cost per unit in account currency
};

export type PimPortfolioPositions = {
  groupId: string;
  profile: PimProfileType;
  positions: PimPosition[];
  cashBalance: number; // cash & dividends
  lastUpdated: string;
};

// ── Portfolio State (rebalance snapshots, transactions) ──

export type PimRebalanceSnapshot = {
  date: string; // ISO date of rebalance
  prices: Record<string, number>; // symbol → price at rebalance time
};

export type PimTransaction = {
  id: string;
  date: string; // ISO datetime
  groupId: string;
  type: "rebalance" | "buy" | "sell" | "switch";
  symbol: string;
  direction: "buy" | "sell";
  price: number; // execution price entered by user
  targetWeight: number; // model target weight at time of trade
  notes?: string;
  pairedWith?: string; // for switch: the other symbol in the pair
};

export type PimModelGroupState = {
  groupId: string;
  lastRebalance: PimRebalanceSnapshot | null;
  trackingStart: PimRebalanceSnapshot | null; // for forward performance
  transactions: PimTransaction[];
};

export type PimPortfolioState = {
  groupStates: PimModelGroupState[];
  lastUpdated: string;
};
