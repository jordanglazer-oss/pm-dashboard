import { getRedis } from "./redis";
import type { FundOnePager, FundOnePagerStore, FundRow } from "./fund-one-pagers-shared";
import { holdingBucket } from "./sleeve-targets";
import { tickersEqual } from "./ticker";
import type { PimModelData } from "./pim-types";
import type { FundData } from "./types";

/**
 * Fund one-pagers (Nov 2026) — a client-ready "why we own it" page per fund /
 * ETF in the PIM model: the manager, the process, the role in the portfolio,
 * the record against the category, fees, risks and talking points. English.
 *
 * Store `pm:fund-one-pagers` = { pagers: { [SYMBOL]: FundOnePager } }.
 * Written ONLY by POST /api/fund-one-pagers (the PM signing ONE fund —
 * read-merge-write of that symbol; the prior version goes into `history`,
 * ≤ 6). Drafts (POST /api/fund-one-pagers/draft, main key + web search)
 * write nothing. BACKED UP.
 */

export const FUND_ONE_PAGERS_KEY = "pm:fund-one-pagers";
const MAX_HISTORY = 6;

export async function loadOnePagers(): Promise<FundOnePagerStore> {
  try {
    const raw = await (await getRedis()).get(FUND_ONE_PAGERS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && v.pagers && typeof v.pagers === "object" ? (v as FundOnePagerStore) : { pagers: {} };
  } catch {
    return { pagers: {} };
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, max)).slice(0, n) : [];

/** Keep only known fields, trimmed — used for both drafts and saves. */
export function sanitizePager(raw: Record<string, unknown>, symbol: string): Omit<FundOnePager, "updatedAt" | "signedAt" | "history"> {
  const m = (raw.manager && typeof raw.manager === "object" ? raw.manager : {}) as Record<string, unknown>;
  const sources = Array.isArray(raw.sources)
    ? (raw.sources as unknown[])
        .map((s) => (typeof s === "string" ? { url: s } : s && typeof s === "object" ? { url: str((s as Record<string, unknown>).url, 400), title: str((s as Record<string, unknown>).title, 160) || undefined } : null))
        .filter((s): s is { url: string; title?: string } => !!s && /^https?:\/\//.test(s.url))
        .slice(0, 10)
    : [];
  return {
    symbol: symbol.toUpperCase(),
    name: str(raw.name, 120),
    headline: str(raw.headline, 240),
    whyWeOwn: strList(raw.whyWeOwn, 5, 400),
    manager: { firm: str(m.firm, 120), team: str(m.team, 240), since: str(m.since, 60), philosophy: str(m.philosophy, 600) },
    process: str(raw.process, 900),
    role: str(raw.role, 500),
    record: str(raw.record, 700),
    fees: str(raw.fees, 300),
    risks: strList(raw.risks, 5, 300),
    talkingPoints: strList(raw.talkingPoints, 6, 300),
    watch: str(raw.watch, 400),
    sources,
    aiDrafted: raw.aiDrafted === true,
  };
}

export async function saveOnePager(symbol: string, raw: Record<string, unknown>): Promise<FundOnePager> {
  const redis = await getRedis();
  const cur = await redis.get(FUND_ONE_PAGERS_KEY);
  let store: FundOnePagerStore & Record<string, unknown> = { pagers: {} };
  if (cur) {
    const parsed = JSON.parse(cur); // throws on a corrupt blob — never overwrite it
    store = parsed && typeof parsed === "object" && parsed.pagers ? parsed : { ...parsed, pagers: {} };
  }
  const key = symbol.toUpperCase();
  const prev = store.pagers[key];
  const now = new Date().toISOString();
  const clean = sanitizePager(raw, key);
  const history = prev
    ? [...(prev.history ?? []), { savedAt: prev.updatedAt, headline: prev.headline, whyWeOwn: prev.whyWeOwn, talkingPoints: prev.talkingPoints }].slice(-MAX_HISTORY)
    : [];
  const next: FundOnePager = { ...clean, updatedAt: now, signedAt: now, ...(history.length ? { history } : {}) };
  await redis.set(FUND_ONE_PAGERS_KEY, JSON.stringify({ ...store, pagers: { ...store.pagers, [key]: next } }));
  return next;
}

// ── The funds in the PIM model, with their stored facts ─────────────────────


type StockLite = { ticker: string; name?: string; instrumentType?: string; designation?: "core" | "alpha" | "thematic"; fundData?: FundData; manualExpenseRatio?: number };

export async function loadFundRows(): Promise<FundRow[]> {
  const redis = await getRedis();
  const [modelsRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks")]);
  let models: PimModelData | null = null;
  let stocks: StockLite[] = [];
  try {
    models = modelsRaw ? JSON.parse(modelsRaw) : null;
    const s = stocksRaw ? JSON.parse(stocksRaw) : [];
    stocks = Array.isArray(s) ? s : [];
  } catch {
    return [];
  }
  const pim = models?.groups?.find((g) => g.id === "pim");
  const rows: FundRow[] = [];
  for (const h of pim?.holdings ?? []) {
    if (!(h.weightInClass > 0)) continue;
    const s = stocks.find((x) => x.ticker && tickersEqual(x.ticker, h.symbol));
    const eqBucket = h.assetClass === "equity" ? holdingBucket(h, stocks) : null;
    if (eqBucket === "alpha") continue; // individual stocks are not funds
    if (s?.instrumentType === "stock") continue;
    const fd = s?.fundData;
    rows.push({
      symbol: h.symbol,
      name: s?.name ?? h.name,
      bucket: eqBucket === "core" ? "core" : eqBucket === "thematic" ? "thematic" : h.assetClass === "fixedIncome" ? "fixedIncome" : "other",
      weightInClass: h.weightInClass,
      assetClass: h.assetClass,
      facts: {
        ...(fd?.category ? { category: fd.category } : {}),
        ...(fd?.fundFamily ? { fundFamily: fd.fundFamily } : {}),
        ...(typeof (s?.manualExpenseRatio ?? fd?.expenseRatio) === "number" ? { expenseRatio: s?.manualExpenseRatio ?? fd?.expenseRatio } : {}),
        ...(typeof fd?.totalAssets === "number" ? { aum: fd.totalAssets } : {}),
        ...(typeof fd?.starRating === "number" ? { starRating: fd.starRating } : {}),
        ...(fd?.performance ? { perf: { oneYear: fd.performance.oneYear, threeYear: fd.performance.threeYear, fiveYear: fd.performance.fiveYear } } : {}),
        ...(fd?.categoryPerformance ? { categoryPerf: { oneYear: fd.categoryPerformance.oneYear, threeYear: fd.categoryPerformance.threeYear, fiveYear: fd.categoryPerformance.fiveYear } } : {}),
        ...(fd?.topHoldings?.length ? { topHoldings: fd.topHoldings.slice(0, 10) } : {}),
        ...(fd?.lastUpdated ? { asOf: fd.lastUpdated.slice(0, 10) } : {}),
      },
    });
  }
  const order = { thematic: 0, core: 1, fixedIncome: 2, other: 3 } as const;
  return rows.sort((a, b) => order[a.bucket] - order[b.bucket] || b.weightInClass - a.weightInClass);
}
