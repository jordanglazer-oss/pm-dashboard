import { getRedis } from "@/app/lib/redis";
import { normalizeSector } from "./scoring";

/**
 * Journal attribution — forward sector-relative returns for every logged
 * decision (phase ③ of the thesis-discipline build, preview-only).
 *
 * For each pm:decision-journal entry with a ticker, measures what happened
 * AFTER the decision: the name's price return over ~1M and ~3M from the
 * decision date, minus its sector ETF's return over the identical window
 * (SPY when the sector is unknown). "Hit" means the decision was directionally
 * right: buys/adds that outperformed, trims/sells that then underperformed.
 *
 * Deterministic — prices from Yahoo, zero Anthropic spend. Results cache in
 * pm:journal-attribution (regenerable, 6h TTL, safe to nuke). Reads
 * pm:decision-journal and pm:stocks READ-ONLY.
 *
 * Honesty rules:
 *   - A window that hasn't fully elapsed reports its partial return with
 *     partial: true — shown as "so far", never blended into hit rates.
 *   - Entries whose prices can't be fetched are listed as skipped, not
 *     silently dropped — a hit rate over an unstated subset is a lie.
 *   - Hold/watch/hedge/other decisions carry returns for context but are
 *     excluded from hit rates; only buys and trims have a falsifiable
 *     directional claim.
 */

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (pm-dashboard journal attribution)";
const CACHE_KEY = "pm:journal-attribution";
export const ATTRIB_TTL_MS = 6 * 60 * 60 * 1000;

const SECTOR_ETFS: Record<string, string> = {
  Technology: "XLK",
  "Health Care": "XLV",
  Healthcare: "XLV",
  Financials: "XLF",
  "Financial Services": "XLF",
  "Consumer Discretionary": "XLY",
  "Consumer Cyclical": "XLY",
  "Consumer Staples": "XLP",
  "Consumer Defensive": "XLP",
  Energy: "XLE",
  Utilities: "XLU",
  Industrials: "XLI",
  Materials: "XLB",
  "Basic Materials": "XLB",
  "Communication Services": "XLC",
  "Real Estate": "XLRE",
};

export type AttributedDecision = {
  id: string;
  date: string;
  ticker: string;
  action: string;
  rationale: string;
  confidence?: string;
  sector?: string;
  benchmark: string; // ETF used for the relative leg
  /** Sector-relative % returns from the decision date. */
  rel1m: number | null;
  rel3m: number | null;
  partial1m: boolean;
  partial3m: boolean;
  /** true = directionally right (buys: rel>0, trims/sells: rel<0), judged on
   *  the longest COMPLETE window; null when no window has completed or the
   *  action carries no directional claim. */
  hit: boolean | null;
};

export type JournalAttribution = {
  computedAt: string;
  rows: AttributedDecision[];
  skipped: { id: string; ticker?: string; reason: string }[];
  stats: {
    buys: { n: number; hits: number; avgRel3m: number | null };
    trims: { n: number; hits: number; avgRel3m: number | null };
  };
};

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

