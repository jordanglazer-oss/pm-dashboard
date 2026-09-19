/**
 * Content-derived rubric version (audit Finding 12).
 *
 * pm:score-history is append-only and is the evidence base the calibration
 * engine reads. The manual RUBRIC_REV integer (score-history route) relies on
 * a human remembering to bump it when the prompt changes; if an edit ships
 * without the bump, two incompatible scoring regimes silently merge into one
 * series and calibration stops meaning anything — undetectably.
 *
 * RUBRIC_HASH closes that hole: an 8-char sha256 of the master scoring prompt
 * plus every sector-playbook body, computed at module load. Any material OR
 * accidental edit to either produces a new hash on the next deploy, and every
 * score-history entry appended after that carries it. Calibration should
 * group by (rubricRev, rubricHash) — the integer stays as the human-readable
 * era label; the hash catches the forgotten bumps.
 */
import { createHash } from "crypto";
import { SCORING_PROMPT } from "./scoring-prompt";
import { ALL_PLAYBOOK_BODIES } from "./sector-playbook";
import { SCORE_ROUTE_FRAGMENTS_HASH_INPUT } from "./score-prompt-fragments";
import { sectorPlaybookBlock } from "./sector-playbook";
import { formatValuationBandForPrompt } from "./valuation-band";
import { formatAdverseFlagsForPrompt } from "./edgar-adverse";
import { GROWTH_WEIGHTS, GROWTH_CUTS, TOP_MARK_FLOOR_PCT, MIN_GROUP_SIZE, REVISION_TRIGGER_PCT, GROUP_METRIC_RULES } from "./growth-score";

/** Current scoring-rubric regime — the human-readable era label. Bump when
 *  the rubric changes materially (era meanings documented on the rubricRev
 *  field in app/api/kv/score-history/route.ts). Lives here, not in the KV
 *  route, so non-route writers (auto-rescore) can stamp it too. */
export const RUBRIC_REV = 7;

const SENTINEL_BAND = { formula: "FG_PE", years: 5, n: 60, current: 1, percentile: 50, min: 1, p25: 1, median: 1, p75: 1, max: 1 } as unknown as Parameters<typeof formatValuationBandForPrompt>[0];
const FORMATTER_HASH_INPUT = [
  sectorPlaybookBlock("Industrials", "Machinery", null)?.split("\n").slice(0, 3).join("\n") ?? "",
  formatValuationBandForPrompt(SENTINEL_BAND, true),
  formatValuationBandForPrompt(SENTINEL_BAND, false),
  formatAdverseFlagsForPrompt([{ kind: "restatement", filingDate: "<date>" } as unknown as Parameters<typeof formatAdverseFlagsForPrompt>[0][number]]),
  JSON.stringify({ GROWTH_WEIGHTS, GROWTH_CUTS, TOP_MARK_FLOOR_PCT, MIN_GROUP_SIZE, REVISION_TRIGGER_PCT, GROUP_METRIC_RULES }),
].join("\n===\n");

export const RUBRIC_HASH = createHash("sha256")
  .update(SCORING_PROMPT)
  .update(ALL_PLAYBOOK_BODIES)
  // Route-level instruction fragments (prior-score anchor, partial mode,
  // degraded/Canadian notes) — behavioral text that used to live as literals
  // inside route.ts, invisible to the hash. See score-prompt-fragments.ts.
  .update(SCORE_ROUTE_FRAGMENTS_HASH_INPUT)
  // Rev 7 (audit finding X-04): instruction text that rides inside the DATA
  // blocks shapes scoring just as the master prompt does. Each formatter is
  // rendered with fixed sentinel inputs so an edit to its wording moves the
  // hash; the growth-score parameters are hashed for the same reason.
  .update(FORMATTER_HASH_INPUT)
  .digest("hex")
  .slice(0, 8);
