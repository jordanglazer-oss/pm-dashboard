/** Client-safe types for the PM Monthly facts (built in pm-monthly-data.ts). */

export type MonthMover = {
  symbol: string;
  name?: string;
  bucket: string;
  assetClass: string;
  weightInClass: number;
  /** Total return for the month in C$, %. */
  returnPct: number;
  /** weightInClass × returnPct, in percentage points of the class. */
  contributionPts: number;
};

export type MonthFacts = {
  month: string;
  start: string;
  end: string;
  through: string;
  partialMonth: boolean;
  modelReturns: { profile: string; returnPct: number; through: string; partial?: boolean }[];
  indexReturns: { label: string; returnPct: number | null }[];
  contributors: MonthMover[];
  detractors: MonthMover[];
  allMovers: MonthMover[];
  activity: {
    trades: { date: string; symbol: string; name?: string; kind: string; target: number | null; notes?: string }[];
    rebalanceDays: string[];
    modelChanges: { date: string; note: string }[];
    journal: { date: string; ticker?: string; action: string; rationale: string }[];
  };
  outlook: { regime: string | null; bottomLine: string | null; tactical: string | null; cyclical: string | null; structural: string | null; briefDate: string | null };
  method: string;
};

export type MonthlyDraft = {
  month: string;
  /** Plain text: "## Heading", "### Subheading", blank line between paragraphs. */
  en: string;
  fr: string;
  /** The PM's own notes for the month (what we did and why). */
  notes: string;
  aiDrafted: boolean;
  sources: { url: string; title?: string }[];
  updatedAt: string;
  history?: { savedAt: string; en: string; fr: string }[];
};
