/**
 * Score-route prompt fragments — every instruction string the /api/score route
 * splices into the user message OUTSIDE the master SCORING_PROMPT.
 *
 * Why a separate module: app/lib/rubric-version.ts hashes the scoring prompt +
 * sector playbooks so that any behavioral edit produces a new RUBRIC_HASH and
 * pm:score-history never silently merges two scoring regimes. But instruction
 * text that lives as string literals inside route.ts (the prior-score anchor,
 * partial-rescore mode, degraded-run and Canadian-listing notes) shifts scoring
 * behavior just the same — and was invisible to the hash. Everything here is
 * included in the hash input via SCORE_ROUTE_FRAGMENTS_HASH_INPUT below.
 *
 * Editing rules:
 * - Behavioral edits to any fragment are a rubric change; the hash moves
 *   automatically, but bump RUBRIC_REV too when the change is material.
 * - Keep fragments free of imports from route files (rubric-version.ts loads
 *   this module at boot; it must stay dependency-light and cycle-free).
 */

/** Appended when FactSet was expected but unavailable and the caller opted
 *  into a degraded (Yahoo-graded) run via allowDegraded. */
export const DEGRADED_RUN_NOTE = `\n\n---\n\n=== SOURCE HEALTH: DEGRADED RUN ===\nFactSet was expected for this name but was unavailable after retries — the fundamental categories below are graded from Yahoo fallback data. Cap confidence at "medium" for growth, relativeValuation, historicalValuation, leverageCoverage, and cashFlowQuality, and begin each of those explanation summaries with "YAHOO-FALLBACK RUN:" so the PM knows a FactSet-backed rescore may read differently.`;

/** Appended for Canadian-only listings with no EDGAR coverage. */
export function noEdgarCanadianNote(ticker: string): string {
  return `\n\n---\n\n=== NO SEC EDGAR DATA AVAILABLE ===\n${ticker} is a Canadian-only listing (no US dual-listing in the SEC ticker map). SEC EDGAR XBRL data is unavailable for this issuer.\n\nFor fundamental categories (growth, leverageCoverage, cashFlowQuality, relativeValuation, historicalValuation), use the FactSet block above as the primary source (or Yahoo when FactSet is absent) and use web_search to verify against the company's MOST RECENT quarterly MD&A or earnings press release (cite the IR-page or SEDAR+ filing URL in sourceDetail). For ownershipTrends: no SEDI insider feed is available — the category is excluded from this name's composite server-side; emit only the brief DATA GAP explanation per the system prompt. Do not pretend Form 4-style data exists when it doesn't.\n`;
}

/** Appended in partial-rescore mode (body.categories) — restricts the model
 *  to the requested LLM categories and freezes the narrative fields. */
export function partialRescoreNote(keys: string[]): string {
  return `\n\n=== PARTIAL RESCORE MODE ===\nScore ONLY these categories: ${keys.join(", ")}.\nIn the "scores" and "explanations" JSON objects include ONLY those keys — every other category is carried forward unchanged server-side, so do NOT include them.\nSkip the narrative fields entirely: return empty strings for companySummary, investmentThesis, and bearCase (they are preserved from the last full rescore and must not be rewritten by a partial pass).\nStill return name, sector, and beta as usual.`;
}

// ── Prior-score anchor ─────────────────────────────────────────────────────
//
// Replaces the 2026-05 "treat these as your prior / AFFIRM unless something
// changed" block, which had three bias mechanisms: it passed bare numbers with
// no evidence (deference, not continuity), it ignored rubric-era boundaries
// (old-rubric scores survived rubric fixes), and its change rule was
// event-shaped (slow drift never cleared the bar). The reconciliation protocol
// below keeps the anti-oscillation benefit — band-ambiguous categories stay
// put — while requiring independent re-derivation first.

