/**
 * Market drivers — which stocks are moving the index, each sector, and the
 * industry groups, and where the book sits in that.
 *
 * Built from FactSet cross-sectional pulls (the same relay + chunking the
 * weekly factor universe uses) over the S&P 500 + TSX 60 constituent lists in
 * factor-constituents.ts, plus the sector / industry ETF list. Contribution =
 * cap weight × return, weights normalised within the universe we actually got
 * prices for. This is a regenerable CACHE (`pm:market-drivers`) — safe to
 * nuke; rebuilt by the nightly cron and lazily on GET when older than
 * DRIVERS_STALE_MS. Reads pm:stocks READ-ONLY for the held/watch flags.
 */

import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { crossSectional, factsetConfigured, totalReturnFormula, type FactsetValue } from "@/app/lib/factset";
import { fetchYahooDaily } from "@/app/lib/daily-summary/yahoo";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { SP500, TSX60 } from "@/app/lib/factor-constituents";
import { isBookStock, type Stock } from "@/app/lib/types";

const log = createLogger("Market-drivers");

export const DRIVERS_KEY = "pm:market-drivers";
export const DRIVERS_STALE_MS = 20 * 60 * 60 * 1000;
const CHUNK = 40;

/**
 * Stock-side formulas. Deliberately MINIMAL (four): the first cut asked for
 * seven across ~554 ids and the relay answered 429 "API rate limit exceeded".
 * `ret1m` was dropped because the drivers UI only ever shows 1D and 1W, and
 * the company name was dropped because held names already come from pm:stocks
 * and everything else labels fine by ticker + sector.
 *
 * The daily/weekly windows are built from EXPLICIT session dates, not relative
 * offsets: FactSet rejects `P_TOTAL_RETURNC(-1D,0)` outright with
 * "Invalid Daily Price Date Specification", which silently nulled every 1D and
 * 1W number. Explicit dates are also weekend- and holiday-proof, because the
 * anchors are read off real SPY sessions rather than calendar arithmetic.
 */
const STATIC_FORMULAS = {
  mcap: "FG_MKT_VALUE",
  sector: "FG_GICS_SECTOR",
} as const;

/** Windows in TRADING SESSIONS back from the latest close. */
const SESSIONS_1D = 1;
const SESSIONS_1W = 5;
const SESSIONS_1M = 21;
const SESSIONS_3M = 63;

/** Relay chunking. Chunks run SEQUENTIALLY (factor-universe's proven shape) —
 *  firing all ~14 in parallel is what triggered the 429. */
const CHUNK_PAUSE_MS = 250;

type Anchors = { end: string; d1: string; w1: string };

/** YYYY-MM-DD → YYYYMMDD (FactSet's explicit date form). */
function fsDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

/**
 * Real session dates from SPY's own daily bars, so "1 day" means the last
 * completed session — correct on a Sunday, a holiday, or a half day alike.
 * Null when Yahoo is unavailable (the caller then skips the FactSet pull
 * rather than asking for a window it cannot anchor).
 */
async function sessionAnchors(): Promise<{ anchors: Anchors | null; dates: string[] }> {
  const bars = await fetchYahooDaily("SPY", "6mo");
  const dates = bars.map((b) => b.date);
  if (dates.length < SESSIONS_1W + 1) return { anchors: null, dates };
  const end = dates[dates.length - 1];
  return {
    anchors: {
      end: fsDate(end),
      d1: fsDate(dates[dates.length - 1 - SESSIONS_1D]),
      w1: fsDate(dates[dates.length - 1 - SESSIONS_1W]),
    },
    dates,
  };
}

/** Trailing return over `sessions` bars of a close series, in percent. */
function trailingReturn(values: number[], sessions: number): number | null {
  if (values.length < sessions + 1) return null;
  const now = values[values.length - 1];
  const then = values[values.length - 1 - sessions];
  if (!isFinite(now) || !isFinite(then) || then <= 0) return null;
  return ((now / then) - 1) * 100;
}

