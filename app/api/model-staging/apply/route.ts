import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { readDraftStore } from "@/app/lib/model-drafts-store";
import { applyDraft } from "@/app/lib/staged-apply";

/**
 * POST /api/model-staging/apply — write the active staged draft into pm:pim-models.
 * Body: { draftId, expectedRevision, confirm: "APPLY", groupIds?: string[] }
 *
 * In order, stopping at the first failure:
 *   1. `confirm` must be exactly "APPLY"; the draft must be the active one;
 *   2. the live revision must equal `expectedRevision` — the revision the PM
 *      reviewed the diff against. Anything else (a trade, a Review commit,
 *      another tab) → 409 and nothing is written;
 *   3. every staged model must validate (each class sums to 100%, no dupes);
 *   4. pm:pim-models is snapshotted (pm:pim-models-version:<id>) — the undo,
 *      restorable from the Review page's version history;
 *   5. each staged group's `holdings` is replaced (every other group field and
 *      every un-staged group pass through untouched); stocks staged off the
 *      per-stock rule weight are pinned; revision is bumped;
 *   6. the draft moves to history with the version id + the symbols each
 *      model exited (Positioning's Rebalance sells exactly those to zero).
 *   Three-bucket drafts (rows carry a Core / Thematic / Alpha bucket) also
 *   write `sleeveTargets` (the source model's bucket shares, from now on)
 *   and return `roles` — the bucket of every source equity name — which the
 *   client writes to pm:stocks through its normal path (this route never
 *   writes pm:stocks: the client persists that array whole, so a server write
 *   would be overwritten by the next client save).
 * Returns the per-holding diff.
 *
 * Touches pm:pim-models (read-modify-write), pm:model-drafts, and the version
 * keys. Never pm:stocks or pm:pim-positions. The write logic lives in
 * app/lib/staged-apply.ts (shared with /api/model-staging/rebalance).
 */

const log = createLogger("Model-staging-apply");

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { draftId?: string; expectedRevision?: number; confirm?: string; groupIds?: string[] };
    if (body.confirm !== "APPLY") return NextResponse.json({ error: "type APPLY to confirm" }, { status: 400 });

    const store = await readDraftStore();
    const draft = store.active;
    if (!draft || draft.id !== body.draftId) return NextResponse.json({ error: "that draft is not the active one" }, { status: 404 });

    const r = await applyDraft({ draft, expectedRevision: body.expectedRevision, groupIds: body.groupIds });
    if (!r.ok) return NextResponse.json(r.body, { status: r.status });
    return NextResponse.json({ ok: true, versionId: r.versionId, revision: r.after.revision, diff: r.diff, exits: r.exits, roles: r.roles, thematicSeries: r.thematicSeries, sleeveTargets: r.sleeveTargets });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "apply failed" }, { status: 500 });
  }
}
