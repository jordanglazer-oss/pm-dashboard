import { randomUUID } from "crypto";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { watcherDef } from "./registry";

/**
 * The watchers' flag log — everything a watcher raises for the PM.
 *
 * Storage: ONE key per flag, `pm:agent-flag:<id>` (a JSON string), listed by
 * SCAN. One key per flag so two watchers raising at once can never overwrite
 * each other (a single shared blob would lose one of them), and plain strings
 * so the nightly backup (GET on every key) captures them. Nothing here is
 * ever deleted — a resolved flag stays as the record of what was raised and
 * what the PM did.
 *
 * Writers: `raiseFlag` (watchers, server-side only — there is no client
 * route that creates a flag) and `updateFlag` (the PM's Act / Dismiss /
 * Reopen / note from the Monitor page; later a watcher's thread reply).
 * Watchers flag and suggest; nothing in here trades or changes data.
 */

const log = createLogger("Agent-flags");
const PREFIX = "pm:agent-flag:";

export type FlagPriority = "high" | "medium" | "low";
export type FlagStatus = "open" | "acted" | "dismissed";

export type FlagMessage = { at: string; from: "pm" | "watcher"; text: string };

export type AgentFlag = {
  id: string;
  watcher: string;
  createdAt: string;
  updatedAt: string;
  priority: FlagPriority;
  ticker?: string;
  title: string;
  /** What was found, in plain language. */
  detail: string;
  /** What the watcher suggests the PM consider (never an instruction). */
  suggestion?: string;
  evidence?: { label: string; url?: string }[];
  /** Same open dedupeKey → the existing flag is updated, not duplicated. */
  dedupeKey?: string;
  status: FlagStatus;
  resolvedAt?: string;
  thread: FlagMessage[];
  /** Which model wrote it — for the comparison period. */
  model?: string;
};

export type RaiseFlagInput = Pick<AgentFlag, "watcher" | "priority" | "title" | "detail"> &
  Partial<Pick<AgentFlag, "ticker" | "suggestion" | "evidence" | "dedupeKey" | "model">>;

const key = (id: string) => `${PREFIX}${id}`;
const ID_RE = /^[a-z0-9-]{8,64}$/;

async function scanFlagKeys(): Promise<string[]> {
  const redis = await getRedis();
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 500 })) {
    if (Array.isArray(k)) keys.push(...k);
    else keys.push(k);
  }
  return keys;
}

/** Every flag, newest first. [] on a read error — never seeds. */
export async function listFlags(): Promise<AgentFlag[]> {
  try {
    const keys = await scanFlagKeys();
    if (keys.length === 0) return [];
    const vals = await (await getRedis()).mGet(keys);
    const out: AgentFlag[] = [];
    for (const v of vals) {
      if (!v) continue;
      try {
        out.push(JSON.parse(v) as AgentFlag);
      } catch {
        /* skip a corrupt entry rather than fail the list */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (e) {
    log.error("list failed:", e);
    return [];
  }
}

export async function getFlag(id: string): Promise<AgentFlag | null> {
  if (!ID_RE.test(id)) return null;
  const raw = await (await getRedis()).get(key(id));
  return raw ? (JSON.parse(raw) as AgentFlag) : null;
}

/**
 * Raise a flag. If an OPEN flag with the same dedupeKey exists, it is
 * refreshed in place (detail, suggestion, evidence, priority) with a note in
 * its thread — the PM sees one flag that evolves, not a pile of repeats.
 */
export async function raiseFlag(input: RaiseFlagInput): Promise<AgentFlag> {
  if (!watcherDef(input.watcher)) throw new Error(`unknown watcher ${input.watcher}`);
  const redis = await getRedis();
  const now = new Date().toISOString();

  if (input.dedupeKey) {
    const existing = (await listFlags()).find((f) => f.status === "open" && f.dedupeKey === input.dedupeKey);
    if (existing) {
      const next: AgentFlag = {
        ...existing,
        priority: input.priority,
        title: input.title,
        detail: input.detail,
        suggestion: input.suggestion ?? existing.suggestion,
        evidence: input.evidence ?? existing.evidence,
        model: input.model ?? existing.model,
        updatedAt: now,
        thread: [...existing.thread, { at: now, from: "watcher", text: `Updated: ${input.detail}` }],
      };
      await redis.set(key(existing.id), JSON.stringify(next));
      return next;
    }
  }

  const flag: AgentFlag = {
    id: randomUUID(),
    watcher: input.watcher,
    createdAt: now,
    updatedAt: now,
    priority: input.priority,
    ...(input.ticker ? { ticker: input.ticker.toUpperCase() } : {}),
    title: input.title,
    detail: input.detail,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.evidence?.length ? { evidence: input.evidence } : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.model ? { model: input.model } : {}),
    status: "open",
    thread: [],
  };
  // NX: a fresh UUID never collides, but never overwrite an existing flag.
  await redis.set(key(flag.id), JSON.stringify(flag), { NX: true });
  return flag;
}

export type FlagUpdate =
  | { action: "act" | "dismiss" | "reopen"; note?: string }
  | { action: "note"; note: string; from?: "pm" | "watcher" };

/** The PM's Act / Dismiss / Reopen / note. Read-modify-write of ONE flag,
 *  keeping every field it doesn't change. */
export async function updateFlag(id: string, u: FlagUpdate): Promise<AgentFlag | null> {
  const flag = await getFlag(id);
  if (!flag) return null;
  const now = new Date().toISOString();
  const note = u.note?.trim().slice(0, 4000);
  const next: AgentFlag = { ...flag, thread: [...(flag.thread ?? [])], updatedAt: now };

  if (u.action === "note") {
    if (!note) throw new Error("note required");
    next.thread.push({ at: now, from: u.from ?? "pm", text: note });
  } else {
    const status: FlagStatus = u.action === "act" ? "acted" : u.action === "dismiss" ? "dismissed" : "open";
    next.status = status;
    if (status === "open") delete next.resolvedAt;
    else next.resolvedAt = now;
    const verb = u.action === "act" ? "Acted on" : u.action === "dismiss" ? "Dismissed" : "Reopened";
    next.thread.push({ at: now, from: "pm", text: note ? `${verb}: ${note}` : verb });
  }
  await (await getRedis()).set(key(id), JSON.stringify(next));
  return next;
}
