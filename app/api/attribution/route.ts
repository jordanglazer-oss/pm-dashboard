import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import {
  decompose,
  returnOverPeriod,
  computeContributions,
  PERIODS,
  type ReturnDecomposition,
  type ContributionBreakdown,
  type ValuePoint,
  type PeriodKey,
} from "@/app/lib/attribution";

/**
 * GET /api/attribution — performance attribution (Phase 04, view 1: the
 * return decomposition Total = Market(beta) + Currency + Selection).
 *
 * Reads pm:appendix-daily-values (per-profile CAD cumulative value series) and
 * pm:stocks (equity book beta + USD sleeve) READ-ONLY; fetches S&P 500 /
 * S&P/TSX / USD-CAD histories from Yahoo. Caches the assembled result in
 * pm:attribution-cache (regenerable — safe to nuke). No live data mutated.
 *
 * ?refresh=1 forces a rebuild (12h freshness otherwise).
 */

const log = createLogger("Attribution");
const CACHE_KEY = "pm:attribution-cache";
const STALE_MS = 12 * 60 * 60 * 1000;

// Structural equity share per profile (matches CLAUDE.md / pim-seed). Used to
// scale the equity book's beta + USD exposure down for lower-equity profiles,
// so "market contribution" isn't overstated for e.g. Conservative.
const PROFILE_EQUITY: Record<string, number> = {
  conservative: 0.3,
  balanced: 0.66,
  growth: 0.83,
  allEquity: 1.0,
  alpha: 1.0,
  core: 1.0,
};

const PROFILE_LABEL: Record<string, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
  core: "Core",
};

type Ledger = { profile?: string; entries?: Array<{ date?: string; value?: number }> };
type StoredStock = {
  ticker?: string;
  bucket?: string;
  beta?: number;
  currency?: string;
  sector?: string;
  price?: number;
  currentPrice?: number;
};
type StoredPosition = { symbol?: string; units?: number; costBasis?: number };
type PositionLedger = { profile?: string; positions?: StoredPosition[] };

function isCad(ticker: string, currency?: string): boolean {
  if (currency) return currency.toUpperCase() === "CAD";
  return /(\.(TO|V|NE|CN))$/i.test(ticker) || /-T$/i.test(ticker);
}

/** Normalise a ticker/symbol so PIM positions match pm:stocks across the
 *  -T / .TO / .V / .NE / .U suffix variants. */
function normTicker(t: string): string {
  return t
    .toUpperCase()
    .replace(/\.(TO|V|NE|CN|U)$/i, "")
    .replace(/-T$/i, "");
}

