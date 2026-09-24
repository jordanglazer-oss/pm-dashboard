import { getRedis } from "./redis";
import { createLogger } from "./logger";
import type { PimModelData } from "./pim-types";

/**
 * Versions of pm:pim-models — the undo history for every change to the models.
 *
 *   pm:pim-models-versions        index: { versions: [{ id, at, source, note, month? }] }, newest last
 *   pm:pim-models-version:<id>    the full PimModelData as it was BEFORE the write
 *
 * `snapshotModels()` is called by every server-side writer right before it
 * writes (Review commit, restore), so any version can be restored and a restore
 * is itself undoable. Named so the 14-day stash pruner (pm:*.pre-*) never
 * touches them; inside the nightly backup. Retention: RETAIN_DAYS, but never
 * fewer than MIN_KEEP entries.
 */

const INDEX_KEY = "pm:pim-models-versions";
const versionKey = (id: string) => `pm:pim-models-version:${id}`;
const RETAIN_DAYS = 730;
const MIN_KEEP = 10;
const log = createLogger("Model-versions");

export type ModelVersionMeta = { id: string; at: string; source: "review-commit" | "restore" | "manual"; note: string; month?: string; revision?: number };
export type ModelVersionIndex = { versions: ModelVersionMeta[] };

export async function listModelVersions(): Promise<ModelVersionMeta[]> {
  try {
    const raw = await (await getRedis()).get(INDEX_KEY);
    const idx = raw ? (JSON.parse(raw) as ModelVersionIndex) : { versions: [] };
    return Array.isArray(idx.versions) ? idx.versions : [];
  } catch (e) {
    log.error("index read failed:", e);
    return [];
  }
}

export async function readModelVersion(id: string): Promise<PimModelData | null> {
  if (!/^[a-z0-9-]{6,80}$/i.test(id)) return null;
  try {
    const raw = await (await getRedis()).get(versionKey(id));
    return raw ? (JSON.parse(raw) as PimModelData) : null;
  } catch {
    return null;
  }
}

/** Snapshot the CURRENT pm:pim-models under a new version id. Returns the id,
 *  or null when there is nothing to snapshot (never writes an empty version). */
export async function snapshotModels(source: ModelVersionMeta["source"], note: string, month?: string): Promise<string | null> {
  const redis = await getRedis();
  const raw = await redis.get("pm:pim-models");
  if (!raw) return null;
  let current: PimModelData;
  try { current = JSON.parse(raw) as PimModelData; } catch { return null; }
  if (!Array.isArray(current.groups) || current.groups.length === 0) return null;
  const at = new Date().toISOString();
  const id = `${at.replace(/[:.]/g, "-").slice(0, 23)}-${source}`;
  await redis.set(versionKey(id), raw); // byte-for-byte copy
  const versions = await listModelVersions();
  const next = [...versions, { id, at, source, note: note.slice(0, 200), month, revision: current.revision }];
  // Prune by age, keeping at least MIN_KEEP.
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
  const keep: ModelVersionMeta[] = [];
  const drop: ModelVersionMeta[] = [];
  for (const v of next) (Date.parse(v.at) < cutoff && next.length - drop.length > MIN_KEEP ? drop : keep).push(v);
  for (const v of drop) await redis.del(versionKey(v.id)).catch(() => {});
  await redis.set(INDEX_KEY, JSON.stringify({ versions: keep }));
  log.info(`snapshot ${id} (${source}) — ${keep.length} versions kept`);
  return id;
}

/** Per-holding weight differences between two models (equity + everything), for the restore preview. */
export function diffModels(a: PimModelData, b: PimModelData): Array<{ groupId: string; symbol: string; before: number; after: number }> {
  const out: Array<{ groupId: string; symbol: string; before: number; after: number }> = [];
  for (const ga of a.groups) {
    const gb = b.groups.find((g) => g.id === ga.id);
    for (const h of ga.holdings) {
      const hb = gb?.holdings.find((x) => x.symbol === h.symbol);
      const after = hb?.weightInClass ?? 0;
      if (Math.abs(after - h.weightInClass) > 0.00005) out.push({ groupId: ga.id, symbol: h.symbol, before: h.weightInClass, after });
    }
    for (const hb of gb?.holdings ?? []) if (!ga.holdings.some((x) => x.symbol === hb.symbol)) out.push({ groupId: ga.id, symbol: hb.symbol, before: 0, after: hb.weightInClass });
  }
  return out;
}
