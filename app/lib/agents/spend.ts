import type Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { AGENT_MODEL_IDS, WATCHERS, type AgentModelTier } from "./registry";

/**
 * Spend counter for the agents key.
 *
 * The Anthropic workspace has a hard $100/month limit; the gateway stops
 * itself at STOP_USD so a watcher never runs into that wall mid-task (and so
 * there is headroom for a call already in flight). Costs are computed from
 * each response's `usage` at list price.
 *
 * Storage — atomic string counters (INCRBYFLOAT), one set per UTC month:
 *   pm:agent-spend:<YYYY-MM>:total          dollars
 *   pm:agent-spend:<YYYY-MM>:usd:<watcher>  dollars
 *   pm:agent-spend:<YYYY-MM>:calls:<watcher> count
 * Atomic so two watchers finishing together can never lose an increment, and
 * plain strings so the nightly backup (which GETs every key) reads them.
 * Plus pm:agent-calls — the last 200 calls (JSON, read-merge-write; a lost
 * entry under a race only drops a log line, never a dollar).
 */

const log = createLogger("Agent-spend");

export const CAP_USD = 100;
export const STOP_USD = 90;
const CALL_LOG_KEY = "pm:agent-calls";
const CALL_LOG_MAX = 200;

/** List prices, $ per million tokens (checked Nov 2026). */
const PRICES: Record<AgentModelTier, { input: number; output: number; longInput?: number; longOutput?: number; longAbove?: number }> = {
  sonnet: { input: 2, output: 10 },
  // Haiku 5.5 is $0.10 / $0.50 up to a 100k-token prompt, $0.50 / $2.50 beyond.
  haiku: { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longAbove: 100_000 },
};
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;
const WEB_SEARCH_USD = 10 / 1000;

export function tierOfModel(model: string): AgentModelTier {
  return model === AGENT_MODEL_IDS.haiku || model.startsWith("claude-haiku") ? "haiku" : "sonnet";
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Dollar cost of one response. */
export function costOfUsage(model: string, usage: Anthropic.Usage): number {
  const p = PRICES[tierOfModel(model)];
  const input = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const prompt = input + cacheWrite + cacheRead;
  const long = p.longAbove != null && prompt > p.longAbove;
  const inRate = (long ? p.longInput : undefined) ?? p.input;
  const outRate = (long ? p.longOutput : undefined) ?? p.output;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (input * inRate + cacheWrite * inRate * CACHE_WRITE_MULT + cacheRead * inRate * CACHE_READ_MULT + (usage.output_tokens ?? 0) * outRate) / 1e6 +
    searches * WEB_SEARCH_USD
  );
}

/** Worst-case cost of a call before it runs — prompt estimated from its size
 *  (~3.5 characters a token), output at the full max_tokens, plus the
 *  allowed searches. Used to refuse a call that could cross the stop line. */
export function worstCaseCost(model: string, promptChars: number, maxTokens: number, maxSearches = 0): number {
  const p = PRICES[tierOfModel(model)];
  const promptTokens = Math.ceil(promptChars / 3.5);
  const long = p.longAbove != null && promptTokens > p.longAbove;
  const inRate = (long ? p.longInput : undefined) ?? p.input;
  const outRate = (long ? p.longOutput : undefined) ?? p.output;
  // Searches pull pages into the prompt; allow ~10k tokens per search.
  const searchTokens = maxSearches * 10_000;
  return ((promptTokens + searchTokens) * inRate + maxTokens * outRate) / 1e6 + maxSearches * WEB_SEARCH_USD;
}

const k = (month: string, suffix: string) => `pm:agent-spend:${month}:${suffix}`;

export async function monthSpend(month = monthKey()): Promise<number> {
  try {
    const raw = await (await getRedis()).get(k(month, "total"));
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    log.error("read failed:", e);
    // Unknown spend → treat as at the stop line so nothing runs blind.
    return STOP_USD;
  }
}

export type CallLogEntry = {
  at: string;
  watcher: string;
  model: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  note?: string;
};

export async function recordSpend(entry: CallLogEntry): Promise<void> {
  try {
    const redis = await getRedis();
    const month = monthKey(new Date(entry.at));
    const usd = Math.max(0, entry.usd);
    await Promise.all([
      redis.incrByFloat(k(month, "total"), usd),
      redis.incrByFloat(k(month, `usd:${entry.watcher}`), usd),
      redis.incr(k(month, `calls:${entry.watcher}`)),
    ]);
    let calls: CallLogEntry[] = [];
    try {
      const raw = await redis.get(CALL_LOG_KEY);
      if (raw) calls = JSON.parse(raw) as CallLogEntry[];
    } catch {
      calls = [];
    }
    calls.push({ ...entry, usd: Math.round(usd * 1e6) / 1e6 });
    if (calls.length > CALL_LOG_MAX) calls = calls.slice(-CALL_LOG_MAX);
    await redis.set(CALL_LOG_KEY, JSON.stringify(calls));
  } catch (e) {
    // Never lose the call's result over a ledger write; log loudly instead.
    log.error("record failed:", entry.watcher, entry.usd, e);
  }
}

export type SpendSummary = {
  month: string;
  totalUsd: number;
  capUsd: number;
  stopUsd: number;
  stopped: boolean;
  byWatcher: { id: string; usd: number; calls: number }[];
  recent: CallLogEntry[];
};

export async function spendSummary(month = monthKey()): Promise<SpendSummary> {
  const redis = await getRedis();
  const ids = WATCHERS.map((w) => w.id);
  const keys = [k(month, "total"), ...ids.map((id) => k(month, `usd:${id}`)), ...ids.map((id) => k(month, `calls:${id}`))];
  const vals = await redis.mGet(keys);
  const num = (v: string | null | undefined) => {
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  const totalUsd = num(vals[0]);
  let recent: CallLogEntry[] = [];
  try {
    const raw = await redis.get(CALL_LOG_KEY);
    if (raw) recent = (JSON.parse(raw) as CallLogEntry[]).slice(-20).reverse();
  } catch {
    recent = [];
  }
  return {
    month,
    totalUsd,
    capUsd: CAP_USD,
    stopUsd: STOP_USD,
    stopped: totalUsd >= STOP_USD,
    byWatcher: ids.map((id, i) => ({ id, usd: num(vals[1 + i]), calls: num(vals[1 + ids.length + i]) })),
    recent,
  };
}
