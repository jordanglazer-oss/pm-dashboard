/**
 * Shared writing rules spliced into every prompt whose prose the PM reads on
 * the stock page (score narratives, synthesis, thesis draft, kill-condition
 * checks, chart notes).
 *
 * Why this exists: a thesis that reads "CCS segment y/y revenue growth must
 * not fall below 60%" is only legible to someone who already knows the name's
 * segment names. The PM reads these tiles months after the draft was written,
 * and across ~100 names — the letters have to be decodable on the page.
 *
 * Two deliberate limits:
 * - Standard finance shorthand is EXEMPT. Expanding "EPS" or "free cash flow
 *   (FCF)" wastes the word budget in fields capped at 1-2 sentences and reads
 *   as condescending to a portfolio manager.
 * - The model must NEVER guess an expansion. A confidently wrong expansion of
 *   a segment name is worse than the bare acronym, so the fallback is to
 *   describe the thing in words instead.
 *
 * NOTE: including this in SCORING_PROMPT moves RUBRIC_HASH (rubric-version.ts)
 * by design — every prompt edit does. It is a presentation rule, not a scoring
 * rule, so RUBRIC_REV is unchanged.
 */

/** Finance/market shorthand that never needs expanding. */
const EXEMPT = "EPS, P/E, EV/EBITDA, FCF, ROE, ROIC, FX, YoY, QoQ, TTM, FY, DMA, RSI, MACD, ETF, GDP, CPI, M&A, IPO, capex, opex, bps, GAAP, SEC";

/**
 * Abbreviation rule. `scope` names the span over which "first use" is
 * measured, so a prompt that emits several independently-displayed fields can
 * ask for the expansion in each of them.
 */
export function abbreviationRule(scope = "your output"): string {
  return `ABBREVIATIONS: the first time a company-, segment-, product-, industry- or vendor-specific abbreviation appears in ${scope}, write it out in full with the short form in parentheses — e.g. "Connectivity & Cloud Solutions (CCS)", "Advanced Driver Assistance Systems (ADAS)" — then use the short form for the rest. Standard finance and market shorthand needs NO expansion: ${EXEMPT}. If you are not certain what the letters actually stand for, do NOT guess an expansion — name the thing in plain words instead (e.g. "the cloud-infrastructure segment") or drop the acronym.`;
}

/** Default single-scope rule for prompts that produce one block of prose. */
export const ABBREVIATION_RULE = abbreviationRule();
