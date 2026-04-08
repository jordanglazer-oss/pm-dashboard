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
const APPENDIX_KEY = "pm:appendix-daily-values";
const POSITIONS_KEY = "pm:pim-positions";

/**
 * POST /api/update-daily-value
 *
 * Appends new daily values to performance history. On each call,
 * the last 2 trading days are recalculated to ensure end-of-day
 * adjusted close prices are used (handles intraday captures and
 * mutual fund NAV delays). Older historical entries are never modified.
 *
 * Uses Yahoo adjusted close prices (dividends/splits baked in).
 * Converts USD-denominated holding returns to CAD using daily USD/CAD rate.
 * Mutual fund NAV from Barchart already reflects reinvested distributions.
 */

type DailyPriceData = { date: string; adjClose: number };
type SymbolPriceResult = { history: DailyPriceData[]; chartPreviousClose: number | null };

/** Fetch adjusted close prices from Yahoo (dividends/splits adjusted).
 *  For today's date, uses regularMarketPrice from meta (live intraday)
 *  and returns chartPreviousClose so today's return matches Positioning tab. */
async function fetchAdjustedCloses(symbol: string): Promise<SymbolPriceResult> {
  let yahooSymbol = symbol;
  if (symbol.endsWith("-T")) yahooSymbol = symbol.replace("-T", ".TO");
  else if (symbol.endsWith(".U")) yahooSymbol = symbol.replace(".U", "-U.TO");
  if (/^[A-Z]{2,4}\d{2,5}$/i.test(symbol)) return { history: [], chartPreviousClose: null };

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=15d&interval=1d`;
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
    // chartPreviousClose is what Yahoo uses for daily change — same as Positioning tab
    const chartPrevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;

    if (livePrice && !isNaN(livePrice)) {
      const today = new Date().toISOString().split("T")[0];
      const todayIdx = result.findIndex((p) => p.date === today);
      if (todayIdx >= 0) {
        result[todayIdx].adjClose = livePrice;
      } else {
        result.push({ date: today, adjClose: livePrice });
      }
    }

    return { history: result, chartPreviousClose: chartPrevClose };
  } catch {
    return { history: [], chartPreviousClose: null };
  }
}

/** Fetch FUNDSERV NAV prices from Barchart (distributions reflected in NAV) */
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
      const dateParts = parts[1]?.split("/");
      if (!dateParts || dateParts.length !== 3) continue;
      const isoDate = `${dateParts[2]}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;
      result.push({ date: isoDate, adjClose: close });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** Fetch USD/CAD exchange rate history from Yahoo.
 *  Uses live regularMarketPrice for today's rate.
 *  Returns { rates, previousClose } where previousClose is chartPreviousClose for today's FX calc. */
async function fetchUsdCadRates(): Promise<{ rates: Map<string, number>; previousClose: number | null }> {
  const rates = new Map<string, number>();
  let previousClose: number | null = null;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/USDCAD=X?range=15d&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return { rates, previousClose };
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return { rates, previousClose };
    const timestamps: number[] = r.timestamp || [];
    const closes: number[] = r.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && !isNaN(closes[i])) {
        const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
        rates.set(d, closes[i]);
      }
    }
    // Use live rate for today
    const liveRate = r.meta?.regularMarketPrice;
    if (liveRate && !isNaN(liveRate)) {
      const today = new Date().toISOString().split("T")[0];
      rates.set(today, liveRate);
    }
    // chartPreviousClose for consistent FX change calculation on today
    previousClose = r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? null;
  } catch { /* ignore */ }
  return { rates, previousClose };
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

/** Get the closest rate on or before the given date */
function getRateForDate(rates: Map<string, number>, date: string): number | null {
  const rate = rates.get(date);
  if (rate) return rate;
  // Fall back to the most recent rate before this date
  const sorted = [...rates.keys()].filter((d) => d <= date).sort();
  if (sorted.length > 0) return rates.get(sorted[sorted.length - 1]) ?? null;
  return null;
}

