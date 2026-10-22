import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { MODEL_DRAFTS_KEY, type ModelDraft } from "@/app/lib/model-staging";
import { readDraftStore } from "@/app/lib/model-drafts-store";

/**
 * pm:model-drafts — staged model changes (app/lib/model-staging.ts).
 *
 * A SEPARATE key from pm:pim-models on purpose: a draft is a proposal, and
 * nothing here can reach the live model. Applying is its own confirmed route
 * (/api/model-staging/apply), which snapshots the models first.
 *
 *   GET     → { active, history }   ({ active: null, history: [] } on miss/error — never seeds)
 *   POST    { draft }               → saves the ACTIVE draft only (read-merge-write; history untouched).
 *                                     Refused when the stored active draft is a different id
 *                                     unless `replace: true` (so a stale tab can't clobber a newer draft).
 *   DELETE  ?id=                    → discards the active draft if it has that id. History is kept.
 */

const log = createLogger("Model-drafts");

export async function GET() {
  return NextResponse.json(await readDraftStore());
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { draft?: ModelDraft; replace?: boolean };
    const d = body.draft;
    if (!d || typeof d.id !== "string" || !d.sourceGroupId || !d.models || typeof d.models !== "object" || !Array.isArray(d.parsed)) {
      return NextResponse.json({ error: "draft { id, sourceGroupId, parsed[], models{} } required" }, { status: 400 });
    }
    const store = await readDraftStore();
    if (store.active && store.active.id !== d.id && !body.replace) {
      return NextResponse.json({ error: "another draft is active", active: store.active }, { status: 409 });
    }
    const now = new Date().toISOString();
    const next: ModelDraft = { ...d, status: "draft", createdAt: d.createdAt || now, updatedAt: now };
    await (await getRedis()).set(MODEL_DRAFTS_KEY, JSON.stringify({ ...store, active: next }));
    return NextResponse.json({ ok: true, draft: next });
  } catch (e) {
    log.error("write failed:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const store = await readDraftStore();
    if (!store.active || store.active.id !== id) return NextResponse.json({ ok: true, removed: 0 });
    await (await getRedis()).set(MODEL_DRAFTS_KEY, JSON.stringify({ ...store, active: null }));
    return NextResponse.json({ ok: true, removed: 1 });
  } catch (e) {
    log.error("delete failed:", e);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
