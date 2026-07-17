import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { crossSectional, factsetConfigured, type FactsetValue } from "./factset";
import { resolveFactsetId } from "./factset-symbols";
import { universeTickers, LIST_VERSION } from "./factor-constituents";

/**
 * Factor-universe snapshot (Phase A2) — the cross-sectional measuring stick.
 * Weekly, chunk-resumable fetch of ~560 constituents' factor inputs from the
 * FactSet Formula API (all probe-confirmed items), rolled into winsorized
 * per-GICS-sector distributions that the factor math (A3) z-scores against.
 *
 * Keys (both regenerable caches — safe to nuke, next Sunday rebuilds):
 *   pm:factor-universe          — finished distributions { builtAt, listVersion,
 *                                 sectors: { name: { n, metrics: { key: sorted[] } } } }
 *   pm:factor-universe-progress — mid-build accumulator (cleared on finalize)
 *
 * Strictly additive: reads nothing user-owned, writes only its own caches.
 */

const log = createLogger("FactorUniverse");

export const UNIVERSE_KEY = "pm:factor-universe";
const PROGRESS_KEY = "pm:factor-universe-progress";
const CHUNK = 40;

/** Raw formulas fetched per name — every code probe-confirmed on our entitlement. */
export const RAW_FORMULAS = {
  sector: "FG_GICS_SECTOR",
  mktVal: "FG_MKT_VALUE",
  pe: "FG_PE",
  pbk: "FG_PBK",
  psales: "FG_PSALES",
  sales0: "FF_SALES(ANN,0)",
  sales1: "FF_SALES(ANN,-1)",
  eps0: "FF_EPS(ANN,0)",
  eps1: "FF_EPS(ANN,-1)",
  fcf: "FF_FREE_CF(ANN,0)",
  ocf: "FF_OPER_CF(ANN,0)",
  ni: "FF_NET_INC(ANN,0)",
  operMgn0: "FF_OPER_MGN(ANN,0)",
  operMgn1: "FF_OPER_MGN(ANN,-1)",
  roe: "FF_ROE(ANN,0)",
  debt: "FF_DEBT(ANN,0)",
  ebitda: "FF_EBITDA_OPER(ANN,0)",
  cash: "FF_CASH_ST(ANN,0)",
  intExp: "FF_INT_EXP_DEBT(ANN,0)",
  assets: "FF_ASSETS(ANN,0)",
  // Balance-sheet items for the distress/red-flag layer (probe-confirmed
  // 2026-07-17: FF_COM_EQ_RETAIN_EARN is the entitled retained-earnings code).
  // Fetched from day one so the data exists when the veto factor lands.
  shsOut: "FF_COM_SHS_OUT(ANN,0)",
  wkcap: "FF_WKCAP(ANN,0)",
  retainEarn: "FF_COM_EQ_RETAIN_EARN(ANN,0)",
  ret12m: "P_TOTAL_RETURNC(-12M,0)",
  ret1m: "P_TOTAL_RETURNC(-1M,0)",
} as const;

type RawRow = Partial<Record<Exclude<keyof typeof RAW_FORMULAS, "sector">, number>> & { sector?: string };

/** Derived factor metrics — what the sector distributions are built over. */
export const FACTOR_METRICS = [
  "fcfMargin",      // FCF / sales
  "operMgn",        // operating margin level
  "operMgnTrend",   // margin change y/y (pp)
  "roe",
  "accruals",       // (NI − OCF) / assets — LOWER is better
  "debtEbitda",     // LOWER is better
  "intCoverage",    // EBITDA / interest expense
  "revGrowth",      // sales y/y %
  "epsGrowth",      // EPS y/y %
  "pe",             // LOWER is better
  "pbk",            // LOWER is better
  "psales",         // LOWER is better
  "evEbitda",       // LOWER is better
  "fcfYield",       // FCF / market cap
  "mom12_1",        // 12m total return minus last 1m
] as const;
export type FactorMetric = (typeof FACTOR_METRICS)[number];

