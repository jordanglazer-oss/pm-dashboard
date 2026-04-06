import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimPerformanceData,
  PimModelPerformance,
  PimDailyReturn,
  PimProfileType,
  PimModelGroup,
  PimProfileWeights,
} from "@/app/lib/pim-types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PIM_KEY = "pm:pim-models";
const PERF_KEY = "pm:pim-performance";

/**
 * POST /api/update-daily-value
 *
 * Automatically appends new daily values to imported performance history.
 * For each model+profile that has imported history, it:
 *   1. Checks the last recorded date
 *   2. Fetches current prices for all holdings
 *   3. Computes the weighted daily return based on model weights
 *   4. Calculates new_value = last_value * (1 + weighted_return)
 *   5. Appends and saves to Redis
 *
 * This extends the imported Daily Value history with live-computed values.
 */

async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  // FUNDSERV codes — use Barchart
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) {
    return fetchFundservPrice(symbol);
  }

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    return meta?.regularMarketPrice ?? meta?.previousClose ?? null;
  } catch {
    return null;
  }
}

async function fetchFundservPrice(ticker: string): Promise<number | null> {
  const symbol = `${ticker}.CF`;
  const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(symbol)}&data=daily&maxrecords=1&volume=contract&order=desc&dividends=false&backadjust=false`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        Referer: "https://www.theglobeandmail.com/",
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length >= 6) {
        const close = parseFloat(parts[5]);
        if (isFinite(close)) return parseFloat(close.toFixed(4));
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch previous close prices for last N days from Yahoo */
async function fetchRecentCloses(symbol: string): Promise<Map<string, number>> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return new Map();

  const result = new Map<string, number>();
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=10d&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return result;
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return result;
    const timestamps: number[] = r.timestamp || [];
    const closes: number[] = r.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && !isNaN(closes[i])) {
        const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
        result.set(d, closes[i]);
      }
    }
  } catch { /* ignore */ }
  return result;
}

function getAssetAlloc(pw: PimProfileWeights, assetClass: string): number {
  if (assetClass === "fixedIncome") return pw.fixedIncome;
  if (assetClass === "equity") return pw.equity;
  if (assetClass === "alternative") return pw.alternatives;
  return 0;
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

function getTradingDaysNeeded(lastDate: string, today: string): string[] {
  const dates: string[] = [];
  const d = new Date(lastDate + "T12:00:00");
  const end = new Date(today + "T12:00:00");

  d.setDate(d.getDate() + 1); // start from the day after lastDate
  while (d <= end) {
    const ds = d.toISOString().split("T")[0];
    if (!isWeekend(ds)) {
      dates.push(ds);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

export async function POST() {
  try {
    const redis = await getRedis();
    const [pimRaw, perfRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(PERF_KEY),
    ]);

    if (!perfRaw) {
      return NextResponse.json({ error: "No performance data to update. Import historical data first." }, { status: 400 });
    }

    const perfData: PimPerformanceData = JSON.parse(perfRaw);
    if (perfData.models.length === 0) {
      return NextResponse.json({ error: "No models in performance data" }, { status: 400 });
    }

    const pimData = pimRaw ? JSON.parse(pimRaw) as { groups: PimModelGroup[] } : null;
    if (!pimData) {
      return NextResponse.json({ error: "No PIM model data" }, { status: 400 });
    }

    const today = new Date().toISOString().split("T")[0];
    const updates: Array<{ groupId: string; profile: string; addedDays: number; lastDate: string }> = [];

    // Collect all symbols we need prices for
    const allSymbols = new Set<string>();
    for (const group of pimData.groups) {
      for (const h of group.holdings) allSymbols.add(h.symbol);
    }

    // Fetch current prices and recent closes for all symbols
    const symbols = [...allSymbols];
    const currentPrices = new Map<string, number>();
    const recentCloses = new Map<string, Map<string, number>>();

    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const [prices, closes] = await Promise.all([
        Promise.all(batch.map(async (s) => ({ symbol: s, price: await fetchCurrentPrice(s) }))),
        Promise.all(batch.map(async (s) => ({ symbol: s, closes: await fetchRecentCloses(s) }))),
      ]);
      for (const p of prices) {
        if (p.price != null) currentPrices.set(p.symbol, p.price);
      }
      for (const c of closes) {
        recentCloses.set(c.symbol, c.closes);
      }
    }

    // Update each model that has imported history
    for (const model of perfData.models) {
      if (model.history.length < 2) continue;

      const group = pimData.groups.find((g) => g.id === model.groupId);
      if (!group) continue;

      const profileWeights = group.profiles[model.profile as PimProfileType];
      if (!profileWeights) continue;

      const lastEntry = model.history[model.history.length - 1];
      const lastDate = lastEntry.date;

      // Check if we need to add new days
      if (lastDate >= today) continue;

      const daysNeeded = getTradingDaysNeeded(lastDate, today);
      if (daysNeeded.length === 0) continue;

      // Calculate holdings with portfolio weights
      const holdingsWithWeight = group.holdings
        .map((h) => {
          const alloc = getAssetAlloc(profileWeights, h.assetClass);
          return { ...h, portfolioWeight: h.weightInClass * alloc };
        })
        .filter((h) => h.portfolioWeight > 0);

      const totalWeight = holdingsWithWeight.reduce((s, h) => s + h.portfolioWeight, 0);
      if (totalWeight === 0) continue;

      let currentValue = lastEntry.value;
      let addedDays = 0;

      for (const date of daysNeeded) {
        // For each trading day, compute weighted return from available price data
        let weightedReturn = 0;
        let activeWeight = 0;

        for (const h of holdingsWithWeight) {
          const closes = recentCloses.get(h.symbol);
          const curPrice = date === today ? currentPrices.get(h.symbol) : closes?.get(date);

          if (curPrice == null) continue;

          // Find the previous day's close
          let prevClose: number | undefined;
          if (closes) {
            // Get all dates before the current date
            const prevDates = [...closes.keys()].filter((d) => d < date).sort();
            if (prevDates.length > 0) {
              prevClose = closes.get(prevDates[prevDates.length - 1]);
            }
          }

          if (prevClose && prevClose > 0) {
            const ret = (curPrice - prevClose) / prevClose;
            const normWeight = h.portfolioWeight / totalWeight;
            weightedReturn += ret * normWeight;
            activeWeight += normWeight;
          }
        }

        // Only add an entry if we have meaningful price data
        if (activeWeight < 0.3) continue;

        // Scale if partial coverage
        if (activeWeight < 0.99) {
          weightedReturn = weightedReturn / activeWeight;
        }

        const dailyReturn = weightedReturn * 100;
        currentValue = currentValue * (1 + weightedReturn);

        model.history.push({
          date,
          value: parseFloat(currentValue.toFixed(4)),
          dailyReturn: parseFloat(dailyReturn.toFixed(4)),
        });

        addedDays++;
      }

      if (addedDays > 0) {
        model.lastUpdated = new Date().toISOString();
        updates.push({
          groupId: model.groupId,
          profile: model.profile,
          addedDays,
          lastDate: model.history[model.history.length - 1].date,
        });
      }
    }

    if (updates.length > 0) {
      perfData.lastUpdated = new Date().toISOString();
      await redis.set(PERF_KEY, JSON.stringify(perfData));
    }

    return NextResponse.json({
      ok: true,
      updates,
      message: updates.length > 0
        ? `Updated ${updates.length} model(s) with new daily values`
        : "All models are up to date",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Update daily value error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
