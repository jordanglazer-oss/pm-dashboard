import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeTechnicals, computeRiskAlert, type OHLCVBar } from "@/app/lib/technicals";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/types";

/**
 * Nightly technicals + riskAlert refresh, so the morning alert digest never
 * reports a TECHNICAL breakdown off stale price data. Runs in the cron before
 * the digest.
 *
 * ─────────────────────── REDIS SAFETY (pm:stocks) ───────────────────────
 * This is the ONE piece of the cron that writes pm:stocks — the user's most
 * precious key — so the write is engineered to make loss structurally
 * impossible rather than merely unlikely:
 *
 *  1. TARGETED FIELDS ONLY. Each stock is rewritten as { ...stock, technicals,
 *     riskAlert } — every other field (positions, scores, notes, buckets,
 *     explanations) is spread through verbatim. We never construct a stock.
 *  2. RE-READ IMMEDIATELY BEFORE WRITING. We snapshot the tickers, do all the
 *     slow Yahoo I/O, then RE-READ pm:stocks and merge into THAT fresh copy by
 *     ticker. A holding added/removed/edited during the fetch window survives —
 *     it simply doesn't get technicals this run. This collapses the classic
 *     read-modify-write race from "the whole fetch duration" to microseconds.
 *  3. NEVER WRITE A DEGRADED ARRAY. If the re-read is missing/empty/not an
 *     array, or nothing computed, we ABORT without writing. A Yahoo outage can
 *     only mean "technicals not updated", never "holdings wiped".
 *  4. PER-TICKER SKIP ON FAILURE. A ticker whose history doesn't fetch keeps
 *     its EXISTING technicals — we never overwrite good data with null.
 *  5. DERIVED DATA ONLY. technicals/riskAlert are computed from public price
 *     history; the worst case for a lost write is that they're recomputed on
 *     the next run or on a manual Refresh. No user input is at stake.
 *  6. FRESH RECOVERY POINT. The cron writes the nightly Blob backup BEFORE this
 *     step, so a full pm:stocks snapshot from minutes earlier always exists.
 */

const log = createLogger("TechnicalsRefresh");

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const CONCURRENCY = 8;

/** Dashboard ticker → Yahoo symbol (mirrors /api/refresh-data). */
function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

type StoredStock = {
  ticker?: string;
  instrumentType?: string;
  technicals?: TechnicalIndicators;
  riskAlert?: RiskAlert;
  [k: string]: unknown;
};

export type TechnicalsRefreshStatus = {
  ran: boolean;
  considered: number;
  /** How many tickers we actually got to before the time budget ran out. */
  attempted?: number;
  updated: number;
  failed: number;
  /** True when the budget cut the run short — the rest keep yesterday's values
   *  and get picked up on the next run (or a manual Refresh). */
  budgetExhausted?: boolean;
  error?: string;
};

/** Leave plenty of the cron's 60s for the thesis rebuild + digest + invariants
 *  that follow. Technicals must NEVER be the reason the morning email doesn't
 *  go out — a partial technicals refresh is strictly better than no email. */
const DEFAULT_BUDGET_MS = 20_000;

async function fetchPriceHistory(yahooSymbol: string): Promise<OHLCVBar[]> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) return [];
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];
      const volume = quote.volume?.[i];
      if (open == null || high == null || low == null || close == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
        open, high, low, close, volume: volume ?? 0,
      });
    }
    return bars;
  } catch {
    return [];
  }
}

/** Run in chunks, stopping early once the time budget is spent. Returns how
 *  many items were actually attempted. */
async function inChunksUntil<T>(
  items: T[],
  size: number,
  deadline: number,
  fn: (x: T) => Promise<void>
): Promise<number> {
  let attempted = 0;
  for (let i = 0; i < items.length; i += size) {
    if (Date.now() > deadline) break;
    const slice = items.slice(i, i + size);
    await Promise.all(slice.map(fn));
    attempted += slice.length;
  }
  return attempted;
}