export async function POST() {
  try {
    const redis = await getRedis();
    const [pimRaw, perfRaw, positionsRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(PERF_KEY),
      redis.get(POSITIONS_KEY),
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

    // Parse position data for live weight computation
    type PositionEntry = { symbol: string; units: number; costBasis: number };
    type PortfolioPositions = { groupId: string; profile: string; positions: PositionEntry[]; cashBalance: number };
    const positionsData: { portfolios: PortfolioPositions[] } = positionsRaw
      ? JSON.parse(positionsRaw)
      : { portfolios: [] };

    const today = new Date().toISOString().split("T")[0];
    const updates: Array<{ groupId: string; profile: string; addedDays: number; lastDate: string }> = [];

    // Collect all symbols
    const allSymbols = new Set<string>();
    for (const group of pimData.groups) {
      for (const h of group.holdings) allSymbols.add(h.symbol);
    }

    // Fetch adjusted close histories for all symbols + USD/CAD rate
    const symbols = [...allSymbols];
    const priceHistories = new Map<string, DailyPriceData[]>();
    const chartPreviousCloses = new Map<string, number>();

    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (s) => {
          if (isFundserv(s)) {
            return { symbol: s, history: await fetchFundservCloses(s), chartPreviousClose: null as number | null };
          }
          const res = await fetchAdjustedCloses(s);
          return { symbol: s, ...res };
        })
      );
      for (const r of results) {
        if (r.history.length > 0) priceHistories.set(r.symbol, r.history);
        if (r.chartPreviousClose != null) chartPreviousCloses.set(r.symbol, r.chartPreviousClose);
      }
    }

    // Fetch USD/CAD rates
    const { rates: usdCadRates, previousClose: fxPreviousClose } = await fetchUsdCadRates();

    // Update each model — ONLY append new days, never modify historical entries
    for (const model of perfData.models) {
      if (model.history.length < 2) continue;

      const group = pimData.groups.find((g) => g.id === model.groupId);
      if (!group) continue;

      const profileWeights = group.profiles[model.profile as PimProfileType];
      if (!profileWeights) continue;

      // Recalculate the last 2 trading days to account for:
      // - Intraday prices that were captured before market close
      // - Mutual fund NAVs that only populate the next day
      // This also serves as a one-time fix for any recently locked incorrect entries
      const RECALC_DAYS = 2;
      let popped = 0;
      while (
        model.history.length > 1 &&
        popped < RECALC_DAYS &&
        model.history[model.history.length - 1].date >= today.slice(0, 8) // same month prefix safety
      ) {
        const last = model.history[model.history.length - 1];
        // Only pop recent entries (within last 5 calendar days of today)
        const daysDiff = (new Date(today).getTime() - new Date(last.date).getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff > 5) break;
        model.history.pop();
        popped++;
      }
      const lastEntry = model.history[model.history.length - 1];
      const lastDate = lastEntry.date;
      if (lastDate >= today) continue;

      // Calculate holdings with portfolio weights
      // Use LIVE weights from positions when available, fall back to model target weights
      const portfolio = positionsData.portfolios.find(
        (p) => p.groupId === model.groupId && p.profile === model.profile
      );
      const hasPositions = portfolio && portfolio.positions.length > 0;

      let holdingsWithWeight: Array<typeof group.holdings[0] & { portfolioWeight: number }>;

      if (hasPositions) {
        // Live weights: compute from actual positions using latest available prices
        // All values standardized to CAD for consistent weighting
        const latestPrices = new Map<string, number>();
        for (const h of group.holdings) {
          const hist = priceHistories.get(h.symbol);
          if (hist && hist.length > 0) {
            latestPrices.set(h.symbol, hist[hist.length - 1].adjClose);
          }
        }

        // Get latest USD/CAD rate for converting USD positions to CAD
        const sortedRateDates = [...usdCadRates.keys()].sort();
        const latestFxRate = sortedRateDates.length > 0
          ? usdCadRates.get(sortedRateDates[sortedRateDates.length - 1]) ?? 1
          : 1;

        // Build a currency lookup from group holdings
        const holdingCurrency = new Map<string, string>();
        for (const h of group.holdings) holdingCurrency.set(h.symbol, h.currency);

        // Calculate total portfolio value from positions (all in CAD)
        let totalPortfolioValue = portfolio.cashBalance || 0;
        const positionValues = new Map<string, number>();
        for (const pos of portfolio.positions) {
          const price = latestPrices.get(pos.symbol) || 0;
          let value = pos.units * price;
          // Convert USD to CAD
          if (holdingCurrency.get(pos.symbol) === "USD") {
            value *= latestFxRate;
          }
          positionValues.set(pos.symbol, value);
          totalPortfolioValue += value;
        }

        holdingsWithWeight = group.holdings
          .map((h) => {
            const value = positionValues.get(h.symbol) || 0;
            const portfolioWeight = totalPortfolioValue > 0 ? value / totalPortfolioValue : 0;
            return { ...h, portfolioWeight };
          })
          .filter((h) => h.portfolioWeight > 0);
      } else {
        // No positions — use model target weights
        holdingsWithWeight = group.holdings
          .map((h) => {
            const alloc = getAssetAlloc(profileWeights, h.assetClass);
            return { ...h, portfolioWeight: h.weightInClass * alloc };
          })
          .filter((h) => h.portfolioWeight > 0);
      }

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

      for (const date of daysNeeded) {
        let weightedReturn = 0;
        let activeWeight = 0;

        const isToday = date === today;

        // Get USD/CAD rates for FX conversion
        // For today: use chartPreviousClose as base (matches Positioning tab)
        const todayRate = getRateForDate(usdCadRates, date);
        let prevRate: number | null;
        if (isToday && fxPreviousClose != null) {
          prevRate = fxPreviousClose;
        } else {
          const prevDates = [...usdCadRates.keys()].filter((d) => d < date).sort();
          prevRate = prevDates.length > 0 ? usdCadRates.get(prevDates[prevDates.length - 1]) ?? null : null;
        }
        const fxChange = (todayRate && prevRate && prevRate > 0)
          ? (todayRate - prevRate) / prevRate
          : 0;

        for (const h of holdingsWithWeight) {
          const pm = holdingPriceMaps.get(h.symbol);
          if (!pm) continue;

          const curPrice = pm.get(date);
          if (curPrice == null) continue;

          // For today: use chartPreviousClose (matches Positioning tab's previousClose)
          // For past days: use previous trading day's adjClose from history
          let prevPrice: number | undefined;
          if (isToday && chartPreviousCloses.has(h.symbol)) {
            prevPrice = chartPreviousCloses.get(h.symbol);
          } else {
            const allDates = [...pm.keys()].filter((d) => d < date).sort();
            prevPrice = allDates.length > 0 ? pm.get(allDates[allDates.length - 1]) : undefined;
          }

          if (prevPrice && prevPrice > 0) {
            let holdingReturn = (curPrice - prevPrice) / prevPrice;

            // Convert USD returns to CAD: (1 + USD return) * (1 + FX change) - 1
            if (h.currency === "USD" && fxChange !== 0) {
              holdingReturn = (1 + holdingReturn) * (1 + fxChange) - 1;
            }

            const normWeight = h.portfolioWeight / totalWeight;
            weightedReturn += holdingReturn * normWeight;
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

      // Also append new entries to the immutable Appendix ledger
      try {
        const appendixRaw = await redis.get(APPENDIX_KEY);
        const appendixData: { ledgers: { profile: string; entries: { date: string; value: number; dailyReturn: number; addedAt: string }[] }[] } =
          appendixRaw ? JSON.parse(appendixRaw) : { ledgers: [] };
        const now = new Date().toISOString();

        for (const upd of updates) {
          const model = perfData.models.find(
            (m) => m.groupId === upd.groupId && m.profile === upd.profile
          );
          if (!model) continue;

          // Find or create appendix ledger for this profile
          let ledger = appendixData.ledgers.find((l) => l.profile === upd.profile);
          if (!ledger) {
            ledger = { profile: upd.profile, entries: [] };
            appendixData.ledgers.push(ledger);
          }

          const recentEntries = model.history.slice(-upd.addedDays);
          for (const entry of recentEntries) {
            // Replace today's entry if it exists, otherwise append
            const existingIdx = ledger.entries.findIndex((e) => e.date === entry.date);
            if (existingIdx >= 0) {
              ledger.entries[existingIdx] = {
                date: entry.date,
                value: entry.value,
                dailyReturn: entry.dailyReturn,
                addedAt: now,
              };
            } else {
              ledger.entries.push({
                date: entry.date,
                value: entry.value,
                dailyReturn: entry.dailyReturn,
                addedAt: now,
              });
            }
          }
          ledger.entries.sort((a, b) => a.date.localeCompare(b.date));
        }

        await redis.set(APPENDIX_KEY, JSON.stringify(appendixData));
      } catch (appendixErr) {
        console.error("Failed to update appendix ledger:", appendixErr);
        // Don't fail the main update
      }
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
