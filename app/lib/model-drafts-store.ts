import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { MODEL_DRAFTS_KEY, type ModelDraftStore } from "./model-staging";

const log = createLogger("Model-drafts");

/** Read pm:model-drafts. Empty store on miss or error — never seeds. Unknown
 *  top-level fields are carried through so a writer can spread them back. */
export async function readDraftStore(): Promise<ModelDraftStore> {
  try {
    const raw = await (await getRedis()).get(MODEL_DRAFTS_KEY);
    if (!raw) return { active: null, history: [] };
    const p = JSON.parse(raw) as Partial<ModelDraftStore>;
    return { ...p, active: p.active ?? null, history: Array.isArray(p.history) ? p.history : [] };
  } catch (e) {
    log.error("read failed:", e);
    return { active: null, history: [] };
  }
}
