import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimModelGroup, PimProfileType, PimProfileWeights, PimDailyReturn, PimModelPerformance, PimPerformanceData } from "@/app/lib/pim-types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PIM_KEY = "pm:pim-models";
const PERF_KEY = "pm:pim-performance";

// Fetch historical closing prices from Yahoo Finance
async function fetchHistory(symbol: string, range = "1y"): Promise<{ date: string; close: number }[]> {
  // Translate ticker formats for Yahoo
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) {
    yahooSymbol = symbol.replace("-T", ".TO");
  } else if (symbol.endsWith(".U")) {
    yahooSymbol = symbol.replace(".U", "-U.TO");
  }
  // FUNDSERV codes (mutual funds) — Yahoo doesn't have these
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return [];

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];

    const history: { date: string; close: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || isNaN(close)) continue;
      const d = new Date(timestamps[i] * 1000);
      const dateStr = d.toISOString().split("T")[0];
      history.push({ date: dateStr, close });
    }
    return history;
  } catch {
    return [];
  }
}

// Fetch current intraday price
async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return null;

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    return meta?.regularMarketPrice ?? meta?.previousClose ?? null;
  } catch {
    return null;
  }
}

function getAssetAlloc(pw: PimProfileWeights, assetClass: string): number {
  if (assetClass === "fixedIncome") return pw.fixedIncome;
  if (assetClass === "equity") return pw.equity;
  if (assetClass === "alternative") return pw.alternatives;
  return 0;
}

// Compute weighted portfolio return for a model+profile
function computeModelReturns(
  group: PimModelGroup,
  profile: PimProfileType,
  priceHistories: Map<string, { date: string; close: number }[]>,
  currentPrices: Map<string, number>
): { history: PimDailyReturn[]; intradayReturn: number | null } {
  const pw = group.profiles[profile];
  if (!pw) return { history: [], intradayReturn: null };

  // Calculate portfolio weights for each holding
  const holdingsWithWeight = group.holdings.map((h) => {
    const alloc = getAssetAlloc(pw, h.assetClass);
    return { ...h, portfolioWeight: h.weightInClass * alloc };
  }).filter((h) => h.portfolioWeight > 0);

  if (holdingsWithWeight.length === 0) return { history: [], intradayReturn: null };

  // Normalize weights to sum to total invested (exclude cash)
  const totalWeight = holdingsWithWeight.reduce((s, h) => s + h.portfolioWeight, 0);

  // Get all dates across all holdings
  const allDates = new Set<string>();
  for (const h of holdingsWithWeight) {
    const hist = priceHistories.get(h.symbol);
    if (hist) hist.forEach((p) => allDates.add(p.date));
  }
  const sortedDates = [...allDates].sort();
  if (sortedDates.length < 2) return { history: [], intradayReturn: null };

  // Build price maps per holding
  const priceMaps = new Map<string, Map<string, number>>();
  for (const h of holdingsWithWeight) {
    const hist = priceHistories.get(h.symbol);
    if (!hist || hist.length === 0) continue;
    const pm = new Map<string, number>();
    hist.forEach((p) => pm.set(p.date, p.close));
    priceMaps.set(h.symbol, pm);
  }

  // Compute daily weighted returns
  const history: PimDailyReturn[] = [];
  let cumulativeValue = 100;

  for (let i = 1; i < sortedDates.length; i++) {
    const prevDate = sortedDates[i - 1];
    const curDate = sortedDates[i];

    let weightedReturn = 0;
    let activeWeight = 0;

    for (const h of holdingsWithWeight) {
      const pm = priceMaps.get(h.symbol);
      if (!pm) continue;
      const prevPrice = pm.get(prevDate);
      const curPrice = pm.get(curDate);
      if (prevPrice && curPrice && prevPrice > 0) {
        const ret = (curPrice - prevPrice) / prevPrice;
        const normWeight = h.portfolioWeight / totalWeight;
        weightedReturn += ret * normWeight;
        activeWeight += normWeight;
      }
    }

    // Scale return if not all holdings had data for this day
    if (activeWeight > 0 && activeWeight < 0.99) {
      weightedReturn = weightedReturn / activeWeight;
    }

    const dailyReturn = weightedReturn * 100;
    cumulativeValue = cumulativeValue * (1 + weightedReturn);

    history.push({
      date: curDate,
      value: parseFloat(cumulativeValue.toFixed(4)),
      dailyReturn: parseFloat(dailyReturn.toFixed(4)),
    });
  }

  // Compute intraday return (current price vs last close)
  const lastDate = sortedDates[sortedDates.length - 1];
  let intradayReturn: number | null = null;
  let intradayWeighted = 0;
  let intradayActive = 0;

  for (const h of holdingsWithWeight) {
    const pm = priceMaps.get(h.symbol);
    const curPrice = currentPrices.get(h.symbol);
    if (!pm || curPrice == null) continue;
    const lastClose = pm.get(lastDate);
    if (lastClose && lastClose > 0) {
      const ret = (curPrice - lastClose) / lastClose;
      const normWeight = h.portfolioWeight / totalWeight;
      intradayWeighted += ret * normWeight;
      intradayActive += normWeight;
    }
  }

  if (intradayActive > 0.3) {
    intradayReturn = parseFloat(((intradayWeighted / intradayActive) * 100).toFixed(4));
  }

  return { history, intradayReturn };
}