/**
 * Recompute technicals + riskAlert for every individual stock (Portfolio +
 * Watchlist) and merge them into pm:stocks. ETFs / mutual funds are skipped —
 * the risk engine is an equity-technicals tool.
 */
export async function refreshTechnicals(opts?: { budgetMs?: number }): Promise<TechnicalsRefreshStatus> {
  const deadline = Date.now() + (opts?.budgetMs ?? DEFAULT_BUDGET_MS);
  try {
    const redis = await getRedis();

    // ── Pass 1: snapshot the tickers we intend to refresh ──
    const rawA = await redis.get("pm:stocks");
    const snapshotA: StoredStock[] = (() => {
      try {
        const p = rawA ? JSON.parse(rawA) : [];
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    })();

    const targets = snapshotA
      .filter((s) => {
        const t = (s.ticker || "").trim();
        if (!t) return false;
        // Equities only — ETFs/funds have no meaningful technical risk engine.
        const it = s.instrumentType;
        return it === undefined || it === null || it === "stock";
      })
      .map((s) => (s.ticker as string).trim());

    if (targets.length === 0) {
      return { ran: true, considered: 0, updated: 0, failed: 0 };
    }

    // ── Slow part: fetch + compute (no Redis held across this) ──
    const computed = new Map<string, { technicals: TechnicalIndicators; riskAlert: RiskAlert }>();
    let failed = 0;
    const attempted = await inChunksUntil(targets, CONCURRENCY, deadline, async (ticker) => {
      const bars = await fetchPriceHistory(toYahoo(ticker));
      if (bars.length === 0) {
        failed++;
        return;
      }
      const technicals = computeTechnicals(bars);
      if (!technicals) {
        failed++;
        return;
      }
      // healthData is optional for computeRiskAlert — price-derived signals are
      // what the technical alerts key off, and skipping the Yahoo modules call
      // halves the request count.
      const riskAlert = computeRiskAlert(technicals);
      computed.set(ticker, { technicals, riskAlert });
    });
    const budgetExhausted = attempted < targets.length;
    if (budgetExhausted) {
      log.warn(`time budget spent after ${attempted}/${targets.length} — the rest keep their existing technicals`);
    }

    if (computed.size === 0) {
      log.warn("no technicals computed — nothing written");
      return { ran: true, considered: targets.length, attempted, updated: 0, failed, budgetExhausted };
    }

    // ── Pass 2: RE-READ and merge into the CURRENT array (race-safe) ──
    const rawB = await redis.get("pm:stocks");
    const snapshotB: StoredStock[] = (() => {
      try {
        const p = rawB ? JSON.parse(rawB) : null;
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    })();

    // Guard: never write a degraded array. If the re-read failed or came back
    // empty while we KNOW there were holdings, abort rather than risk a wipe.
    if (snapshotB.length === 0) {
      log.error("pm:stocks re-read empty/unparseable — ABORTING write (no data touched)");
      return { ran: false, considered: targets.length, attempted, updated: 0, failed, budgetExhausted, error: "stocks re-read empty; write aborted" };
    }

    let updated = 0;
    const merged = snapshotB.map((s) => {
      const t = (s.ticker || "").trim();
      const c = t ? computed.get(t) : undefined;
      if (!c) return s; // untouched — including anything added during the fetch
      updated++;
      // Spread preserves every other field verbatim.
      return { ...s, technicals: c.technicals, riskAlert: c.riskAlert };
    });

    if (updated === 0) {
      return { ran: true, considered: targets.length, attempted, updated: 0, failed, budgetExhausted };
    }

    await redis.set("pm:stocks", JSON.stringify(merged));
    log.info(`updated ${updated}/${targets.length} (${failed} failed)`);
    return { ran: true, considered: targets.length, attempted, updated, failed, budgetExhausted };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("failed:", msg);
    return { ran: false, considered: 0, updated: 0, failed: 0, error: msg };
  }
}
