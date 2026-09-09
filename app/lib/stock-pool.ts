/**
 * Per-ticker record lookup across BOTH stock stores.
 *
 * `pm:stocks` is the book. `pm:stocks-suggested` holds the funnel's staging
 * records (see suggested-stocks.ts for why they are a separate key). A path
 * that asks "what do we know about this ticker" — scoring, above all — has to
 * see either, or a Suggested name scores with no sector, no prior anchor and no
 * BoostedAI/SIA inputs even though the data is sitting right there.
 *
 * The BOOK ALWAYS WINS on a collision. Read-only: nothing here writes.
 *
 * Do NOT use this to answer "what do we hold / watch" — that is `bookStocks()`
 * over `pm:stocks`, and staging names must stay out of it.
 */

import { getRedis } from "./redis";
import type { Stock } from "./types";
import { SUGGESTED_STOCKS_KEY } from "./suggested-stocks";

function parseArray(raw: string | null): Stock[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Stock[]) : [];
  } catch {
    return [];
  }
}

/** Book records first, then staging records the book doesn't already cover. */
export async function readStockPool(): Promise<Stock[]> {
  try {
    const redis = await getRedis();
    const [bookRaw, suggestedRaw] = await Promise.all([
      redis.get("pm:stocks"),
      redis.get(SUGGESTED_STOCKS_KEY),
    ]);
    const book = parseArray(bookRaw);
    const seen = new Set(book.map((s) => (s.ticker || "").toUpperCase()));
    const staging = parseArray(suggestedRaw).filter((s) => !seen.has((s.ticker || "").toUpperCase()));
    return [...book, ...staging];
  } catch {
    return [];
  }
}

/** The record for one ticker, book first. Case-insensitive, exact ticker. */
export function findInPool<T extends { ticker?: string }>(pool: T[], ticker: string): T | undefined {
  const upper = ticker.toUpperCase();
  return pool.find((s) => (s.ticker || "").toUpperCase() === upper);
}
