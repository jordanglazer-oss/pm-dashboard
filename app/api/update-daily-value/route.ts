import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimPerformanceData,
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
 * Automatically appends new daily values to performance history.
 * Uses adjusted close prices from Yahoo Finance which account for
 * dividends, distributions, and splits automatically.
 * Mutual fund prices from Barchart are NAV-based and inherently
 * include reinvested distributions.
 *
 * If mutual fund EOD data isn't available yet (published after market
 * close, sometimes next morning), the update will still run with
 * available holdings and retroactively correct when fund prices arrive.
 */

type DailyPriceData = {
  date: string;
  adjClose: number;
};

/** Fetch adjusted close prices for the last 15 trading days from Yahoo */
async function fetchAdjustedCloses(symbol: string): Promise<DailyPriceData[]> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  // FUNDSERV mutual funds — Yahoo doesn't have these
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return [];

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=15d&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return [];

    const timestamps: number[] = r.timestamp || [];
    // adjclose accounts for dividends, distributions, and splits
    const adjCloses: number[] = r.indicators?.adjclose?.[0]?.adjclose || [];
    // Fallback to regular close if adjclose unavailable
    const closes: number[] = r.indicators?.quote?.[0]?.close || [];

    const result: DailyPriceData[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = adjCloses[i] ?? closes[i];
      if (price == null || isNaN(price)) continue;
      const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      result.push({ date: d, adjClose: price });
    }
    return result;
  } catch {
    return [];
  }
}

