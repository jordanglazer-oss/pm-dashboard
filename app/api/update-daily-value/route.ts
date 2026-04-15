import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { getTodayET, isMarketOpenOrAfterET } from "@/app/lib/market-hours";
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
 *  and returns chartPreviousClose so today's return matches Positioning tab.
 *  @param range Yahoo range string; "15d" for full recalc, "5d" for today-only path. */
async function fetchAdjustedCloses(symbol: string, range: string = "15d"): Promise<SymbolPriceResult> {
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
    // chartPreviousClose is what Yahoo uses for daily change — same as Positioning tab
    const chartPrevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;

    if (livePrice && !isNaN(livePrice)) {
      const today = getTodayET();
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
      // Barchart returns dates as YYYY-MM-DD; accept both dash and slash formats
      const rawDate = parts[1]?.trim();
      if (!rawDate) continue;
      let isoDate: string;
      if (rawDate.includes("/")) {
        const dateParts = rawDate.split("/");
        if (dateParts.length !== 3) continue;
        isoDate = `${dateParts[2]}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;
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

/** Fetch USD/CAD exchange rate history from Yahoo.
 *  Uses live regularMarketPrice for today's rate.
 *  Returns { rates, previousClose } where previousClose is chartPreviousClose for today's FX calc.
 *  @param range Yahoo range string; "15d" for full recalc, "5d" for today-only path. */
async function fetchUsdCadRates(range: string = "15d"): Promise<{ rates: Map<string, number>; previousClose: number | null }> {
  const rates = new Map<string, number>();
  let previousClose: number | null = null;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/USDCAD=X?range=${range}&interval=1d`;
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
      const today = getTodayET();
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
    const [pimRaw, perfRaw, positionsRaw, stocksRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(PERF_KEY),
      redis.get(POSITIONS_KEY),
      redis.get("pm:stocks"),
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

    // Build core symbols set for alpha filtering
    type StockEntry = { ticker: string; designation?: "core" | "alpha" };
    const stocksList: StockEntry[] = stocksRaw ? JSON.parse(stocksRaw) : [];
    const coreSymbols = new Set<string>();
    for (const s of stocksList) {
      if (s.designation === "core") coreSymbols.add(s.ticker);
    }

    // Helper to convert PIM symbol to ticker for designation lookup
    function pimSymbolToTicker(symbol: string): string {
      if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
      return symbol;
    }

    const today = getTodayET();
    // Pre-market data is unreliable: Yahoo's regularMarketPrice still reports
    // yesterday's close before 9:30 AM ET, so any "today" return computed
    // before market open is actually yesterday's return mislabeled.
    const marketOpen = isMarketOpenOrAfterET();

    // Today-only mode: if yesterday has already been finalized on this
    // trading day (i.e. we did a full 2-day recalc with the market open
    // earlier today), subsequent refreshes only need to recompute today.
    // This skips the redundant rewrite of yesterday's locked entry and
    // lets us fetch a shorter Yahoo range for faster refreshes.
    // Safety: falls back to full 2-day recalc whenever the marker is
    // stale or missing, so mutual fund NAVs that post late (next AM)
    // still get captured by the first refresh of the next session.
    const todayOnlyMode = marketOpen && perfData.yesterdayFinalizedOn === today;
    const yahooRange = todayOnlyMode ? "5d" : "15d";
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
          const res = await fetchAdjustedCloses(s, yahooRange);
          return { symbol: s, ...res };
        })
      );
      for (const r of results) {
        if (r.history.length > 0) priceHistories.set(r.symbol, r.history);
        if (r.chartPreviousClose != null) chartPreviousCloses.set(r.symbol, r.chartPreviousClose);
      }
    }

    // Fetch USD/CAD rates
    const { rates: usdCadRates, previousClose: fxPreviousClose } = await fetchUsdCadRates(yahooRange);

    // Ensure alpha model exists for PIM group — seed from Appendix if missing
    const pimGroup = pimData.groups.find((g) => g.id === "pim");
    const hasAlphaModel = perfData.models.some(
      (m) => m.groupId === "pim" && m.profile === "alpha"
    );
    if (pimGroup && !hasAlphaModel) {
      // Try to seed from Appendix
      const appendixRaw = await redis.get(APPENDIX_KEY);
      if (appendixRaw) {
        const appendixData = JSON.parse(appendixRaw);
        const alphaLedger = appendixData.ledgers?.find(
          (l: { profile: string }) => l.profile === "alpha"
        );
        if (alphaLedger && alphaLedger.entries?.length > 0) {
          perfData.models.push({
            groupId: "pim",
            profile: "alpha",
            history: alphaLedger.entries.map((e: { date: string; value: number; dailyReturn: number }) => ({
              date: e.date,
              value: e.value,
              dailyReturn: e.dailyReturn,
            })),
            lastUpdated: new Date().toISOString(),
          });
        }
      }
    }

    // Update each model — ONLY append new days, never modify historical entries
    for (const model of perfData.models) {
      if (model.history.length < 2) continue;

      const group = pimData.groups.find((g) => g.id === model.groupId);
      if (!group) continue;

      const isAlpha = model.profile === "alpha";
      // Alpha only applies to PIM group
      if (isAlpha && model.groupId !== "pim") continue;
      const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
      const profileWeights = isAlpha ? ALPHA_WEIGHTS : group.profiles[model.profile as PimProfileType];
      if (!profileWeights) continue;

      // For alpha: equity-only, exclude core ETFs, re-normalize proportionally
      const effectiveHoldings = isAlpha
        ? (() => {
            const alphaH = group.holdings.filter(
              (h) => h.assetClass === "equity" && !coreSymbols.has(pimSymbolToTicker(h.symbol))
            );
            const total = alphaH.reduce((s, h) => s + h.weightInClass, 0);
            return total > 0 ? alphaH.map((h) => ({ ...h, weightInClass: h.weightInClass / total })) : alphaH;
          })()
        : group.holdings;

      // Recalculate the last 2 trading days to account for:
      // - Intraday prices that were captured before market close
      // - Mutual fund NAVs that only populate the next day
      // This also serves as a one-time fix for any recently locked incorrect entries.
      // On same-day refreshes after yesterday has been finalized this session,
      // drop to 1 (today only) — yesterday's entry is already stable.
      const RECALC_DAYS = todayOnlyMode ? 1 : 2;
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

      let holdingsWithWeight: Array<typeof effectiveHoldings[0] & { portfolioWeight: number }>;

      if (hasPositions) {
        // Live weights: compute from actual positions using latest available prices
        // All values standardized to CAD for consistent weighting
        const latestPrices = new Map<string, number>();
        for (const h of effectiveHoldings) {
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

        // Build a currency lookup from effective holdings
        const holdingCurrency = new Map<string, string>();
        for (const h of effectiveHoldings) holdingCurrency.set(h.symbol, h.currency);

        // Calculate total portfolio value from positions (all in CAD)
        // For alpha: only include positions that are in the effective holdings
        const effectiveSymbols = new Set(effectiveHoldings.map((h) => h.symbol));
        let totalPortfolioValue = portfolio.cashBalance || 0;
        const positionValues = new Map<string, number>();
        for (const pos of portfolio.positions) {
          if (!effectiveSymbols.has(pos.symbol)) continue;
          const price = latestPrices.get(pos.symbol) || 0;
          let value = pos.units * price;
          // Convert USD to CAD
          if (holdingCurrency.get(pos.symbol) === "USD") {
            value *= latestFxRate;
          }
          positionValues.set(pos.symbol, value);
          totalPortfolioValue += value;
        }

        holdingsWithWeight = effectiveHoldings
          .map((h) => {
            const value = positionValues.get(h.symbol) || 0;
            const portfolioWeight = totalPortfolioValue > 0 ? value / totalPortfolioValue : 0;
            return { ...h, portfolioWeight };
          })
          .filter((h) => h.portfolioWeight > 0);
      } else {
        // No positions — use model target weights
        holdingsWithWeight = effectiveHoldings
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

      // Build a positions map for O(1) lookup in the today dollar-weighted path
      const posMap = new Map<string, { symbol: string; units: number; costBasis: number }>();
      if (portfolio) {
        for (const p of portfolio.positions) posMap.set(p.symbol, p);
      }

      for (const date of daysNeeded) {
        let weightedReturn = 0;
        let activeWeight = 0;

        const isToday = date === today;
        // Skip today entirely until market has actually opened — pre-market
        // pricing would record yesterday's return as today's.
        if (isToday && !marketOpen) continue;

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

        // ── TODAY: dollar-weighted path (matches the live UI exactly) ──
        // When we have position data, compute today's return as
        // (currTotalCad - prevTotalCad) / prevTotalCad — identical to the
        // useLiveTodayReturn hook and PimPortfolio.todayReturn. This is
        // the unbiased portfolio return and the number the user sees in
        // the Performance Tracker / Positioning tiles.
        //
        // The older return-weighted path (below) over-weights winners
        // when coverage is below 100% (e.g. mutual fund NAVs lag by a
        // day), inflating the stored Appendix number vs the live tile.
        // Dollar-weighted naturally handles missing prices by excluding
        // both sides cleanly — and the 2-day recalc that runs the next
        // trading morning will re-compute this entry once the mutual
        // fund NAVs arrive, so no data is permanently biased.
        if (isToday && hasPositions && portfolio) {
          const todayFx = todayRate ?? 1;
          const prevFx = prevRate ?? todayFx;
          let prevTotalCad = 0;
          let currTotalCad = 0;
          let coveredWeight = 0; // share of portfolioWeight actually priced

          for (const h of holdingsWithWeight) {
            const pos = posMap.get(h.symbol);
            if (!pos || pos.units <= 0) continue;
            const pm = holdingPriceMaps.get(h.symbol);
            if (!pm) continue;
            const curPrice = pm.get(date);
            if (curPrice == null) continue;

            // Prev price: use the most recent trading day in the fetched
            // price history (yesterday's close), NOT chartPreviousClose.
            // chartPreviousClose from range=5d/15d returns the close from
            // BEFORE the chart's start (~5-15 days ago), which would turn
            // "today's daily return" into a multi-day return. The live UI
            // calls /api/prices with range=1d where chartPreviousClose
            // coincidentally equals yesterday's close, which is why the
            // UI has been correct while the Appendix has been inflated.
            const histDates = [...pm.keys()].filter((d) => d < date).sort();
            const prev = histDates.length > 0
              ? pm.get(histDates[histDates.length - 1])
              : chartPreviousCloses.get(h.symbol);
            if (prev == null || prev <= 0) continue;

            const prevFxRate = h.currency === "USD" ? prevFx : 1;
            const currFxRate = h.currency === "USD" ? todayFx : 1;
            prevTotalCad += pos.units * prev * prevFxRate;
            currTotalCad += pos.units * curPrice * currFxRate;
            coveredWeight += h.portfolioWeight / totalWeight;
          }

          // Same 30% coverage floor as the return-weighted path — don't
          // record an entry computed from a tiny slice of the portfolio.
          if (prevTotalCad > 0 && coveredWeight >= 0.3) {
            const dailyReturnDecimal = (currTotalCad - prevTotalCad) / prevTotalCad;
            const dailyReturnPct = dailyReturnDecimal * 100;
            currentValue = currentValue * (1 + dailyReturnDecimal);
            model.history.push({
              date,
              value: parseFloat(currentValue.toFixed(4)),
              dailyReturn: parseFloat(dailyReturnPct.toFixed(4)),
            });
            addedDays++;
          }
          continue;
        }

        // ── PAST DAYS (or today without positions): return-weighted ──
        // Used for the yesterday recalc and the rare "no positions" case.
        // On past days, mutual fund NAVs should be available so coverage
        // is near 100% and the normalization correction doesn't distort.
        for (const h of holdingsWithWeight) {
          const pm = holdingPriceMaps.get(h.symbol);
          if (!pm) continue;

          const curPrice = pm.get(date);
          if (curPrice == null) continue;

          // Previous price = most recent trading day before `date` in the
          // fetched price history. Do NOT use chartPreviousClose here —
          // with range=5d/15d it returns the close from before the chart's
          // start (several days ago), not yesterday, which would inflate
          // today's stored daily return into a multi-day return.
          let prevPrice: number | undefined;
          const allDates = [...pm.keys()].filter((d) => d < date).sort();
          if (allDates.length > 0) {
            prevPrice = pm.get(allDates[allDates.length - 1]);
          } else if (isToday) {
            prevPrice = chartPreviousCloses.get(h.symbol);
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

    // Mark yesterday as finalized once we've run a full 2-day recalc with
    // the market open AND the recalc produced real updates. After this
    // point, same-day refreshes take the lighter today-only path.
    // Guarding on updates.length > 0 prevents a failed Yahoo fetch (which
    // pops entries without re-adding) from prematurely locking yesterday
    // in — next refresh stays on the full 2-day path and self-heals.
    if (marketOpen && !todayOnlyMode && updates.length > 0) {
      perfData.yesterdayFinalizedOn = today;
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