export async function POST() {
  try {
    const redis = await getRedis();
    const pimRaw = await redis.get(PIM_KEY);
    if (!pimRaw) {
      return NextResponse.json({ error: "No PIM model data" }, { status: 400 });
    }

    const pimData = JSON.parse(pimRaw) as { groups: PimModelGroup[] };
    // Focus on PIM group models (first 4: pim, pc-usa, non-res, no-us-situs)
    // but compute for all groups
    const groups = pimData.groups;

    // Collect all unique symbols
    const allSymbols = new Set<string>();
    for (const g of groups) {
      for (const h of g.holdings) {
        allSymbols.add(h.symbol);
      }
    }

    // Fetch histories in parallel (batches of 10)
    const symbols = [...allSymbols];
    const priceHistories = new Map<string, { date: string; close: number }[]>();
    const currentPrices = new Map<string, number>();

    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const [histories, prices] = await Promise.all([
        Promise.all(batch.map(async (s) => ({ symbol: s, data: await fetchHistory(s) }))),
        Promise.all(batch.map(async (s) => ({ symbol: s, price: await fetchCurrentPrice(s) }))),
      ]);
      for (const h of histories) priceHistories.set(h.symbol, h.data);
      for (const p of prices) {
        if (p.price != null) currentPrices.set(p.symbol, p.price);
      }
    }

    // Compute returns for each group × profile
    const profiles: PimProfileType[] = ["balanced", "growth", "allEquity"];
    const models: PimModelPerformance[] = [];

    for (const group of groups) {
      for (const profile of profiles) {
        if (!group.profiles[profile]) continue;
        const { history, intradayReturn } = computeModelReturns(group, profile, priceHistories, currentPrices);
        if (history.length > 0) {
          // Add intraday as a projected point if available
          if (intradayReturn != null && history.length > 0) {
            const last = history[history.length - 1];
            const today = new Date().toISOString().split("T")[0];
            if (last.date !== today) {
              history.push({
                date: today,
                value: parseFloat((last.value * (1 + intradayReturn / 100)).toFixed(4)),
                dailyReturn: intradayReturn,
              });
            } else {
              // Update today's entry with live data
              history[history.length - 1] = {
                date: today,
                value: parseFloat((history.length > 1
                  ? history[history.length - 2].value * (1 + intradayReturn / 100)
                  : 100 * (1 + intradayReturn / 100)
                ).toFixed(4)),
                dailyReturn: intradayReturn,
              };
            }
          }

          models.push({
            groupId: group.id,
            profile,
            history,
            lastUpdated: new Date().toISOString(),
          });
        }
      }
    }

    const perfData: PimPerformanceData = {
      models,
      lastUpdated: new Date().toISOString(),
    };

    // Persist to Redis
    await redis.set(PERF_KEY, JSON.stringify(perfData));

    return NextResponse.json(perfData);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("PIM performance error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