/** Fetch FUNDSERV (mutual fund) NAV prices for recent days from Barchart */
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
      // CSV: SYMBOL,DATE,OPEN,HIGH,LOW,CLOSE,VOLUME
      const parts = line.split(",");
      if (parts.length < 6) continue;
      const close = parseFloat(parts[5]);
      if (!isFinite(close)) continue;
      // Date format from Barchart: MM/DD/YYYY
      const dateParts = parts[1]?.split("/");
      if (!dateParts || dateParts.length !== 3) continue;
      const isoDate = `${dateParts[2]}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;
      result.push({ date: isoDate, adjClose: close });
    }
    // Mutual fund NAV already reflects distributions (reinvested at NAV)
    return result.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
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

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

function getTradingDaysNeeded(lastDate: string, today: string): string[] {
  const dates: string[] = [];
  const d = new Date(lastDate + "T12:00:00");
  const end = new Date(today + "T12:00:00");
  d.setDate(d.getDate() + 1);
  while (d <= end) {
    const ds = d.toISOString().split("T")[0];
    if (!isWeekend(ds)) dates.push(ds);
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
      return NextResponse.json({ error: "No performance data to update." }, { status: 400 });
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
    const updates: Array<{ groupId: string; profile: string; addedDays: number; lastDate: string; retroCorrected: number }> = [];

    // Collect all symbols
    const allSymbols = new Set<string>();
    for (const group of pimData.groups) {
      for (const h of group.holdings) allSymbols.add(h.symbol);
    }

    // Fetch adjusted close histories for all symbols
    // Yahoo's adjclose automatically reflects dividends & splits
    // Barchart mutual fund NAV inherently includes reinvested distributions
    const symbols = [...allSymbols];
    const priceHistories = new Map<string, DailyPriceData[]>();

    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (s) => ({
          symbol: s,
          data: isFundserv(s) ? await fetchFundservCloses(s) : await fetchAdjustedCloses(s),
        }))
      );
      for (const r of results) {
        if (r.data.length > 0) priceHistories.set(r.symbol, r.data);
      }
    }

    // Update each model
    for (const model of perfData.models) {
      if (model.history.length < 2) continue;

      const group = pimData.groups.find((g) => g.id === model.groupId);
      if (!group) continue;

      const profileWeights = group.profiles[model.profile as PimProfileType];
      if (!profileWeights) continue;

      const lastEntry = model.history[model.history.length - 1];
      const lastDate = lastEntry.date;
      if (lastDate >= today) continue;

      // Calculate holdings with portfolio weights
      const holdingsWithWeight = group.holdings
        .map((h) => {
          const alloc = getAssetAlloc(profileWeights, h.assetClass);
          return { ...h, portfolioWeight: h.weightInClass * alloc };
        })
        .filter((h) => h.portfolioWeight > 0);

      const totalWeight = holdingsWithWeight.reduce((s, h) => s + h.portfolioWeight, 0);
      if (totalWeight === 0) continue;

      // Build per-holding price maps
      const holdingPriceMaps = new Map<string, Map<string, number>>();
      for (const h of holdingsWithWeight) {
        const hist = priceHistories.get(h.symbol);
        if (!hist) continue;
        const pm = new Map<string, number>();
        for (const p of hist) pm.set(p.date, p.adjClose);
        holdingPriceMaps.set(h.symbol, pm);
      }

      const daysNeeded = getTradingDaysNeeded(lastDate, today);
      if (daysNeeded.length === 0) continue;

      let currentValue = lastEntry.value;
      let addedDays = 0;
      let retroCorrected = 0;

      // Check if we should retroactively correct recent entries
      // (mutual fund NAV may have been unavailable when previously computed)
      const retroWindowDays = 3;
      const recentEntries = model.history.slice(-retroWindowDays);
      for (const entry of recentEntries) {
        // Recompute this day's return with now-available data
        const entryIdx = model.history.findIndex((h) => h.date === entry.date);
        if (entryIdx <= 0) continue;

        const prevEntry = model.history[entryIdx - 1];
        let weightedReturn = 0;
        let activeWeight = 0;
        let prevActiveWeight = 0;

        for (const h of holdingsWithWeight) {
          const pm = holdingPriceMaps.get(h.symbol);
          if (!pm) continue;

          const curPrice = pm.get(entry.date);
          // Find previous trading day price
          const allDates = [...pm.keys()].filter((d) => d < entry.date).sort();
          const prevPrice = allDates.length > 0 ? pm.get(allDates[allDates.length - 1]) : undefined;

          const normWeight = h.portfolioWeight / totalWeight;

          if (curPrice != null && prevPrice != null && prevPrice > 0) {
            weightedReturn += ((curPrice - prevPrice) / prevPrice) * normWeight;
            activeWeight += normWeight;
          }

          // Track what we had before (any price data for previous day)
          if (prevPrice != null) prevActiveWeight += normWeight;
        }

        // Only retroactively correct if we now have MORE coverage than before
        // (e.g., mutual fund prices that weren't available before)
        if (activeWeight > 0.3 && activeWeight > prevActiveWeight * 0.01 + (entry.dailyReturn === 0 ? 0 : activeWeight - 0.001)) {
          if (activeWeight < 0.99) weightedReturn = weightedReturn / activeWeight;

          const newDailyReturn = parseFloat((weightedReturn * 100).toFixed(4));
          // Only correct if materially different (>0.01% difference)
          if (Math.abs(newDailyReturn - entry.dailyReturn) > 0.01) {
            const prevValue = model.history[entryIdx - 1].value;
            entry.dailyReturn = newDailyReturn;
            entry.value = parseFloat((prevValue * (1 + weightedReturn)).toFixed(4));

            // Cascade correction to subsequent entries
            for (let j = entryIdx + 1; j < model.history.length; j++) {
              const prev = model.history[j - 1];
              model.history[j].value = parseFloat((prev.value * (1 + model.history[j].dailyReturn / 100)).toFixed(4));
            }
            retroCorrected++;
          }
        }
      }

      // Now compute new days
      currentValue = model.history[model.history.length - 1].value;

      for (const date of daysNeeded) {
        let weightedReturn = 0;
        let activeWeight = 0;

        for (const h of holdingsWithWeight) {
          const pm = holdingPriceMaps.get(h.symbol);
          if (!pm) continue;

          const curPrice = pm.get(date);
          if (curPrice == null) continue;

          // Find previous trading day's adjusted close
          const allDates = [...pm.keys()].filter((d) => d < date).sort();
          const prevPrice = allDates.length > 0 ? pm.get(allDates[allDates.length - 1]) : undefined;

          if (prevPrice && prevPrice > 0) {
            const ret = (curPrice - prevPrice) / prevPrice;
            const normWeight = h.portfolioWeight / totalWeight;
            weightedReturn += ret * normWeight;
            activeWeight += normWeight;
          }
        }

        // Only add if we have meaningful coverage
        if (activeWeight < 0.3) continue;

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

      if (addedDays > 0 || retroCorrected > 0) {
        model.lastUpdated = new Date().toISOString();
        updates.push({
          groupId: model.groupId,
          profile: model.profile,
          addedDays,
          lastDate: model.history[model.history.length - 1].date,
          retroCorrected,
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