/** Metrics where a LOWER value is better (sign-flipped when z-scoring). */
export const LOWER_IS_BETTER: ReadonlySet<FactorMetric> = new Set([
  "accruals", "debtEbitda", "pe", "pbk", "psales", "evEbitda",
]);

export type SectorStats = { n: number; metrics: Partial<Record<FactorMetric, number[]>> };
export type FactorUniverse = {
  builtAt: string;
  listVersion: string;
  tickerCount: number;
  sectors: Record<string, SectorStats>;
};

/** Compute the derived metrics from a raw row. Null-safe: a metric is omitted
 *  when its inputs are missing — absent ≠ zero. */
export function deriveMetrics(r: RawRow): Partial<Record<FactorMetric, number>> {
  const out: Partial<Record<FactorMetric, number>> = {};
  const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  const sales0 = n(r.sales0), sales1 = n(r.sales1), eps0 = n(r.eps0), eps1 = n(r.eps1);
  const fcf = n(r.fcf), ocf = n(r.ocf), ni = n(r.ni), assets = n(r.assets);
  const debt = n(r.debt), ebitda = n(r.ebitda), cash = n(r.cash), intExp = n(r.intExp);
  const mktVal = n(r.mktVal);
  if (fcf != null && sales0 != null && sales0 > 0) out.fcfMargin = (fcf / sales0) * 100;
  if (n(r.operMgn0) != null) out.operMgn = r.operMgn0 as number;
  if (n(r.operMgn0) != null && n(r.operMgn1) != null) out.operMgnTrend = (r.operMgn0 as number) - (r.operMgn1 as number);
  if (n(r.roe) != null) out.roe = r.roe as number;
  if (ni != null && ocf != null && assets != null && assets > 0) out.accruals = ((ni - ocf) / assets) * 100;
  if (debt != null && ebitda != null && ebitda > 0) out.debtEbitda = debt / ebitda;
  if (ebitda != null && intExp != null && intExp > 0) out.intCoverage = Math.min(50, ebitda / intExp);
  if (sales0 != null && sales1 != null && sales1 > 0) out.revGrowth = ((sales0 - sales1) / sales1) * 100;
  if (eps0 != null && eps1 != null && Math.abs(eps1) > 0.01) out.epsGrowth = ((eps0 - eps1) / Math.abs(eps1)) * 100;
  if (n(r.pe) != null && (r.pe as number) > 0) out.pe = r.pe as number;
  if (n(r.pbk) != null && (r.pbk as number) > 0) out.pbk = r.pbk as number;
  if (n(r.psales) != null && (r.psales as number) > 0) out.psales = r.psales as number;
  if (mktVal != null && debt != null && cash != null && ebitda != null && ebitda > 0) {
    out.evEbitda = (mktVal + debt - cash) / ebitda;
  }
  if (fcf != null && mktVal != null && mktVal > 0) out.fcfYield = (fcf / mktVal) * 100;
  const r12 = n(r.ret12m), r1 = n(r.ret1m);
  if (r12 != null && r1 != null) out.mom12_1 = r12 - r1;
  return out;
}

type Progress = {
  listVersion: string;
  startedAt: string;
  doneIds: string[];
  rows: Record<string, RawRow>; // FactSet id → raw row
};

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch { return fb; }
}

/** Winsorize at the 5th/95th percentile, then sort ascending. */
function winsorSort(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length < 8) return sorted;
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return sorted.map((v) => Math.max(lo, Math.min(hi, v)));
}

/**
 * Run one resumable build step within `budgetMs`. Fetches remaining chunks,
 * accumulates progress, finalizes into pm:factor-universe when all ids done.
 */
