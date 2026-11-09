import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { WATCHERS, watcherDef, type AgentModelTier } from "./registry";

/**
 * pm:agent-settings — the PM's switches for the watchers:
 *   { models: { [watcherId]: "haiku" | "sonnet" }, off?: { [watcherId]: true },
 *     paused?: boolean, updatedAt? }
 * `models` only holds overrides; a watcher not listed runs its registry
 * default. `off` switches ONE watcher off (its model calls are refused at
 * the gateway and its rule-only flags are not raised). `paused` stops every
 * watcher at the gateway (the kill switch).
 * GET never seeds; writes are read-merge-write of one field.
 */

const log = createLogger("Agent-settings");
export const SETTINGS_KEY = "pm:agent-settings";

export type AgentSettings = {
  models?: Record<string, AgentModelTier>;
  /** Watchers the PM has switched off (absent = on). */
  off?: Record<string, true>;
  paused?: boolean;
  updatedAt?: string;
};

export function isWatcherOn(watcherId: string, settings: AgentSettings): boolean {
  return !settings.paused && !settings.off?.[watcherId];
}

export async function readAgentSettings(): Promise<AgentSettings> {
  try {
    const raw = await (await getRedis()).get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as AgentSettings) : {};
  } catch (e) {
    log.error("read failed:", e);
    // Unreadable settings → behave as paused rather than guess.
    return { paused: true };
  }
}

export function modelFor(watcherId: string, settings: AgentSettings): AgentModelTier {
  const o = settings.models?.[watcherId];
  if (o === "haiku" || o === "sonnet") return o;
  return watcherDef(watcherId)?.defaultModel ?? "haiku";
}

export async function updateAgentSettings(patch: { watcher?: string; model?: AgentModelTier | "default"; enabled?: boolean; paused?: boolean }): Promise<AgentSettings> {
  const redis = await getRedis();
  const raw = await redis.get(SETTINGS_KEY);
  const prev: AgentSettings = raw ? (JSON.parse(raw) as AgentSettings) : {};
  const next: AgentSettings = { ...prev, models: { ...(prev.models ?? {}) }, off: { ...(prev.off ?? {}) } };
  if (patch.watcher) {
    if (!WATCHERS.some((w) => w.id === patch.watcher)) throw new Error(`unknown watcher ${patch.watcher}`);
    if (typeof patch.enabled === "boolean") {
      if (patch.enabled) delete next.off![patch.watcher];
      else next.off![patch.watcher] = true;
    } else if (patch.model === "default") delete next.models![patch.watcher];
    else if (patch.model === "haiku" || patch.model === "sonnet") next.models![patch.watcher] = patch.model;
    else throw new Error("model must be haiku, sonnet or default");
  }
  if (typeof patch.paused === "boolean") next.paused = patch.paused;
  next.updatedAt = new Date().toISOString();
  await redis.set(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
