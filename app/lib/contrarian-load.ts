import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { canonicalTicker, tickersEqual } from "@/app/lib/ticker";
import { history as priceHistory } from "@/app/lib/holding-history";
import { readFavour, type FavourRead, type Series } from "@/app/lib/favour";
import { analystTrend, ANALYST_HISTORY_KEY, type AnalystHistory } from "@/app/lib/analyst-history";
import { getSnapshotForTicker, type AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { getInsiderActivity, type Form4Summary } from "@/app/lib/edgar-form4";
import type { KillCondition, ThesisPillar } from "@/app/lib/kill-conditions";
import type { StreetTakeawaysStore } from "@/app/lib/street-takeaways";
import { isCanadianListing, readContrarian, type ContrarianRead, type InsidersInput, type ThesisInput, type ValuationInput } from "@/app/lib/contrarian";

/**
 * Loader for the contrarian read-out (see app/lib/contrarian.ts for the
 * rules). READ-ONLY: it reads pm:stocks, pm:street-takeaways,
 * pm:analyst-snapshots, pm:analyst-history, pm:position-theses, the
 * pm:favour-monitor cache and the pm:edgar-form4:{TICKER} caches, and stores
 * nothing of its own.
 *
 * The whole-book read uses only what is already cached (no price or SEC
 * fetch), so a name missing from the favour cache or the insider cache reads
 * "no data" for that test. A single-ticker read (`live`) fills those two
 * gaps on demand: prices from the existing price helper, insiders through
 * `getInsiderActivity` (which keeps its own existing 24h cache).
 */

const log = createLogger("Contrarian");

export type ContrarianRow = { ticker: string; name: string; bucket: "Portfolio" | "Watchlist" } & ContrarianRead;
type StockRow = { ticker?: string; name?: string; bucket?: string; instrumentType?: string };
type Thesis = { pillars?: ThesisPillar[]; killConditions?: KillCondition[]; underwrittenAt?: string };
type FavourCache = { rows?: ({ ticker: string } & FavourRead)[] };

const isFundserv = (s: string) => /^[A-Z]{2,4}\d{2,5}$/i.test(s);
const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** Value stored under a ticker, whatever listing-suffix form the key uses. */
function lookup<T>(rec: Record<string, T> | null | undefined, ticker: string): T | undefined {
  if (!rec) return undefined;
  const c = canonicalTicker(ticker).toUpperCase();
  if (rec[c] !== undefined) return rec[c];
  const u = ticker.trim().toUpperCase();
  if (rec[u] !== undefined) return rec[u];
  const k = Object.keys(rec).find((key) => tickersEqual(key, ticker));
  return k ? rec[k] : undefined;
}

/** Newest FactSet alert on file that carries a multiple WITH its 5-year average. */
export function valuationFrom(store: StreetTakeawaysStore, ticker: string): ValuationInput {
  const list = lookup(store, ticker) ?? [];
  const hit = [...list]
    .filter((t) => t.valuation && ((t.valuation.ntmPe != null && t.valuation.ntmPeFiveYrAvg != null) || (t.valuation.evEbitda != null && t.valuation.evEbitdaFiveYrAvg != null)))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
  return hit?.valuation ? { ...hit.valuation, asOf: hit.date, source: "FactSet analyst round-up" } : null;
}

/** Broken pillars and tripped long-term breakers; null when there is no signed thesis. */
export function thesisFrom(t: Thesis | undefined): ThesisInput {
  if (!t || (!t.pillars?.length && !t.killConditions?.length)) return null;
  return {
    brokenPillars: (t.pillars ?? []).filter((p) => p.status === "broken").map((p) => p.title),
    trippedBreakers: (t.killConditions ?? []).filter((c) => !!c.trippedAt && (c.kind === "metric" || c.kind === "custom")).map((c) => c.theme ?? c.note ?? c.metric?.label ?? "a thesis breaker"),
  };
}

const insidersFrom = (s: Form4Summary | null | undefined): InsidersInput =>
  s ? { buyCount: s.buyCount, sellCount: s.sellCount, totalBuyValue: s.totalBuyValue, totalSellValue: s.totalSellValue, windowDays: s.windowDays, asOf: s.asOf } : null;

/** Individual stocks in the book (Portfolio + Watchlist). */
export function contrarianUniverse(stocks: StockRow[]): { ticker: string; name: string; bucket: "Portfolio" | "Watchlist" }[] {
  const out: { ticker: string; name: string; bucket: "Portfolio" | "Watchlist" }[] = [];
  for (const s of stocks) {
    if (!s.ticker || (s.bucket !== "Portfolio" && s.bucket !== "Watchlist")) continue;
    if ((s.instrumentType && s.instrumentType !== "stock") || isFundserv(s.ticker)) continue;
    out.push({ ticker: s.ticker, name: s.name ?? "", bucket: s.bucket });
  }
  return out;
}

export async function loadContrarian(opts: { ticker?: string } = {}): Promise<{ at: string; rows: ContrarianRow[]; notInBook?: boolean }> {
  const redis = await getRedis();
  const [stocksRaw, streetRaw, snapsRaw, histRaw, thesesRaw, favourRaw] = await Promise.all([
    redis.get("pm:stocks"),
    redis.get("pm:street-takeaways"),
    redis.get("pm:analyst-snapshots"),
    redis.get(ANALYST_HISTORY_KEY),
    redis.get("pm:position-theses"),
    redis.get("pm:favour-monitor"),
  ]);
  const stocksParsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(stocksParsed) ? stocksParsed : ((stocksParsed as { stocks?: unknown[] })?.stocks ?? [])) as StockRow[];
  const street = parse<StreetTakeawaysStore>(streetRaw, {});
  const snaps = parse<AnalystSnapshots>(snapsRaw, {});
  const hist = parse<AnalystHistory>(histRaw, {});
  const theses = parse<Record<string, Thesis>>(thesesRaw, {});
  const favourRows = parse<FavourCache>(favourRaw, {}).rows ?? [];
  const today = new Date().toISOString().slice(0, 10);

  let names = contrarianUniverse(stocks);
  const single = opts.ticker?.trim();
  if (single) {
    names = names.filter((n) => tickersEqual(n.ticker, single));
    if (!names.length) return { at: new Date().toISOString(), rows: [], notInBook: true };
  }

  // Insider caches for the US names, in one read (the cache is written by scoring).
  const usNames = names.filter((n) => !isCanadianListing(n.ticker));
  const form4 = new Map<string, Form4Summary>();
  if (usNames.length) {
    try {
      const vals = await redis.mGet(usNames.map((n) => `pm:edgar-form4:${n.ticker.trim().toUpperCase()}`));
      vals.forEach((v, i) => {
        const d = parse<{ data?: Form4Summary } | null>(v, null)?.data;
        if (d) form4.set(usNames[i].ticker, d);
      });
    } catch (e) {
      log.warn("insider cache read failed:", e instanceof Error ? e.message : e);
    }
  }

  // A single-name read fills the two gaps the cached read can have.
  let liveFavour: FavourRead | null = null;
  if (single && names[0]) {
    const n = names[0];
    if (!favourRows.some((r) => tickersEqual(r.ticker, n.ticker))) {
      try {
        const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
        const [idx, px]: Series[] = await Promise.all([priceHistory("^GSPC", since), priceHistory(n.ticker, since)]);
        if (idx.dates.length >= 100) liveFavour = readFavour(px, idx);
      } catch (e) {
        log.warn(`price read failed for ${n.ticker}:`, e instanceof Error ? e.message : e);
      }
    }
    if (!isCanadianListing(n.ticker) && !form4.has(n.ticker)) {
      try {
        const s = await getInsiderActivity(n.ticker);
        if (s) form4.set(n.ticker, s);
      } catch (e) {
        log.warn(`insider read failed for ${n.ticker}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  const rows: ContrarianRow[] = names.map((n) => {
    const fs = getSnapshotForTicker(snaps, n.ticker)?.factset;
    const entries = lookup(hist, n.ticker);
    const favour = favourRows.find((r) => tickersEqual(r.ticker, n.ticker)) ?? liveFavour;
    const read = readContrarian({
      today,
      valuation: valuationFrom(street, n.ticker),
      revisions: fs ? { revUp: fs.revUp, revDown: fs.revDown, analystCount: fs.analystCount } : null,
      trend: entries?.length ? analystTrend(entries, today) : null,
      usFiler: !isCanadianListing(n.ticker),
      insiders: insidersFrom(form4.get(n.ticker)),
      favour: favour ?? null,
      thesis: thesisFrom(lookup(theses, n.ticker)),
    });
    return { ...n, ...read };
  });
  const rank = { "Contrarian setup": 0, Partial: 1, "Not enough data": 2, "Not a contrarian setup": 3 } as const;
  rows.sort((a, b) => rank[a.label] - rank[b.label] || b.score - a.score || a.ticker.localeCompare(b.ticker));
  return { at: new Date().toISOString(), rows };
}