export async function buildUniverseStep(budgetMs = 40_000): Promise<{
  status: "done" | "in-progress" | "skipped" | "error";
  detail: string;
}> {
  if (!factsetConfigured()) return { status: "skipped", detail: "FactSet relay not configured" };
  const deadline = Date.now() + budgetMs;
  const redis = await getRedis();

  // Resolve the whole universe to FactSet ids (pure, fast).
  const idToTicker = new Map<string, string>();
  for (const t of universeTickers()) {
    const r = resolveFactsetId(t);
    if (r.source === "factset") idToTicker.set(r.id, t);
  }
  const allIds = [...idToTicker.keys()];

  // Load or start progress (restart if the constituent list version changed).
  let prog = parse<Progress | null>(await redis.get(PROGRESS_KEY), null);
  if (!prog || prog.listVersion !== LIST_VERSION) {
    prog = { listVersion: LIST_VERSION, startedAt: new Date().toISOString(), doneIds: [], rows: {} };
  }
  const done = new Set(prog.doneIds);
  const remaining = allIds.filter((id) => !done.has(id));

  const formulaList = Object.values(RAW_FORMULAS);
  let fetched = 0;
  for (let i = 0; i < remaining.length; i += CHUNK) {
    if (Date.now() > deadline) break;
    const chunkIds = remaining.slice(i, i + CHUNK);
    try {
      const data = await crossSectional(chunkIds, formulaList as unknown as string[]);
      for (const id of chunkIds) {
        const row = data[id];
        const out: RawRow = {};
        if (row) {
          for (const [key, formula] of Object.entries(RAW_FORMULAS)) {
            const v: FactsetValue | undefined = row[formula];
            if (key === "sector") {
              if (typeof v === "string" && v) out.sector = v;
            } else if (typeof v === "number" && isFinite(v)) {
              (out as Record<string, number>)[key] = v;
            }
          }
        }
        prog.rows[id] = out;
        done.add(id);
        fetched++;
      }
    } catch (e) {
      log.warn(`chunk failed (will retry next ping):`, e instanceof Error ? e.message : e);
      break; // keep progress; retry on the next ping
    }
  }
  prog.doneIds = [...done];
  await redis.set(PROGRESS_KEY, JSON.stringify(prog));

  if (prog.doneIds.length < allIds.length) {
    return { status: "in-progress", detail: `${prog.doneIds.length}/${allIds.length} ids (${fetched} this ping)` };
  }

  // ── Finalize: derive metrics, group by sector, winsorize + sort ──
  const sectors: Record<string, SectorStats> = {};
  const perSectorValues: Record<string, Partial<Record<FactorMetric, number[]>>> = {};
  let usable = 0;
  for (const [, row] of Object.entries(prog.rows)) {
    const sector = row.sector;
    if (!sector) continue;
    const m = deriveMetrics(row);
    if (Object.keys(m).length === 0) continue;
    usable++;
    const bucket = (perSectorValues[sector] ??= {});
    for (const [k, v] of Object.entries(m)) {
      ((bucket as Record<string, number[]>)[k] ??= []).push(v as number);
    }
  }
  for (const [sector, metrics] of Object.entries(perSectorValues)) {
    const stats: SectorStats = { n: 0, metrics: {} };
    for (const [k, vals] of Object.entries(metrics)) {
      if ((vals as number[]).length >= 8) {
        (stats.metrics as Record<string, number[]>)[k] = winsorSort(vals as number[]);
        stats.n = Math.max(stats.n, (vals as number[]).length);
      }
    }
    if (stats.n > 0) sectors[sector] = stats;
  }

  const universe: FactorUniverse = {
    builtAt: new Date().toISOString(),
    listVersion: LIST_VERSION,
    tickerCount: usable,
    sectors,
  };
  await redis.set(UNIVERSE_KEY, JSON.stringify(universe));
  await redis.set(PROGRESS_KEY, JSON.stringify({ listVersion: LIST_VERSION, startedAt: prog.startedAt, doneIds: [], rows: {} }));
  log.info(`universe built: ${usable} names, ${Object.keys(sectors).length} sectors`);
  return { status: "done", detail: `${usable} names, ${Object.keys(sectors).length} sectors` };
}

export async function readUniverse(): Promise<FactorUniverse | null> {
  const redis = await getRedis();
  return parse<FactorUniverse | null>(await redis.get(UNIVERSE_KEY), null);
}
