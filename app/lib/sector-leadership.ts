/**
 * Sector / subsector leadership — the market-context layer for the
 * Synthesis screen (and any future consumer that wants "what's leading
 * and what's lagging" instead of a single regime label).
 *
 * Fetches 6 months of daily closes for SPY, the 11 GICS sector SPDRs,
 * and ~20 liquid industry ETFs from Yahoo's anonymous /v8/finance/chart
 * endpoint, then computes trailing 1W / 1M / 3M total-price returns.
 *
 * Redis: caches the result at `pm:sector-leadership-cache` (pure
 * regenerable cache — matches the `-cache$` backup exclude, safe to
 * nuke; next call rebuilds). Refreshed lazily when older than 12h or
 * when force=true. No other keys touched.
 */

import { getRedis } from "./redis";
import { createLogger } from "./logger";

const log = createLogger("Sector-leadership");

export const SECTOR_LEADERSHIP_KEY = "pm:sector-leadership-cache";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type LeadershipKind = "benchmark" | "sector" | "industry";

export type LeadershipRow = {
  symbol: string;
  label: string;
  kind: LeadershipKind;
  /** Trailing returns in percent (e.g. 4.2 = +4.2%). Null when history is short. */
  r1w: number | null;
  r1m: number | null;
  r3m: number | null;
};

export type SectorLeadership = {
  builtAt: string; // ISO
  rows: LeadershipRow[];
};

const UNIVERSE: { symbol: string; label: string; kind: LeadershipKind }[] = [
  { symbol: "SPY", label: "S&P 500", kind: "benchmark" },
  // 11 GICS sector SPDRs
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
  // Liquid industry / theme ETFs
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

/** Yahoo sector string (or FactSet-normalized equivalent) → sector SPDR. */
const SECTOR_TO_ETF: Record<string, string> = {
  technology: "XLK",
  "information technology": "XLK",
  "financial services": "XLF",
  financials: "XLF",
  healthcare: "XLV",
  "health care": "XLV",
  "consumer cyclical": "XLY",
  "consumer discretionary": "XLY",
  "consumer defensive": "XLP",
  "consumer staples": "XLP",
  industrials: "XLI",
  energy: "XLE",
  "basic materials": "XLB",
  materials: "XLB",
  "communication services": "XLC",
  "communication-services": "XLC",
  utilities: "XLU",
  "real estate": "XLRE",
};

export function sectorEtfFor(sector: string | undefined | null): string | null {
  if (!sector) return null;
  return SECTOR_TO_ETF[sector.trim().toLowerCase()] ?? null;
}

async function fetchCloses(symbol: string): Promise<number[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const data = (await res.json()) as {
    chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c): c is number => typeof c === "number" && isFinite(c));
}

function trailingReturn(closes: number[], tradingDays: number): number | null {
  if (closes.length < tradingDays + 1) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - tradingDays];
  if (!prior) return null;
  return +(((last - prior) / prior) * 100).toFixed(2);
}

async function build(): Promise<SectorLeadership> {
  const rows: LeadershipRow[] = [];
  // Small concurrency so a page of ETFs doesn't hammer Yahoo.
  const queue = [...UNIVERSE];
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const closes = await fetchCloses(item.symbol);
        rows.push({
          ...item,
          r1w: trailingReturn(closes, 5),
          r1m: trailingReturn(closes, 21),
          r3m: trailingReturn(closes, 63),
        });
      } catch (e) {
        log.warn(`fetch failed for ${item.symbol}:`, e);
        rows.push({ ...item, r1w: null, r1m: null, r3m: null });
      }
    }
  });
  await Promise.all(workers);
  const order = new Map(UNIVERSE.map((u, i) => [u.symbol, i]));
  rows.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
  return { builtAt: new Date().toISOString(), rows };
}

export async function getSectorLeadership(force = false): Promise<SectorLeadership> {
  const redis = await getRedis();
  if (!force) {
    try {
      const raw = await redis.get(SECTOR_LEADERSHIP_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as SectorLeadership;
        if (Date.now() - new Date(cached.builtAt).getTime() < MAX_AGE_MS) return cached;
      }
    } catch (e) {
      log.warn("cache read failed:", e);
    }
  }
  const fresh = await build();
  const usable = fresh.rows.filter((r) => r.r1m != null).length;
  if (usable < 10) {
    // Yahoo mostly failed — serve the stale cache if one exists rather than
    // caching a junk build.
    try {
      const raw = await redis.get(SECTOR_LEADERSHIP_KEY);
      if (raw) return JSON.parse(raw) as SectorLeadership;
    } catch {
      /* fall through */
    }
    return fresh;
  }
  try {
    await redis.set(SECTOR_LEADERSHIP_KEY, JSON.stringify(fresh));
  } catch (e) {
    log.warn("cache write failed:", e);
  }
  return fresh;
}

/** Rank of a sector ETF among the 11 sectors by 3M return (1 = best). */
export function sectorRank(data: SectorLeadership, etf: string): { rank: number; of: number } | null {
  const sectors = data.rows.filter((r) => r.kind === "sector" && r.r3m != null);
  const sorted = [...sectors].sort((a, b) => (b.r3m ?? 0) - (a.r3m ?? 0));
  const idx = sorted.findIndex((r) => r.symbol === etf);
  if (idx < 0) return null;
  return { rank: idx + 1, of: sorted.length };
}

const fmt = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/** Compact prompt block: full sector table + top/bottom industries. */
export function formatLeadershipForPrompt(data: SectorLeadership): string {
  const spy = data.rows.find((r) => r.symbol === "SPY");
  const sectors = [...data.rows.filter((r) => r.kind === "sector")].sort(
    (a, b) => (b.r3m ?? -999) - (a.r3m ?? -999),
  );
  const industries = data.rows.filter((r) => r.kind === "industry" && r.r3m != null);
  const byR3m = [...industries].sort((a, b) => (b.r3m ?? 0) - (a.r3m ?? 0));
  const top = byR3m.slice(0, 6);
  const bottom = byR3m.slice(-6).reverse();

  const line = (r: LeadershipRow) =>
    `  ${r.label} (${r.symbol}): 1W ${fmt(r.r1w)} | 1M ${fmt(r.r1m)} | 3M ${fmt(r.r3m)}`;

  return [
    `=== SECTOR / SUBSECTOR LEADERSHIP (as of ${data.builtAt.slice(0, 10)}) ===`,
    spy ? `Benchmark — ${line(spy).trim()}` : "",
    "Sectors, ranked by 3M return:",
    ...sectors.map(line),
    "Leading industries (3M):",
    ...top.map(line),
    "Lagging industries (3M):",
    ...bottom.map(line),
  ]
    .filter(Boolean)
    .join("\n");
}
