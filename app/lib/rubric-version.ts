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

export const RUBRIC_HASH = createHash("sha256")
  .update(SCORING_PROMPT)
  .update(ALL_PLAYBOOK_BODIES)
  .digest("hex")
  .slice(0, 8);
