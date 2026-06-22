/**
 * Anthropic credit/billing health tracking.
 *
 * The Anthropic API exposes no balance endpoint, so we can't show how many
 * dollars are left. What we CAN do is notice the specific error the API
 * returns when the org runs out of credit and surface it loudly in the nav,
 * so a silently-broken Brief / scoring run becomes an obvious "credits
 * exhausted" alert instead of a mystery.
 *
 * Stored at pm:anthropic-status:
 *   { state: "ok" | "credit_exhausted", at: ISO, detail?: string }
 *
 * Written ONLY on a real API result from a live call path (scoring + Brief),
 * never by a probe — checking the balance must not itself cost tokens.
 */

import { getRedis } from "./redis";

const KEY = "pm:anthropic-status";

export type AnthropicStatus = {
  state: "ok" | "credit_exhausted";
  at: string;
  detail?: string;
};

/**
 * True when `err` is Anthropic's "out of credit" / billing rejection — a
 * 400/403 whose message names the credit balance. This is distinct from a
 * transient 429 rate-limit (which retries) and from a 401 bad-key error.
 */
export function isCreditError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  const statusNum = typeof status === "number" ? status : undefined;
  // Pull the message from the common shapes the SDK throws.
  const e = err as { message?: unknown; error?: { error?: { message?: unknown } } };
  const msg = [
    typeof e.message === "string" ? e.message : "",
    typeof e.error?.error?.message === "string" ? e.error.error.message : "",
  ].join(" ").toLowerCase();
  const looksLikeCredit = /credit balance is too low|credit balance|insufficient credit|billing/.test(msg);
  // Credit errors come back as 400 (most common) or 403; require the message
  // match so we don't mis-flag an unrelated 400 (bad prompt) as exhaustion.
  return looksLikeCredit && (statusNum === undefined || statusNum === 400 || statusNum === 402 || statusNum === 403);
}

/** Record that the API rejected a call for lack of credit. Best-effort. */
export async function recordAnthropicCreditError(detail?: string): Promise<void> {
  try {
    const redis = await getRedis();
    const status: AnthropicStatus = {
      state: "credit_exhausted",
      at: new Date().toISOString(),
      detail: detail?.slice(0, 300),
    };
    await redis.set(KEY, JSON.stringify(status));
  } catch {
    // Never let status bookkeeping break the actual request flow.
  }
}

/**
 * Mark the key healthy again — but only TRANSITION (read-then-write) so a
 * successful call doesn't hammer Redis with a write every time. Call from a
 * low-frequency success path (the Brief), so the chip clears automatically
 * once a working key is in place.
 */
export async function markAnthropicHealthy(): Promise<void> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return; // nothing recorded → already implicitly healthy
    const cur = JSON.parse(raw) as AnthropicStatus;
    if (cur.state === "ok") return; // no change → no write
    await redis.set(KEY, JSON.stringify({ state: "ok", at: new Date().toISOString() } satisfies AnthropicStatus));
  } catch {
    // ignore
  }
}

/** Read the current status (null when nothing has ever been recorded). */
export async function getAnthropicStatus(): Promise<AnthropicStatus | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AnthropicStatus;
  } catch {
    return null;
  }
}