/** A prior category line as rendered into the anchor block. */
export type PriorCategoryLine = {
  key: string;
  score: number;
  max: number;
  confidence?: string;
  /** Truncated (~200 chars) explanation summary from the last rescore. */
  summary?: string;
};

/** Prior older than this many days is context-only: case (c) retention no
 *  longer applies and every category is derived fresh. */
export const ANCHOR_MAX_AGE_DAYS = 90;

export function buildPriorAnchorBlock(args: {
  ageLabel: string;
  ageDays: number | null;
  lines: PriorCategoryLine[];
  priorComposite?: string;
}): string {
  const { ageLabel, ageDays, lines, priorComposite } = args;
  const stale = ageDays != null && ageDays > ANCHOR_MAX_AGE_DAYS;
  const rendered = lines
    .map((l) => {
      const conf = l.confidence ? ` [confidence: ${l.confidence}]` : "";
      const sum = l.summary ? ` — "${l.summary}"` : "";
      return `  ${l.key}: ${l.score}/${l.max}${conf}${sum}`;
    })
    .join("\n");
  const header = `\n\n---\n\n=== PRIOR SCORE (${ageLabel}, same rubric${priorComposite ? `, composite ${priorComposite}` : ""}) ===\nOnly the categories you are asked to score are listed; each with the evidence summary it was based on:\n${rendered}\n`;
  if (stale) {
    return `${header}\nThis prior is over ${ANCHOR_MAX_AGE_DAYS} days old — treat it as CONTEXT ONLY. Derive every category fresh from the rubric bands and the data above. Where your score differs from the stale prior, briefly note the difference in the explanation summary, but do NOT retain a prior value merely because the evidence is ambiguous.`;
  }
  return `${header}\nRECONCILIATION PROTOCOL:\n1. FIRST, score each category from the rubric bands and the data above WITHOUT reference to the prior.\n2. THEN compare each category to the prior and classify any difference in the explanation summary:\n   (a) NEW DATA — the facts changed since the prior; keep your new score and name the specific change (e.g. "Q3 revenue growth decelerated to 8% YoY from 14%").\n   (b) PRIOR MISREAD — the facts are unchanged but the prior misapplied the bands; keep your new score and say so explicitly.\n   (c) BAND AMBIGUITY — the evidence genuinely supports either value; ADOPT THE PRIOR score and note "prior retained (band-ambiguous)".\nDefault to the prior ONLY in case (c). Never retain a prior score you cannot defend from the evidence in front of you, and never move a score without classifying the difference.`;
}

/** Appended instead of the anchor when the last score predates the current
 *  rubric (rubricHash mismatch or missing) — old-rubric priors must not
 *  survive rubric fixes by anchoring. */
export const RUBRIC_CHANGED_NOTE = `\n\n---\n\n=== NO PRIOR ANCHOR ===\nThis name was last scored under a DIFFERENT rubric revision, so no prior scores are provided. Derive every category fresh from the current rubric bands and the data above.`;

// ── Hash input ─────────────────────────────────────────────────────────────
// Deterministic concatenation of every fragment (functions rendered with
// fixed sentinel args) so rubric-version.ts can fold this module into
// RUBRIC_HASH. Any behavioral edit above moves the hash on the next deploy.
export const SCORE_ROUTE_FRAGMENTS_HASH_INPUT = [
  DEGRADED_RUN_NOTE,
  noEdgarCanadianNote("<TICKER>"),
  partialRescoreNote(["<keys>"]),
  buildPriorAnchorBlock({
    ageLabel: "<age>",
    ageDays: 1,
    lines: [{ key: "<key>", score: 0, max: 1, confidence: "<c>", summary: "<s>" }],
    priorComposite: "<n>",
  }),
  buildPriorAnchorBlock({ ageLabel: "<age>", ageDays: ANCHOR_MAX_AGE_DAYS + 1, lines: [] }),
  RUBRIC_CHANGED_NOTE,
].join("\n===\n");