async function fetchCloses(ticker: string): Promise<Map<string, number> | null> {
  try {
    const res = await fetch(`${YAHOO}/${encodeURIComponent(toYahoo(ticker))}?range=2y&interval=1d`, {
      cache: "no-store",
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];
    const out = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && isFinite(c) && c > 0) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/** Close on the first trading day AT/AFTER isoDate (tolerates weekends). */
function closeOnOrAfter(closes: Map<string, number>, isoDate: string, maxDays = 7): number | null {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (isNaN(base)) return null;
  for (let i = 0; i <= maxDays; i++) {
    const d = new Date(base + i * 86400_000).toISOString().slice(0, 10);
    const c = closes.get(d);
    if (c != null) return c;
  }
  return null;
}

function latestClose(closes: Map<string, number>): { date: string; close: number } | null {
  let best: { date: string; close: number } | null = null;
  for (const [date, close] of closes) if (!best || date > best.date) best = { date, close };
  return best;
}

function windowReturn(
  closes: Map<string, number>,
  from: string,
  days: number,
): { ret: number; partial: boolean } | null {
  const start = closeOnOrAfter(closes, from);
  if (start == null) return null;
  const targetIso = new Date(Date.parse(`${from}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
  const latest = latestClose(closes);
  if (!latest) return null;
  if (latest.date >= targetIso) {
    const end = closeOnOrAfter(closes, targetIso);
    if (end == null) return null;
    return { ret: (end / start - 1) * 100, partial: false };
  }
  // Window not elapsed — report progress so far, flagged as partial.
  return { ret: (latest.close / start - 1) * 100, partial: true };
}

const BUY_ACTIONS = new Set(["add", "buy"]);
const SELL_ACTIONS = new Set(["trim", "sell", "exit"]);

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fb;
  }
}

export async function readJournalAttribution(): Promise<JournalAttribution | null> {
  const redis = await getRedis();
  return parse<JournalAttribution | null>(await redis.get(CACHE_KEY), null);
}

export async function computeJournalAttribution(): Promise<JournalAttribution> {
  const redis = await getRedis();
  const [journalRaw, stocksRaw] = await Promise.all([redis.get("pm:decision-journal"), redis.get("pm:stocks")]);
  const entries = parse<{ entries?: Array<{ id: string; date: string; ticker?: string; action: string; rationale: string; confidence?: string }> }>(
    journalRaw,
    {},
  ).entries ?? [];
  const stocks = parse<Array<{ ticker?: string; sector?: string }>>(stocksRaw, []);
  const sectorOf = new Map<string, string>();
  for (const s of stocks) if (s.ticker && s.sector) sectorOf.set(s.ticker.toUpperCase(), normalizeSector(s.sector));

  const rows: AttributedDecision[] = [];
  const skipped: JournalAttribution["skipped"] = [];
  const closeCache = new Map<string, Map<string, number> | null>();
  const getCloses = async (tk: string) => {
    if (!closeCache.has(tk)) closeCache.set(tk, await fetchCloses(tk));
    return closeCache.get(tk) ?? null;
  };

  for (const e of entries) {
    if (!e?.id || !e.date) continue;
    const tk = (e.ticker || "").toUpperCase();
    if (!tk) {
      skipped.push({ id: e.id, reason: "no ticker (book-level decision)" });
      continue;
    }
    const sector = sectorOf.get(tk);
    const benchmark = (sector && SECTOR_ETFS[sector]) || "SPY";
    const [stockCloses, benchCloses] = await Promise.all([getCloses(tk), getCloses(benchmark)]);
    if (!stockCloses || !benchCloses) {
      skipped.push({ id: e.id, ticker: tk, reason: `no price history (${!stockCloses ? tk : benchmark})` });
      continue;
    }
    const s1 = windowReturn(stockCloses, e.date, 30);
    const b1 = windowReturn(benchCloses, e.date, 30);
    const s3 = windowReturn(stockCloses, e.date, 91);
    const b3 = windowReturn(benchCloses, e.date, 91);
    const rel1m = s1 && b1 ? Math.round((s1.ret - b1.ret) * 10) / 10 : null;
    const rel3m = s3 && b3 ? Math.round((s3.ret - b3.ret) * 10) / 10 : null;
    const partial1m = Boolean(s1?.partial || b1?.partial);
    const partial3m = Boolean(s3?.partial || b3?.partial);

    // Judge on the longest COMPLETE window only.
    const action = (e.action || "").toLowerCase();
    const directional = BUY_ACTIONS.has(action) ? 1 : SELL_ACTIONS.has(action) ? -1 : 0;
    let hit: boolean | null = null;
    if (directional !== 0) {
      const judged = !partial3m && rel3m != null ? rel3m : !partial1m && rel1m != null ? rel1m : null;
      if (judged != null) hit = directional === 1 ? judged > 0 : judged < 0;
    }

    rows.push({
      id: e.id,
      date: e.date,
      ticker: tk,
      action: e.action,
      rationale: e.rationale,
      confidence: e.confidence,
      sector,
      benchmark,
      rel1m,
      rel3m,
      partial1m,
      partial3m,
      hit,
    });
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const judgedOf = (dir: 1 | -1) =>
    rows.filter((r) => (dir === 1 ? BUY_ACTIONS : SELL_ACTIONS).has(r.action.toLowerCase()) && r.hit != null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const buys = judgedOf(1);
  const trims = judgedOf(-1);

  const result: JournalAttribution = {
    computedAt: new Date().toISOString(),
    rows,
    skipped,
    stats: {
      buys: { n: buys.length, hits: buys.filter((r) => r.hit).length, avgRel3m: avg(buys.map((r) => r.rel3m).filter((x): x is number => x != null)) },
      trims: { n: trims.length, hits: trims.filter((r) => r.hit).length, avgRel3m: avg(trims.map((r) => r.rel3m).filter((x): x is number => x != null)) },
    },
  };

  await redis.set(CACHE_KEY, JSON.stringify(result));
  return result;
}
