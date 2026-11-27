/**
 * Loader for the signal grid's fundamentals (Nov 2026). One batched FactSet
 * pull for every individual stock we hold, watch or have staged as Suggested,
 * plus the P/E of every S&P 500 + TSX 60 constituent for the market and
 * sector medians.
 *
 * Redis: pm:signal-fundamentals — a PURE REGENERABLE CACHE (safe to nuke).
 * Reads pm:stocks, pm:stocks-suggested and pm:street-takeaways READ-ONLY.
 * An empty or failed build never replaces a good cache. Feeds the signal grid
 * only — never a score, a weight or a trade.
 */

import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { crossSectional, factsetConfigured } from "./factset";
import { resolveFactsetId } from "./factset-symbols";
import { universeTickers } from "./factor-constituents";
import { normalizeFactsetSector } from "./factset-fundamentals";
import { deriveFundamentals, median, usablePe, type NameFundamentals, type RawFundamentals, type SignalFundamentals } from "./signal-fundamentals-shared";

const log = createLogger("Signal-fundamentals");
export const SIGNAL_FUNDAMENTALS_KEY = "pm:signal-fundamentals";
export const STALE_HOURS = 20;
const CHUNK = 40;
const PAUSE_MS = 250;

// All of these are already validated on our FactSet entitlement (factset-fundamentals.ts).
const F = {
  pe: "FG_PE",
  mktVal: "FG_MKT_VALUE",
  sector: "FG_GICS_SECTOR",
  debt: "FF_DEBT(ANN,0)",
  cash: "FF_CASH_ST(ANN,0)",
  ebitdaLtm: "FF_EBITDA_OPER(LTM,0)",
  ebitdaAnn: "FF_EBITDA_OPER(ANN,0)",
  operIncLtm: "FF_OPER_INC(LTM,0)",
  intExp: "FF_INT_EXP_DEBT(ANN,0)",
  fcfLtm: "FF_FREE_CF(LTM,0)",
  salesLtm: "FF_SALES(LTM,0)",
  salesLtm4: "FF_SALES(LTM,-4)",
  roic: "FF_ROIC(ANN,0)",
  ltg: "FE_ESTIMATE(LTG,MEAN,ANN_ROLL,0,NOW,'')",
} as const;

type Raw = Record<string, Record<string, unknown>>;

async function pull(ids: string[], formulas: string[]): Promise<{ data: Raw; failedChunks: number }> {
  const data: Raw = {};
  let failedChunks = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        Object.assign(data, await crossSectional(chunk, formulas));
        ok = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/returned 429/.test(msg) && attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        else {
          log.warn(`chunk of ${chunk.length} failed:`, msg.slice(0, 160));
          break;
        }
      }
    }
    if (!ok) failedChunks++;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  return { data, failedChunks };
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function readSignalFundamentals(): Promise<SignalFundamentals | null> {
  try {
    const raw = await (await getRedis()).get(SIGNAL_FUNDAMENTALS_KEY);
    const v = raw ? (JSON.parse(raw) as SignalFundamentals) : null;
    return v && typeof v === "object" && v.names ? v : null;
  } catch {
    return null;
  }
}

export type FundamentalsDebug = { raws: Record<string, RawFundamentals>; notOnFactset: string[]; requested: number };