/** Run `jobs` with at most `limit` in flight. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export type DriverRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  mcap: number | null;
  weight: number | null; // share of the priced universe, 0..1
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  contrib1d: number | null; // percentage points of index return
  contrib1w: number | null;
  held: "Portfolio" | "Watchlist" | null;
};

export type SectorDrivers = {
  sector: string;
  weight: number; // share of the priced universe, 0..1
  ret1d: number | null; // cap-weighted
  ret1w: number | null;
  contrib1d: number | null;
  contrib1w: number | null;
  leaders: DriverRow[]; // top contributors within the sector, 1d
  laggards: DriverRow[];
};

export type IndexDrivers = {
  key: "spx" | "tsx";
  label: string;
  namesPriced: number;
  namesTotal: number;
  ret1d: number | null; // cap-weighted across the priced universe
  ret1w: number | null;
  top1d: DriverRow[];
  bottom1d: DriverRow[];
  top1w: DriverRow[];
  bottom1w: DriverRow[];
  sectors: SectorDrivers[];
};

export type EtfRow = {
  symbol: string;
  label: string;
  kind: "benchmark" | "sector" | "industry";
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  ret3m: number | null;
};

export type MarketDrivers = {
  builtAt: string;
  indexes: IndexDrivers[];
  etfs: EtfRow[];
  error?: string;
};

/** Sector + industry ETF universe (mirrors sector-leadership.ts). */
export const ETF_UNIVERSE: { symbol: string; label: string; kind: EtfRow["kind"] }[] = [
  { symbol: "SPY", label: "S&P 500", kind: "benchmark" },
  { symbol: "XLK", label: "Technology", kind: "sector" },
  { symbol: "XLF", label: "Financials", kind: "sector" },
  { symbol: "XLV", label: "Health Care", kind: "sector" },
  { symbol: "XLY", label: "Consumer Discretionary", kind: "sector" },
  { symbol: "XLP", label: "Consumer Staples", kind: "sector" },
  { symbol: "XLI", label: "Industrials", kind: "sector" },
  { symbol: "XLE", label: "Energy", kind: "sector" },
  { symbol: "XLB", label: "Materials", kind: "sector" },
  { symbol: "XLC", label: "Communication Services", kind: "sector" },
  { symbol: "XLU", label: "Utilities", kind: "sector" },
  { symbol: "XLRE", label: "Real Estate", kind: "sector" },
  { symbol: "SMH", label: "Semiconductors", kind: "industry" },
  { symbol: "IGV", label: "Software", kind: "industry" },
  { symbol: "SKYY", label: "Cloud", kind: "industry" },
  { symbol: "CIBR", label: "Cybersecurity", kind: "industry" },
  { symbol: "FDN", label: "Internet", kind: "industry" },
  { symbol: "AIQ", label: "AI & Robotics", kind: "industry" },
  { symbol: "XBI", label: "Biotech", kind: "industry" },
  { symbol: "IHI", label: "Medical Devices", kind: "industry" },
  { symbol: "KRE", label: "Regional Banks", kind: "industry" },
  { symbol: "KIE", label: "Insurance", kind: "industry" },
  { symbol: "XOP", label: "Oil & Gas E&P", kind: "industry" },
  { symbol: "OIH", label: "Oil Services", kind: "industry" },
  { symbol: "TAN", label: "Solar", kind: "industry" },
  { symbol: "URA", label: "Uranium", kind: "industry" },
  { symbol: "ICLN", label: "Clean Energy", kind: "industry" },
  { symbol: "PAVE", label: "Infrastructure", kind: "industry" },
  { symbol: "ITA", label: "Aerospace & Defense", kind: "industry" },
  { symbol: "IYT", label: "Transports", kind: "industry" },
  { symbol: "XHB", label: "Homebuilders", kind: "industry" },
  { symbol: "XRT", label: "Retail", kind: "industry" },
  { symbol: "GDX", label: "Gold Miners", kind: "industry" },
  { symbol: "COPX", label: "Copper Miners", kind: "industry" },
  { symbol: "XME", label: "Metals & Mining", kind: "industry" },
];

type Raw = Record<string, Record<string, FactsetValue>>;

/**
 * Sequential chunked cross-sectional pull.
 *
 * Chunks run ONE AT A TIME with a short pause — the first cut fired all ~14 in
 * parallel and the relay answered 429 "API rate limit exceeded" for every one,
 * which is why the whole zone came back empty. `relayRetry` deliberately does
 * not retry 4xx, and 429 IS a 4xx, so the backoff for it lives here.
 */
async function pull(ids: string[], formulas: string[]): Promise<Raw> {
  const merged: Raw = {};
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  let rateLimited = 0;
  for (const chunk of chunks) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        Object.assign(merged, await crossSectional(chunk, formulas));
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is429 = /returned 429/.test(msg);
        if (is429 && attempt < 2) {
          rateLimited++;
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        log.warn(`chunk of ${chunk.length} failed:`, msg.slice(0, 200));
        break;
      }
    }
    await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
  }
  if (rateLimited > 0) log.info(`backed off ${rateLimited}x on relay rate limits`);
  return merged;
}

/** Yahoo-derived returns for the sector / industry ETF universe.
 *  Moved off FactSet entirely: 35 more relay ids was a needless share of the
 *  rate limit, and daily bars give a session-accurate 1D/1W/1M/3M for free
 *  (the same shape sector-leadership.ts already relies on). */