/** Fetch a Yahoo daily close history as an ascending ValuePoint[] series. */
async function fetchYahooHistory(symbol: string): Promise<ValuePoint[]> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=2y&interval=1d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const ts: number[] = result?.timestamp || [];
  const closes: number[] = result?.indicators?.quote?.[0]?.close || [];
  const out: ValuePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number" && isFinite(c)) {
      out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: c });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";
  const redis = await getRedis();

  let cached: unknown = null;
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    log.warn("cache read failed:", e instanceof Error ? e.message : e);
  }
  const cachedObj = cached as { builtAt?: string } | null;
  const fresh =
    cachedObj?.builtAt && Date.now() - new Date(cachedObj.builtAt).getTime() < STALE_MS;
  if (fresh && !forceRefresh) {
    return NextResponse.json({ attribution: cached, cached: true });
  }

  try {
    // ── Portfolio value series per profile ──
    let ledgers: Ledger[] = [];
    try {
      const raw = await redis.get("pm:appendix-daily-values");
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.ledgers)) ledgers = parsed.ledgers as Ledger[];
    } catch (e) {
      log.warn("appendix read failed:", e instanceof Error ? e.message : e);
    }

    // ── Equity book beta + USD sleeve + price/sector lookup from pm:stocks ──
    let equityBeta = 1;
    let usdEquityFraction = 0;
    const stockLookup = new Map<
      string,
      { ticker: string; sector: string; currency: "CAD" | "USD"; price: number | null }
    >();
    try {
      const raw = await redis.get("pm:stocks");
      const parsed = raw ? JSON.parse(raw) : [];
      const all = Array.isArray(parsed) ? (parsed as StoredStock[]) : [];
      for (const s of all) {
        if (!s.ticker) continue;
        const price = typeof s.price === "number" ? s.price : typeof s.currentPrice === "number" ? s.currentPrice : null;
        stockLookup.set(normTicker(s.ticker), {
          ticker: s.ticker,
          sector: s.sector || "Unclassified",
          currency: isCad(s.ticker, s.currency) ? "CAD" : "USD",
          price,
        });
      }
      const port = all.filter((s) => s.bucket === "Portfolio" && s.ticker);
      if (port.length > 0) {
        const betas = port.map((s) => (typeof s.beta === "number" && s.beta > 0 ? s.beta : 1));
        equityBeta = betas.reduce((a, b) => a + b, 0) / betas.length;
        const usd = port.filter((s) => !isCad(s.ticker!, s.currency)).length;
        usdEquityFraction = usd / port.length;
      }
    } catch (e) {
      log.warn("stocks read failed:", e instanceof Error ? e.message : e);
    }

    // ── PIM positions (for cost-basis contributions, view 2) ──
    const positionsByProfile = new Map<string, StoredPosition[]>();
    try {
      const raw = await redis.get("pm:pim-positions");
      const parsed = raw ? JSON.parse(raw) : [];
      const arr = Array.isArray(parsed) ? (parsed as PositionLedger[]) : [];
      for (const pl of arr) {
        if (!pl.profile || !Array.isArray(pl.positions)) continue;
        const list = positionsByProfile.get(pl.profile) ?? [];
        list.push(...pl.positions);
        positionsByProfile.set(pl.profile, list);
      }
    } catch (e) {
      log.warn("positions read failed:", e instanceof Error ? e.message : e);
    }

    // ── Benchmarks + FX (Yahoo) ──
    const [sp500, tsx, usdcad] = await Promise.all([
      fetchYahooHistory("^GSPC").catch(() => [] as ValuePoint[]),
      fetchYahooHistory("^GSPTSE").catch(() => [] as ValuePoint[]),
      fetchYahooHistory("USDCAD=X").catch(() => [] as ValuePoint[]),
    ]);

    const ref = new Date();
    const benchmarkReturns = (period: PeriodKey) => [
      { label: "S&P 500", returnPct: returnOverPeriod(sp500, period, ref) },
      { label: "S&P/TSX Composite", returnPct: returnOverPeriod(tsx, period, ref) },
    ];

    // Latest USD/CAD rate for converting USD position values to CAD (weighting).
    const usdcadRate = usdcad.length > 0 ? usdcad[usdcad.length - 1].value : null;

    const profiles: Array<{
      profile: string;
      label: string;
      periods: ReturnDecomposition[];
      contributions: ContributionBreakdown | null;
      contributionsExcluded: number;
    }> = [];
    for (const led of ledgers) {
      const profile = led.profile;
      if (!profile || !Array.isArray(led.entries) || led.entries.length < 2) continue;
      const series: ValuePoint[] = led.entries
        .filter((e) => typeof e.date === "string" && typeof e.value === "number")
        .map((e) => ({ date: e.date as string, value: e.value as number }));
      const equityAlloc = PROFILE_EQUITY[profile] ?? 1;
      const effectiveBeta = equityBeta * equityAlloc;
      const usdSleevePct = usdEquityFraction * equityAlloc * 100;

      const periods = PERIODS.map((period) =>
        decompose({
          period,
          profile,
          portfolioReturnPct: returnOverPeriod(series, period, ref),
          portfolioBeta: effectiveBeta,
          usdSleeveWeightPct: usdSleevePct,
          usdcadReturnPct: returnOverPeriod(usdcad, period, ref),
          benchmarks: benchmarkReturns(period),
        }),
      );

      // View 2 — cost-basis contributions. Match each PIM position to a stock
      // for its live price + sector + currency; positions with no price match
      // (funds/ETFs not in pm:stocks) are excluded and counted.
      let contributions: ContributionBreakdown | null = null;
      let contributionsExcluded = 0;
      const positions = positionsByProfile.get(profile) ?? [];
      if (positions.length > 0) {
        const rows = [];
        for (const p of positions) {
          if (!p.symbol || typeof p.units !== "number" || typeof p.costBasis !== "number") {
            contributionsExcluded++;
            continue;
          }
          const stock = stockLookup.get(normTicker(p.symbol));
          if (!stock || stock.price == null) {
            contributionsExcluded++;
            continue;
          }
          const fx = stock.currency === "USD" ? (usdcadRate ?? 1) : 1;
          rows.push({
            ticker: stock.ticker,
            sector: stock.sector,
            currency: stock.currency,
            marketValueCad: p.units * stock.price * fx,
            costBasisNative: p.costBasis,
            priceNative: stock.price,
          });
        }
        if (rows.length > 0) contributions = computeContributions(rows);
      }

      profiles.push({
        profile,
        label: PROFILE_LABEL[profile] ?? profile,
        periods,
        contributions,
        contributionsExcluded,
      });
    }

    const attribution = {
      builtAt: ref.toISOString(),
      equityBeta,
      usdEquityFractionPct: usdEquityFraction * 100,
      fxAvailable: usdcad.length > 0,
      benchmarksAvailable: { sp500: sp500.length > 0, tsx: tsx.length > 0 },
      profiles,
    };

    try {
      await redis.set(CACHE_KEY, JSON.stringify(attribution));
    } catch (e) {
      log.warn("cache write failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ attribution, cached: false });
  } catch (e) {
    log.error("rebuild failed:", e);
    if (cached) return NextResponse.json({ attribution: cached, cached: true, stale: true });
    return NextResponse.json({ attribution: null, error: "attribution unavailable" }, { status: 503 });
  }
}
