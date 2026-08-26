/**
 * Client-safe types + display constants for the Synthesis screen.
 * Split from synthesis-screen.ts (which imports crypto + redis-backed
 * modules) so client components can import labels and types without
 * pulling server-only packages into the browser bundle — same pattern
 * as research-mentions-display.ts.
 */

export const WATCHLIST_VERDICTS = ["advance", "watch", "pass"] as const;
export const PORTFOLIO_VERDICTS = ["thesis-intact", "review", "exit-watch"] as const;
export type SynthesisVerdict = (typeof WATCHLIST_VERDICTS)[number] | (typeof PORTFOLIO_VERDICTS)[number];

export const VERDICT_LABEL: Record<SynthesisVerdict, string> = {
  advance: "Advance",
  watch: "Watch",
  pass: "Pass",
  "thesis-intact": "Thesis intact",
  review: "Review",
  "exit-watch": "Exit watch",
};

/** Price move (vs price at generation) that marks a synthesis stale. */
export const STALE_PRICE_MOVE_PCT = 5;

export type StaleReason = "never-generated" | "inputs-changed" | "price-move" | "earnings-passed" | "prompt-version";

export const STALE_LABEL: Record<StaleReason, string> = {
  "never-generated": "Not yet generated",
  "inputs-changed": "New analyst/research input",
  "price-move": `>${STALE_PRICE_MOVE_PCT}% price move`,
  "earnings-passed": "Earnings since last run",
  "prompt-version": "Prompt updated",
};

export type SynthesisBullet = {
  text: string;
  /** Which payload block supports the bullet (e.g. "factset", "rbc report",
   *  "street takeaways", "revisions", "technicals", "sector leadership"). */
  source: string;
};

/** One-sentence plain-English read of each case (no jargon). */
export type SynthesisPlain = { base: string; bull: string; bear: string };

export type SynthesisResult = {
  verdict: SynthesisVerdict;
  verdictReason: string; // one line
  /** Risk/reward asymmetry, −2 (bear-heavy) … +2 (bull-heavy). Sortable. */
  skew: number;
  base: SynthesisBullet[];
  bull: SynthesisBullet[];
  bear: SynthesisBullet[];
  /** Optional on entries generated before prompt v2. */
  plain?: SynthesisPlain;
  /** Dedicated price-action read (name + sector/subsector standing) — its own
   *  section so keyDebate can stay on the fundamental question. Pre-v2: absent. */
  priceAction?: string;
  /** One concrete next action consistent with the verdict. Pre-v2: absent. */
  nextStep?: string;
  keyDebate: string;
  catalysts: { date?: string; event: string }[];
  wouldChangeCall: string[];
  dataGaps: string[];
};

/** Deterministic (server-computed, not model-generated) price-target line. */
export type TargetLine = {
  source: "RBC" | "JPM" | "Street avg" | "Morningstar FVE";
  target: number;
  /** vs price at generation; null when no price was available. */
  upsidePct: number | null;
  asOf?: string;
};

export type SynthesisEntry = {
  ticker: string;
  bucket: "Portfolio" | "Watchlist";
  generatedAt: string; // ISO
  promptVersion: string;
  /** Hash of the cheap (Redis-only) inputs at generation time. */
  inputsHash: string;
  priceAtGeneration?: number;
  /** The stock's next-earnings date as known at generation time. */
  earningsDateAtGeneration?: string;
  webFillUsed: boolean;
  /** Deterministic target summary computed at generation time. Pre-v2: absent. */
  targets?: TargetLine[];
  result: SynthesisResult;
};

export type SynthesisScreenCache = Record<string, SynthesisEntry>;

export type SynthesisHistoryRow = {
  date: string; // YYYY-MM-DD (server UTC), today-only on write
  generatedAt: string;
  bucket: "Portfolio" | "Watchlist";
  verdict: SynthesisVerdict;
  skew: number;
  price?: number;
};

export type SynthesisHistory = Record<string, SynthesisHistoryRow[]>;