async function etfReturns(): Promise<EtfRow[]> {
  const jobs = ETF_UNIVERSE.map((e) => async (): Promise<EtfRow> => {
    const bars = await fetchYahooDaily(e.symbol, "6mo");
    const closes = bars.map((b) => b.value);
    return {
      symbol: e.symbol,
      label: e.label,
      kind: e.kind,
      ret1d: r2(trailingReturn(closes, SESSIONS_1D)),
      ret1w: r2(trailingReturn(closes, SESSIONS_1W)),
      ret1m: r2(trailingReturn(closes, SESSIONS_1M)),
      ret3m: r2(trailingReturn(closes, SESSIONS_3M)),
    };
  });
  return pool(jobs, 6);
}

const num = (v: FactsetValue | undefined): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const str = (v: FactsetValue | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const r2 = (v: number | null): number | null => (v == null ? null : parseFloat(v.toFixed(2)));
const r3 = (v: number | null): number | null => (v == null ? null : parseFloat(v.toFixed(3)));

function buildIndex(
  key: IndexDrivers["key"],
  label: string,
  tickers: string[],
  raw: Raw,
  held: Map<string, { bucket: "Portfolio" | "Watchlist"; name?: string }>,
  f: { ret1d: string; ret1w: string }
): IndexDrivers {
  const rows: DriverRow[] = [];
  for (const t of tickers) {
    const res = resolveFactsetId(t);
    if (res.source !== "factset") continue;
    const rec = raw[res.id];
    if (!rec) continue;
    const mcap = num(rec[STATIC_FORMULAS.mcap]);
    const ret1d = num(rec[f.ret1d]);
    if (mcap == null || mcap <= 0 || ret1d == null) continue;
    const h = held.get(t.toUpperCase());
    rows.push({
      ticker: t,
      name: h?.name ?? null,
      sector: str(rec[STATIC_FORMULAS.sector]),
      mcap,
      weight: null,
      ret1d: r2(ret1d),
      ret1w: r2(num(rec[f.ret1w])),
      ret1m: null,
      contrib1d: null,
      contrib1w: null,
      held: h?.bucket ?? null,
    });
  }
  const totalCap = rows.reduce((s, r) => s + (r.mcap ?? 0), 0);
  let idx1d = 0;
  let idx1w = 0;
  let w1wSum = 0;
  for (const r of rows) {
    r.weight = totalCap > 0 ? (r.mcap ?? 0) / totalCap : null;
    r.contrib1d = r.weight != null && r.ret1d != null ? r3(r.weight * r.ret1d) : null;
    r.contrib1w = r.weight != null && r.ret1w != null ? r3(r.weight * r.ret1w) : null;
    if (r.contrib1d != null) idx1d += r.contrib1d;
    if (r.contrib1w != null && r.weight != null) {
      idx1w += r.contrib1w;
      w1wSum += r.weight;
    }
  }

  const by = (f: (r: DriverRow) => number | null, desc: boolean, n: number) =>
    rows
      .filter((r) => f(r) != null)
      .sort((a, b) => (desc ? (f(b) as number) - (f(a) as number) : (f(a) as number) - (f(b) as number)))
      .slice(0, n);

  // Sectors
  const sectorMap = new Map<string, DriverRow[]>();
  for (const r of rows) {
    const s = r.sector ?? "Unclassified";
    const arr = sectorMap.get(s) ?? [];
    arr.push(r);
    sectorMap.set(s, arr);
  }
  const sectors: SectorDrivers[] = [];
  for (const [sector, members] of sectorMap) {
    const w = members.reduce((s, r) => s + (r.weight ?? 0), 0);
    if (w <= 0) continue;
    const c1d = members.reduce((s, r) => s + (r.contrib1d ?? 0), 0);
    const wk = members.filter((r) => r.contrib1w != null);
    const wkW = wk.reduce((s, r) => s + (r.weight ?? 0), 0);
    const c1w = wk.reduce((s, r) => s + (r.contrib1w ?? 0), 0);
    const sorted = members.filter((r) => r.contrib1d != null).sort((a, b) => (b.contrib1d as number) - (a.contrib1d as number));
    sectors.push({
      sector,
      weight: r3(w) as number,
      ret1d: r2(c1d / w),
      ret1w: wkW > 0 ? r2(c1w / wkW) : null,
      contrib1d: r3(c1d),
      contrib1w: wkW > 0 ? r3(c1w) : null,
      leaders: sorted.slice(0, 3),
      laggards: sorted.slice(-3).reverse(),
    });
  }
  sectors.sort((a, b) => (b.ret1d ?? -Infinity) - (a.ret1d ?? -Infinity));

  return {
    key,
    label,
    namesPriced: rows.length,
    namesTotal: tickers.length,
    ret1d: rows.length ? r2(idx1d) : null,
    ret1w: w1wSum > 0 ? r2(idx1w / w1wSum) : null,
    top1d: by((r) => r.contrib1d, true, 10),
    bottom1d: by((r) => r.contrib1d, false, 10),
    top1w: by((r) => r.contrib1w, true, 10),
    bottom1w: by((r) => r.contrib1w, false, 10),
    sectors,
  };
}

export async function buildMarketDrivers(): Promise<MarketDrivers> {
  const builtAt = new Date().toISOString();
  // NOTE: no early return when FactSet is unconfigured — the ETF sector map is
  // Yahoo-only now and is worth serving on its own; only the constituent
  // contributors need the relay.
  const factset = factsetConfigured();

  // Held / watched flags — read-only over pm:stocks.
  const held = new Map<string, { bucket: "Portfolio" | "Watchlist"; name?: string }>();
  try {
    const raw = await (await getRedis()).get("pm:stocks");
    const parsed = raw ? (JSON.parse(raw) as Stock[] | { stocks?: Stock[] }) : [];
    const list = Array.isArray(parsed) ? parsed : parsed.stocks ?? [];
    for (const s of list) {
      // Book only — a Suggested staging record is not a held/watched name.
      if (!s?.ticker || !isBookStock(s)) continue;
      held.set(s.ticker.toUpperCase(), { bucket: s.bucket as "Portfolio" | "Watchlist", name: s.name });
    }
  } catch {
    /* flags degrade to null */
  }

  const stockIds = new Set<string>();
  for (const t of [...SP500, ...TSX60]) {
    const r = resolveFactsetId(t);
    if (r.source === "factset") stockIds.add(r.id);
  }

  // Session anchors first: the daily/weekly windows are explicit dates read off
  // real SPY sessions, so they stay correct on a weekend or a market holiday.
  const [{ anchors, dates }, etfs] = await Promise.all([sessionAnchors(), etfReturns()]);
  if (!factset) {
    log.info("FactSet not configured — serving the Yahoo ETF map only");
    return { builtAt, indexes: [], etfs, error: "FactSet relay not configured" };
  }
  if (!anchors) {
    log.warn("no SPY session anchors from Yahoo — skipping the constituent pull");
    return { builtAt, indexes: [], etfs, error: "Could not resolve trading sessions" };
  }
  log.info(`sessions: 1D ${anchors.d1}->${anchors.end}, 1W ${anchors.w1}->${anchors.end} (${dates.length} bars)`);

  const f = {
    ret1d: totalReturnFormula(anchors.d1, anchors.end),
    ret1w: totalReturnFormula(anchors.w1, anchors.end),
  };
  const stockRaw = await pull([...stockIds], [f.ret1d, f.ret1w, STATIC_FORMULAS.mcap, STATIC_FORMULAS.sector]);

  const indexes = [
    buildIndex("spx", "S&P 500", SP500, stockRaw, held, f),
    buildIndex("tsx", "TSX 60", TSX60, stockRaw, held, f),
  ];

  const priced = indexes.reduce((s, i) => s + i.namesPriced, 0);
  const etfsPriced = etfs.filter((e) => e.ret1d != null).length;
  const out: MarketDrivers = { builtAt, indexes, etfs };
  // ETFs alone still make the sector map useful, so only a total miss is an error.
  if (priced === 0 && etfsPriced === 0) out.error = "No market data available";
  else if (priced === 0) out.error = "FactSet returned no constituent prices";
  log.info(`built: ${priced} names priced, ${etfsPriced}/${etfs.length} ETFs`);
  return out;
}

export async function readMarketDrivers(): Promise<MarketDrivers | null> {
  try {
    const raw = await (await getRedis()).get(DRIVERS_KEY);
    return raw ? (JSON.parse(raw) as MarketDrivers) : null;
  } catch {
    return null;
  }
}

/** Cached-or-rebuild. Never throws: on a failed rebuild the stale cache (if
 *  any) is returned with `error` set. Only writes when the build produced
 *  prices, so a relay outage can't overwrite a good snapshot with an empty one. */
export async function getMarketDrivers(opts: { refresh?: boolean } = {}): Promise<MarketDrivers | null> {
  const cached = await readMarketDrivers();
  if (!opts.refresh && cached) {
    const age = Date.now() - Date.parse(cached.builtAt);
    if (isFinite(age) && age < DRIVERS_STALE_MS) return cached;
  }
  try {
    const fresh = await buildMarketDrivers();
    if (!fresh.error) {
      try {
        await (await getRedis()).set(DRIVERS_KEY, JSON.stringify(fresh));
      } catch (e) {
        log.error("cache write failed:", e);
      }
      return fresh;
    }
    log.warn("build produced no data:", fresh.error);
    return cached ? { ...cached, error: fresh.error } : fresh;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("build failed:", msg);
    return cached ? { ...cached, error: msg } : { builtAt: new Date().toISOString(), indexes: [], etfs: [], error: msg };
  }
}
