/**
 * SPY put quotes from the Market Data API (marketdata.app, key in
 * MARKET_DATA_API). Replaces the CBOE delayed chain, which blocks automated
 * requests since Nov 2026. READ-ONLY: no Redis, the key never leaves the server.
 *
 * Billing is one credit per option contract returned, so every request names
 * ONE expiry and ONE strike — never a whole chain. A Hedging refresh is about
 * 30 credits (2 look-ups + 3 strikes × 9 months), plus 9 per custom strike.
 *
 * Freshness depends on the plan: a paid Starter plan is 15 minutes delayed; a
 * free plan or a trial returns the last fully closed session. Every quote
 * carries its own time (`updated`), which callers must show — never assume
 * the prices are from now.
 */

const BASE = "https://api.marketdata.app/v1";

export type MdPut = {
  bid?: number;
  ask?: number;
  last?: number;
  /** Unix seconds of the quote. */
  updated?: number;
  /** SPY price at the quote's time. */
  underlying?: number;
};

type Body = Record<string, unknown> & { s?: string; errmsg?: string };

async function md(path: string): Promise<Body | null> {
  const key = process.env.MARKET_DATA_API;
  if (!key) throw new Error("Market Data key (MARKET_DATA_API) is not set");
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(9000),
  });
  // 203 = served from their cache; same as 200. 204 / 404 = nothing for this contract.
  if (res.status === 204 || res.status === 404) return null;
  if (res.status !== 200 && res.status !== 203) throw new Error(`Market Data returned ${res.status}`);
  const body = (await res.json().catch(() => null)) as Body | null;
  if (!body || body.s === "no_data") return null;
  if (body.s === "error") throw new Error("Market Data error: " + (body.errmsg ?? "unknown"));
  return body;
}

const first = (b: Body, k: string): number | undefined => {
  const v = (b[k] as unknown[] | undefined)?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Listed SPY option expiry dates (YYYY-MM-DD), ascending. */
export async function spyExpirations(): Promise<string[]> {
  const b = await md("/options/expirations/SPY/");
  const list = (b?.expirations as unknown[] | undefined) ?? [];
  return list.filter((e): e is string => typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
}

/** Latest SPY price on the plan's feed; null when unavailable. */
export async function spySpot(): Promise<number | null> {
  const b = await md("/stocks/quotes/SPY/");
  if (!b) return null;
  return first(b, "last") ?? first(b, "mid") ?? null;
}

/** One SPY put. Null when that exact (expiry, strike) is not listed. */
export async function spyPut(expiry: string, strike: number): Promise<MdPut | null> {
  const b = await md(`/options/chain/SPY/?expiration=${expiry}&side=put&strike=${strike}`);
  if (!b) return null;
  return { bid: first(b, "bid"), ask: first(b, "ask"), last: first(b, "last"), updated: first(b, "updated"), underlying: first(b, "underlyingPrice") };
}

export const putKey = (expiry: string, strike: number) => `${expiry}|${strike}`;

/** Several puts, a few at a time. A contract that is not listed maps to null; any other failure throws. */
export async function spyPuts(wanted: Array<{ expiry: string; strike: number }>, concurrency = 6): Promise<Map<string, MdPut | null>> {
  const out = new Map<string, MdPut | null>();
  const todo = wanted.filter((w, i) => wanted.findIndex((x) => x.expiry === w.expiry && x.strike === w.strike) === i);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const w = todo[next++];
        out.set(putKey(w.expiry, w.strike), await spyPut(w.expiry, w.strike));
      }
    }),
  );
  return out;
}

/** Newest quote time among the puts, as ISO; null when none carries one. */
export function newestQuoteTime(puts: Iterable<MdPut | null>): string | null {
  let max = 0;
  for (const p of puts) if (p?.updated && p.updated > max) max = p.updated;
  return max > 0 ? new Date(max * 1000).toISOString() : null;
}
