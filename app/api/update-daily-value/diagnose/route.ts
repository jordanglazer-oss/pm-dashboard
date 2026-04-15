import { NextResponse, NextRequest } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { getTodayET, isMarketOpenOrAfterET } from "@/app/lib/market-hours";
import type {
  PimProfileType,
  PimProfileWeights,
  PimModelGroup,
} from "@/app/lib/pim-types";

/**
 * GET /api/update-daily-value/diagnose?groupId=pim&profile=balanced
 *
 * Read-only diagnostic. Replays the today-only calculation that
 * /api/update-daily-value performs, but does NOT write to Redis and
 * does NOT mutate any ledger.
 *
 * Returns a per-holding breakdown (prev price, current price, local
 * return, FX change, CAD return, portfolio weight, contribution) plus
 * the final weighted return so we can compare it side by side against
 * the live "Today" tile in the UI. Used to diagnose Appendix-vs-live
 * mismatches without touching production code paths.
 *
 * Purely a debug endpoint. Safe to call from a browser.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PIM_KEY = "pm:pim-models";
const POSITIONS_KEY = "pm:pim-positions";

type DailyPriceData = { date: string; adjClose: number };
type SymbolPriceResult = { history: DailyPriceData[]; chartPreviousClose: number | null };

async function fetchAdjustedCloses(symbol: string, range: string = "5d"): Promise<SymbolPriceResult> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return { history: [], chartPreviousClose: null };

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return { history: [], chartPreviousClose: null };
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return { history: [], chartPreviousClose: null };
    const timestamps: number[] = r.timestamp || [];
    const adjCloses: number[] = r.indicators?.adjclose?.[0]?.adjclose || [];
    const closes: number[] = r.indicators?.quote?.[0]?.close || [];
    const result: DailyPriceData[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = adjCloses[i] ?? closes[i];
      if (price == null || isNaN(price)) continue;
      const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      result.push({ date: d, adjClose: price });
    }
    const meta = r.meta;
    const livePrice = meta?.regularMarketPrice;
    const chartPrevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    if (livePrice && !isNaN(livePrice)) {
      const today = getTodayET();
      const todayIdx = result.findIndex((p) => p.date === today);
      if (todayIdx >= 0) result[todayIdx].adjClose = livePrice;
      else result.push({ date: today, adjClose: livePrice });
    }
    return { history: result, chartPreviousClose: chartPrevClose };
  } catch {
    return { history: [], chartPreviousClose: null };
  }
}

async function fetchFundservCloses(ticker: string): Promise<DailyPriceData[]> {
  const symbol = `${ticker}.CF`;
  const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(symbol)}&data=daily&maxrecords=15&volume=contract&order=desc&dividends=false&backadjust=false`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        Referer: "https://www.theglobeandmail.com/",
      },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const result: DailyPriceData[] = [];
    for (const line of text.trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length < 6) continue;
      const close = parseFloat(parts[5]);
      if (!isFinite(close)) continue;
      const rawDate = parts[1]?.trim();
      if (!rawDate) continue;
      let isoDate: string;
      if (rawDate.includes("/")) {
        const dp = rawDate.split("/");
        if (dp.length !== 3) continue;
        isoDate = `${dp[2]}-${dp[0].padStart(2, "0")}-${dp[1].padStart(2, "0")}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        isoDate = rawDate;
      } else {
        continue;
      }
      result.push({ date: isoDate, adjClose: close });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

async function fetchUsdCad(range: string = "5d"): Promise<{ live: number | null; previousClose: number | null }> {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/USDCAD=X?range=${range}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return { live: null, previousClose: null };
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return { live: null, previousClose: null };
    const live = r.meta?.regularMarketPrice ?? null;
    const prev = r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? null;
    return { live, previousClose: prev };
  } catch {
    return { live: null, previousClose: null };
  }
}

function isFundserv(symbol: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(symbol);
}

function getAssetAlloc(pw: PimProfileWeights, assetClass: string): number {
  if (assetClass === "fixedIncome") return pw.fixedIncome;
  if (assetClass === "equity") return pw.equity;
  if (assetClass === "alternative") return pw.alternatives;
  return 0;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get("groupId") || "pim";
    const profile = (searchParams.get("profile") || "balanced") as PimProfileType;

    const redis = await getRedis();
    const [pimRaw, positionsRaw, stocksRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(POSITIONS_KEY),
      redis.get("pm:stocks"),
    ]);

    if (!pimRaw) return NextResponse.json({ error: "No PIM model data" }, { status: 400 });

    const pimData = JSON.parse(pimRaw) as { groups: PimModelGroup[] };
    const group = pimData.groups.find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: `Group not found: ${groupId}` }, { status: 404 });

    type StockEntry = { ticker: string; designation?: "core" | "alpha" };
    const stocksList: StockEntry[] = stocksRaw ? JSON.parse(stocksRaw) : [];
    const coreSymbols = new Set<string>();
    for (const s of stocksList) if (s.designation === "core") coreSymbols.add(s.ticker);

    function pimSymbolToTicker(symbol: string): string {
      if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
      return symbol;
    }

    type PositionEntry = { symbol: string; units: number; costBasis: number };
    type PortfolioPositions = { groupId: string; profile: string; positions: PositionEntry[]; cashBalance: number };
    const positionsData: { portfolios: PortfolioPositions[] } = positionsRaw
      ? JSON.parse(positionsRaw)
      : { portfolios: [] };

    const today = getTodayET();
    const marketOpen = isMarketOpenOrAfterET();

    const isAlpha = profile === "alpha";
    const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
    const profileWeights = isAlpha ? ALPHA_WEIGHTS : group.profiles[profile];
    if (!profileWeights) {
      return NextResponse.json({ error: `Profile weights not found: ${profile}` }, { status: 404 });
    }

    // Pick the holdings subset consistent with /api/update-daily-value
    const effectiveHoldings = isAlpha
      ? (() => {
          const alphaH = group.holdings.filter(
            (h) => h.assetClass === "equity" && !coreSymbols.has(pimSymbolToTicker(h.symbol))
          );
          const total = alphaH.reduce((s, h) => s + h.weightInClass, 0);
          return total > 0 ? alphaH.map((h) => ({ ...h, weightInClass: h.weightInClass / total })) : alphaH;
        })()
      : group.holdings;

    // Fetch prices for all holdings in this profile
    const priceHistories = new Map<string, DailyPriceData[]>();
    const chartPreviousCloses = new Map<string, number>();
    const symbols = effectiveHoldings.map((h) => h.symbol);
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (s) => {
          if (isFundserv(s)) {
            return { symbol: s, history: await fetchFundservCloses(s), chartPreviousClose: null as number | null };
          }
          const res = await fetchAdjustedCloses(s, "5d");
          return { symbol: s, ...res };
        })
      );
      for (const r of results) {
        if (r.history.length > 0) priceHistories.set(r.symbol, r.history);
        if (r.chartPreviousClose != null) chartPreviousCloses.set(r.symbol, r.chartPreviousClose);
      }
    }

    const { live: usdCadLive, previousClose: usdCadPrev } = await fetchUsdCad("5d");
    const fxChange = usdCadLive && usdCadPrev && usdCadPrev > 0
      ? (usdCadLive - usdCadPrev) / usdCadPrev
      : 0;

    // Portfolio weights: live weights from positions if available; otherwise target
    const portfolio = positionsData.portfolios.find(
      (p) => p.groupId === groupId && p.profile === profile
    );
    const hasPositions = !!portfolio && portfolio.positions.length > 0;

    type HoldingW = typeof effectiveHoldings[0] & { portfolioWeight: number };
    let holdingsWithWeight: HoldingW[];

    if (hasPositions && portfolio) {
      const latestPrices = new Map<string, number>();
      for (const h of effectiveHoldings) {
        const hist = priceHistories.get(h.symbol);
        if (hist && hist.length > 0) latestPrices.set(h.symbol, hist[hist.length - 1].adjClose);
      }
      const latestFxRate = usdCadLive ?? 1;

      const holdingCurrency = new Map<string, string>();
      for (const h of effectiveHoldings) holdingCurrency.set(h.symbol, h.currency);

      const effectiveSymbols = new Set(effectiveHoldings.map((h) => h.symbol));
      let totalPortfolioValue = portfolio.cashBalance || 0;
      const positionValues = new Map<string, number>();
      for (const pos of portfolio.positions) {
        if (!effectiveSymbols.has(pos.symbol)) continue;
        const price = latestPrices.get(pos.symbol) || 0;
        let value = pos.units * price;
        if (holdingCurrency.get(pos.symbol) === "USD") value *= latestFxRate;
        positionValues.set(pos.symbol, value);
        totalPortfolioValue += value;
      }
      holdingsWithWeight = effectiveHoldings
        .map((h) => ({
          ...h,
          portfolioWeight: totalPortfolioValue > 0 ? (positionValues.get(h.symbol) || 0) / totalPortfolioValue : 0,
        }))
        .filter((h) => h.portfolioWeight > 0);
    } else {
      holdingsWithWeight = effectiveHoldings
        .map((h) => {
          const alloc = getAssetAlloc(profileWeights, h.assetClass);
          return { ...h, portfolioWeight: h.weightInClass * alloc };
        })
        .filter((h) => h.portfolioWeight > 0);
    }

    const totalWeight = holdingsWithWeight.reduce((s, h) => s + h.portfolioWeight, 0);

    // Build per-holding price maps keyed on date
    const holdingPriceMaps = new Map<string, Map<string, number>>();
    for (const h of holdingsWithWeight) {
      const hist = priceHistories.get(h.symbol);
      if (!hist) continue;
      const pm = new Map<string, number>();
      for (const p of hist) pm.set(p.date, p.adjClose);
      holdingPriceMaps.set(h.symbol, pm);
    }

    // Compute per-holding contributions for today
    type Row = {
      symbol: string;
      currency: "CAD" | "USD";
      assetClass: string;
      units: number | null;
      portfolioWeight: number;
      normWeight: number;
      prevPrice: number | null;
      curPrice: number | null;
      prevPriceSource: string;
      // Both candidate prev prices, for bug-hunting: if these don't
      // agree, chartPreviousClose from range=5d/15d is wrong (it returns
      // the close before the START of the chart range, not yesterday).
      chartPrevClose: number | null;
      historyPrevClose: number | null;
      historyPrevDate: string | null;
      localReturnPct: number | null;
      cadReturnPct: number | null;
      contributionPct: number;
      note?: string;
    };

    const rows: Row[] = [];
    let weightedReturnFxInclusive = 0;
    let weightedReturnFxNetted = 0;
    let activeWeight = 0;

    const posMap = new Map<string, PositionEntry>();
    if (portfolio) for (const p of portfolio.positions) posMap.set(p.symbol, p);

    for (const h of holdingsWithWeight) {
      const pm = holdingPriceMaps.get(h.symbol);
      const normWeight = totalWeight > 0 ? h.portfolioWeight / totalWeight : 0;
      const pos = posMap.get(h.symbol);

      if (!pm) {
        rows.push({
          symbol: h.symbol,
          currency: h.currency,
          assetClass: h.assetClass,
          units: pos?.units ?? null,
          portfolioWeight: h.portfolioWeight,
          normWeight,
          prevPrice: null,
          curPrice: null,
          prevPriceSource: "missing",
          chartPrevClose: null,
          historyPrevClose: null,
          historyPrevDate: null,
          localReturnPct: null,
          cadReturnPct: null,
          contributionPct: 0,
          note: "no price history",
        });
        continue;
      }

      const curPrice = pm.get(today) ?? null;
      // Record BOTH candidate prev prices so we can verify whether
      // chartPreviousClose (from range=5d/15d) and the previous date
      // in the history map actually agree.
      const chartPrev = chartPreviousCloses.get(h.symbol) ?? null;
      const histDates = [...pm.keys()].filter((d) => d < today).sort();
      const histPrevDate = histDates.length > 0 ? histDates[histDates.length - 1] : null;
      const histPrev = histPrevDate ? pm.get(histPrevDate) ?? null : null;

      // Prefer history-based prev price (always = most recent trading day
      // before today in the returned data). chartPreviousClose is only
      // used as a fallback when history has nothing.
      let prevPrice: number | null = null;
      let prevPriceSource = "";
      if (histPrev != null) {
        prevPrice = histPrev;
        prevPriceSource = `history:${histPrevDate}`;
      } else if (chartPrev != null) {
        prevPrice = chartPrev;
        prevPriceSource = "chartPreviousClose";
      } else {
        prevPriceSource = "missing";
      }

      if (curPrice == null || prevPrice == null || prevPrice <= 0) {
        rows.push({
          symbol: h.symbol,
          currency: h.currency,
          assetClass: h.assetClass,
          units: pos?.units ?? null,
          portfolioWeight: h.portfolioWeight,
          normWeight,
          prevPrice,
          curPrice,
          prevPriceSource,
          chartPrevClose: chartPrev,
          historyPrevClose: histPrev,
          historyPrevDate: histPrevDate,
          localReturnPct: null,
          cadReturnPct: null,
          contributionPct: 0,
          note: "missing price",
        });
        continue;
      }

      const localReturn = (curPrice - prevPrice) / prevPrice;
      const cadReturn = h.currency === "USD"
        ? (1 + localReturn) * (1 + fxChange) - 1
        : localReturn;

      const contributionFxInclusive = cadReturn * normWeight;
      const contributionFxNetted = localReturn * normWeight;
      weightedReturnFxInclusive += contributionFxInclusive;
      weightedReturnFxNetted += contributionFxNetted;
      activeWeight += normWeight;

      rows.push({
        symbol: h.symbol,
        currency: h.currency,
        assetClass: h.assetClass,
        units: pos?.units ?? null,
        portfolioWeight: h.portfolioWeight,
        normWeight,
        prevPrice,
        curPrice,
        prevPriceSource,
        chartPrevClose: chartPrev,
        historyPrevClose: histPrev,
        historyPrevDate: histPrevDate,
        localReturnPct: localReturn * 100,
        cadReturnPct: cadReturn * 100,
        contributionPct: contributionFxInclusive * 100,
      });
    }

    // Match the /api/update-daily-value normalization: if activeWeight < 0.99,
    // scale up the weighted return. If < 0.3 we'd normally skip entirely.
    const needsNorm = activeWeight < 0.99;
    const weightedFxInclusiveNormalized = needsNorm && activeWeight > 0
      ? weightedReturnFxInclusive / activeWeight
      : weightedReturnFxInclusive;
    const weightedFxNettedNormalized = needsNorm && activeWeight > 0
      ? weightedReturnFxNetted / activeWeight
      : weightedReturnFxNetted;

    // Dollar-weighted (matches the live UI tile exactly): sum
    // units × prevPrice × FX on the prev side and units × currPrice × FX
    // on the curr side, then take the ratio. This is the unbiased
    // portfolio return and is what /api/update-daily-value now writes
    // for today's Appendix entry (when positions are available).
    let dwPrevTotalCad = 0;
    let dwCurrTotalCad = 0;
    let dwCoveredWeight = 0;
    const usdCadLiveSafe = usdCadLive ?? 1;
    const usdCadPrevSafe = usdCadPrev ?? usdCadLiveSafe;
    for (const h of holdingsWithWeight) {
      const pos = posMap.get(h.symbol);
      if (!pos || pos.units <= 0) continue;
      const pm = holdingPriceMaps.get(h.symbol);
      if (!pm) continue;
      const curPrice = pm.get(today);
      // Prefer the most recent trading day in the history map —
      // chartPreviousClose from range=5d/15d is the close BEFORE the
      // start of the chart (several days ago), not yesterday.
      const dwHistDates = [...pm.keys()].filter((d) => d < today).sort();
      const prev = dwHistDates.length > 0
        ? pm.get(dwHistDates[dwHistDates.length - 1])
        : chartPreviousCloses.get(h.symbol);
      if (curPrice == null || prev == null || prev <= 0) continue;
      const prevFxR = h.currency === "USD" ? usdCadPrevSafe : 1;
      const currFxR = h.currency === "USD" ? usdCadLiveSafe : 1;
      dwPrevTotalCad += pos.units * prev * prevFxR;
      dwCurrTotalCad += pos.units * curPrice * currFxR;
      dwCoveredWeight += totalWeight > 0 ? h.portfolioWeight / totalWeight : 0;
    }
    const dollarWeightedPct = dwPrevTotalCad > 0
      ? ((dwCurrTotalCad - dwPrevTotalCad) / dwPrevTotalCad) * 100
      : null;

    // Sort rows by absolute contribution so biggest movers surface
    rows.sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));

    return NextResponse.json({
      groupId,
      profile,
      today,
      marketOpen,
      weightSource: hasPositions ? "positions" : "model targets",
      fx: {
        usdCadLive,
        usdCadPreviousClose: usdCadPrev,
        fxChangePct: fxChange * 100,
      },
      totals: {
        totalWeight,
        activeWeight,
        coveragePct: activeWeight * 100,
        normalizationApplied: needsNorm,
      },
      result: {
        // What the Appendix NOW writes (unified with live UI)
        todayReturnDollarWeightedPct: dollarWeightedPct,
        dollarWeightedCoveragePct: dwCoveredWeight * 100,
        // Older return-weighted numbers kept for comparison / diagnosis
        todayReturnFxInclusiveReturnWeightedPct: weightedFxInclusiveNormalized * 100,
        todayReturnFxNettedReturnWeightedPct: weightedFxNettedNormalized * 100,
        fxContributionPct: (weightedFxInclusiveNormalized - weightedFxNettedNormalized) * 100,
      },
      rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
