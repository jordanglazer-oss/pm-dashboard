/** Client-safe types for fund one-pagers (store in fund-one-pagers.ts). */

export type FundOnePager = {
  symbol: string;
  name: string;
  /** One sentence a client can take away. */
  headline: string;
  whyWeOwn: string[];
  manager: { firm: string; team: string; since: string; philosophy: string };
  process: string;
  /** Its job in our portfolio (Core / Thematic, what it adds). */
  role: string;
  /** The record against its category / benchmark, in words, with figures. */
  record: string;
  fees: string;
  risks: string[];
  /** Short client-ready lines. */
  talkingPoints: string[];
  /** What would make us reconsider (internal). */
  watch: string;
  sources: { url: string; title?: string }[];
  aiDrafted: boolean;
  updatedAt: string;
  signedAt?: string;
  history?: { savedAt: string; headline: string; whyWeOwn: string[]; talkingPoints: string[] }[];
};

export type FundOnePagerStore = { pagers: Record<string, FundOnePager> };

/** A fund in the PIM model, with the facts the page shows beside the prose. */
export type FundRow = {
  symbol: string;
  name?: string;
  bucket: "core" | "thematic" | "fixedIncome" | "other";
  weightInClass: number;
  assetClass: string;
  facts: {
    category?: string;
    fundFamily?: string;
    expenseRatio?: number;
    aum?: number;
    starRating?: number;
    perf?: { oneYear?: number; threeYear?: number; fiveYear?: number };
    categoryPerf?: { oneYear?: number; threeYear?: number; fiveYear?: number };
    topHoldings?: { symbol: string; name: string; weight: number }[];
    asOf?: string;
  };
};