export async function buildSignalFundamentals(debug?: FundamentalsDebug): Promise<SignalFundamentals> {
  if (!factsetConfigured()) throw new Error("FactSet is not configured for this deployment");
  const redis = await getRedis();
  const [stocksRaw, suggestedRaw, streetRaw] = await Promise.all([redis.get("pm:stocks"), redis.get("pm:stocks-suggested"), redis.get("pm:street-takeaways")]);
  const parse = <T,>(raw: string | null, d: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : d;
    } catch {
      return d;
    }
  };
  type S = { ticker: string; instrumentType?: string };
  const all = [...parse<S[]>(stocksRaw, []), ...parse<S[]>(suggestedRaw, [])].filter((x) => x?.ticker && (!x.instrumentType || x.instrumentType === "stock"));
  const tickers = Array.from(new Set(all.map((x) => x.ticker.toUpperCase())));
  const idOf = new Map<string, string>();
  for (const t of tickers) {
    const r = resolveFactsetId(t);
    if (r.source === "factset") idOf.set(t, r.id);
  }
  const notes: string[] = [];

  // 1. The universe's P/E by sector → market and sector medians.
  const uniIds = Array.from(new Set(universeTickers().map((t) => resolveFactsetId(t)).filter((r): r is { source: "factset"; id: string } => r.source === "factset").map((r) => r.id)));
  const uni = await pull(uniIds, [F.pe, F.sector]);
  const bySector: Record<string, number[]> = {};
  const allPe: number[] = [];
  for (const id of uniIds) {
    const pe = n(uni.data[id]?.[F.pe]);
    if (!usablePe(pe)) continue;
    allPe.push(pe);
    const sec = normalizeFactsetSector(s(uni.data[id]?.[F.sector]));
    if (sec) (bySector[sec] ??= []).push(pe);
  }
  const marketPe = allPe.length >= 100 ? median(allPe) : null;
  if (marketPe == null) notes.push(`Market P/E median not formed: only ${allPe.length} of ${uniIds.length} constituents returned a usable P/E.`);
  if (uni.failedChunks) notes.push(`${uni.failedChunks} request batch(es) for the market universe failed.`);
  const sectors: SignalFundamentals["sectors"] = {};
  for (const [sec, xs] of Object.entries(bySector)) {
    const m = median(xs);
    if (m != null && xs.length >= 8) sectors[sec] = { peMedian: parseFloat(m.toFixed(1)), names: xs.length };
  }

  // 2. Our names.
  const ids = Array.from(new Set(idOf.values()));
  const mine = await pull(ids, Object.values(F));
  if (mine.failedChunks) notes.push(`${mine.failedChunks} request batch(es) for our names failed.`);

  // 3. Own 5-year average multiples, from the FactSet analyst round-ups on file.
  const street = parse<Record<string, { date?: string; valuation?: { ntmPe?: number; ntmPeFiveYrAvg?: number; evEbitda?: number; evEbitdaFiveYrAvg?: number } }[]>>(streetRaw, {});
  const valuation = (t: string) => {
    const list = street[t] ?? street[t.replace(/-T$/, ".TO")] ?? street[t.replace(/\.TO$/, "-T")] ?? [];
    return [...list].filter((x) => x?.valuation && (x.valuation.ntmPeFiveYrAvg != null || x.valuation.evEbitdaFiveYrAvg != null)).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0] ?? null;
  };

  const names: Record<string, NameFundamentals> = {};
  let withData = 0;
  for (const t of tickers) {
    const id = idOf.get(t);
    const row = id ? mine.data[id] : undefined;
    if (!row) continue;
    const raw: RawFundamentals = {
      pe: n(row[F.pe]), mktVal: n(row[F.mktVal]), debt: n(row[F.debt]), cash: n(row[F.cash]), ebitdaLtm: n(row[F.ebitdaLtm]), ebitdaAnn: n(row[F.ebitdaAnn]),
      operIncLtm: n(row[F.operIncLtm]), intExp: n(row[F.intExp]), fcfLtm: n(row[F.fcfLtm]), salesLtm: n(row[F.salesLtm]), salesLtm4: n(row[F.salesLtm4]),
      roic: n(row[F.roic]), ltg: n(row[F.ltg]), sector: normalizeFactsetSector(s(row[F.sector])),
    };
    const d = deriveFundamentals(raw, marketPe, raw.sector ? (sectors[raw.sector]?.peMedian ?? null) : null);
    const v = valuation(t);
    if (v?.valuation) {
      d.ntmPe = v.valuation.ntmPe ?? null;
      d.forwardPE5yAvg = v.valuation.ntmPeFiveYrAvg ?? null;
      d.evEbitdaForHistory = v.valuation.evEbitda ?? null;
      d.evEbitda5yAvg = v.valuation.evEbitdaFiveYrAvg ?? null;
      d.valuationAsOf = v.date ?? null;
    }
    if (d.pe != null || d.fcfMargin != null || d.roic != null) withData++;
    names[t] = d;
    if (debug) debug.raws[t] = raw;
  }
  notes.push(`${withData} of ${tickers.length} names returned FactSet figures; ${tickers.length - idOf.size} are not on FactSet (kept on the existing source).`);

  if (debug) {
    debug.notOnFactset = tickers.filter((t) => !idOf.has(t));
    debug.requested = tickers.length;
  }
  const out: SignalFundamentals = { at: new Date().toISOString(), source: "FactSet", market: { peMedian: marketPe != null ? parseFloat(marketPe.toFixed(1)) : null, names: allPe.length }, sectors, names, notes };
  // An empty build never replaces a good cache.
  if (withData > 0) await redis.set(SIGNAL_FUNDAMENTALS_KEY, JSON.stringify(out));
  else throw new Error("FactSet returned no figures for any name; the saved copy was kept");
  log.info(`built: ${withData} names, market P/E ${out.market.peMedian}`);
  return out;
}
