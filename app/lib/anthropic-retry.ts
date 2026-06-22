/**
 * Shared retry helper for Anthropic API calls used by scoring routes.
 *
 * Why: A single transient Anthropic failure (rate limit, gateway error,
 * server overload) shouldn't fail a Score All on 1 of 50 stocks and
 * require the PM to manually retry. Wrapping each call in 2-3 retries
 * with exponential backoff converts most transient errors into silent
 * recoveries.
 *
 * Retryable conditions (per Anthropic API conventions):
 *   - HTTP 429 (rate limit)
 *   - HTTP 500/502/503 (server error)
 *   - HTTP 529 (overloaded — Anthropic-specific)
 *   - Network errors (timeout, ECONNRESET, etc.) — surface as `code`
 *     fields or generic Error
 *
 * Non-retryable (returned/thrown as-is):
 *   - HTTP 400 (bad request — prompt is wrong, retrying won't help)
 *   - HTTP 401/403 (auth — won't fix itself)
 *   - HTTP 404 (route gone)
 *   - JSON-parse / schema-mismatch errors (caller's bug)
 *
 * The retry budget defaults to 3 attempts total (initial + 2 retries)
 * with backoff 1s, 2s. That covers the vast majority of transient
 * outages while bounding the worst-case latency at ~7 seconds per
 * stock; longer retries would let a stuck Score All take >5 minutes.
 *
 * Logs are tagged with [Anthropic-retry] so they're greppable in the
 * Vercel runtime log viewer.
 */

import { createLogger } from "./logger";
import { isCreditError, recordAnthropicCreditError } from "./anthropic-status";

const log = createLogger("Anthropic-retry");

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

function isRetryable(err: unknown): { retryable: boolean; status?: number; reason: string } {
  // Anthropic SDK errors expose `status` on the error object.
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      return {
        retryable: RETRYABLE_STATUSES.has(status),
        status,
        reason: `HTTP ${status}`,
      };
    }
  }
  // Network / timeout errors typically don't carry a status field —
  // Node fetch surfaces them as TypeError("fetch failed") with a cause.
  // Treat anything without a status as a retryable network condition;
  // the alternative is to fail-fast on what's usually transient.
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return { retryable: true, reason: `network: ${msg}` };
  }
  return { retryable: false, reason: msg };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with exponential-backoff retry on transient Anthropic
 * failures. Returns the resolved value of the first successful attempt
 * or throws the error from the last failed attempt.
 *
 * @param label  Short tag for log lines (e.g. "Score", "Score-gaps").
 *               Helps correlate retries with the stock being scored
 *               when Score All is mid-batch.
 * @param fn     The async work to run. Typically `() => client.messages.create(...)`.
 * @param maxAttempts  Total tries including the first. Defaults to 3.
 */
export async function callAnthropicWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const { retryable, reason } = isRetryable(err);
      if (!retryable || attempt === maxAttempts) {
        // Either a non-retryable error (don't waste retries) or we're
        // out of attempts. Surface the original error to the caller.
        log.error(`[${label}] giving up after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${reason}`);
        // Flag credit/billing exhaustion so the nav can surface it. Awaited
        // so the Redis write lands before the serverless fn returns; failures
        // here are swallowed inside recordAnthropicCreditError.
        if (isCreditError(err)) await recordAnthropicCreditError(`${label}: ${reason}`);
        throw err;
      }
      const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      log.warn(`[${label}] attempt ${attempt}/${maxAttempts} failed (${reason}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop either returns or throws. TypeScript needs
  // this for the return type, though.
  throw lastErr;
}
