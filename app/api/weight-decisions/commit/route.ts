import { NextRequest, NextResponse } from "next/server";
import { WEIGHT_COMMIT_ENABLED } from "@/app/lib/weight-decisions";

/**
 * POST /api/weight-decisions/commit — turn a month's decisions into model targets.
 *
 * DISABLED (WEIGHT_COMMIT_ENABLED = false). Preview and production share one
 * Redis, so a commit from the preview would change the LIVE models. When it is
 * enabled at cutover it will, in this order:
 *   1. re-run `reconcile()` server-side and refuse unless every sleeve nets to
 *      zero and no stock breaches the 10%-of-portfolio cap;
 *   2. stash the current pm:pim-models at pm:pim-models.pre-review-<ts>;
 *   3. write PIM with `applyDecisions()` and every other model with
 *      `inheritDecisions()` (read-modify-write, non-equity untouched);
 *   4. mark the month committed (stashKey recorded) in pm:weight-decisions;
 *   5. journal each set/adopt as a decision entry.
 * Requires `{ month, confirm: "COMMIT <month>" }`.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: string };
  if (!WEIGHT_COMMIT_ENABLED) {
    return NextResponse.json(
      { error: "commit is disabled on this build — decisions are saved as a draft; model targets are unchanged", month: body.month ?? null },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: "not implemented" }, { status: 501 });
}
