import type { HealthData } from "./types";

// ── OHLCV bar type ──

export type OHLCVBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// ── Technical indicators result ──

export type TechnicalIndicators = {
  // Moving averages
  sma50: number;
  sma200: number;
  dmaSignal: "golden_cross" | "death_cross" | "above_both" | "below_both" | "between";
  dmaCrossoverDaysAgo?: number;

  // RSI
  rsi14: number;
  rsiSignal: "overbought" | "oversold" | "neutral";

  // MACD
  macdLine: number;
  signalLine: number;
  macdHistogram: number;
  macdSignal: "bullish_crossover" | "bearish_crossover" | "bullish" | "bearish";
  macdCrossoverDaysAgo?: number;

  // Volume
  volumeAvg50: number;
  volumeLatest: number;
  volumeRatio: number;
  volumeSignal: "high_volume" | "normal" | "low_volume";

  // 52-week range
  week52High: number;
  week52Low: number;
  week52Position: number;

  // Price
  currentPrice: number;
  priceChange5d: number;
  priceChange20d: number;

  // Ichimoku Cloud
  ichimoku: {
    tenkanSen: number;       // Conversion Line (9-period)
    kijunSen: number;        // Base Line (26-period)
    senkouSpanA: number;     // Leading Span A (current cloud top/bottom)
    senkouSpanB: number;     // Leading Span B (current cloud top/bottom)
    cloudTop: number;        // max(spanA, spanB)
    cloudBottom: number;     // min(spanA, spanB)
    chikouSpan: number;      // Lagging Span (current close vs price 26 periods ago)
    chikouVsPrice: number;   // % difference: chikou above/below price 26 periods ago

    // Derived signals
    priceVsCloud: "above" | "inside" | "below";
    tkCross: "bullish" | "bearish" | "neutral";        // Tenkan vs Kijun
    tkCrossRecent: boolean;                              // TK cross within last 5 days
    cloudTrend: "bullish" | "bearish" | "twisting";     // Span A vs Span B ahead
    chikouSignal: "bullish" | "bearish" | "neutral";    // Chikou vs price
    cloudThickness: number;                              // % of price, thicker = stronger S/R
    overallSignal: "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish";
    signalSummary: string;   // Human-readable summary
  };

  // ── Higher-timeframe & Newton-toolkit extensions (all optional for
  // backward compatibility with blobs cached before these were added) ──

  /** Weekly MACD on weekly closes (resampled from daily). */
  weeklyMacd?: {
    macdLine: number;
    signalLine: number;
    histogram: number;
    signal: "bullish" | "bearish";
  };
  /** Monthly MACD on monthly closes (resampled from daily). */
  monthlyMacd?: {
    macdLine: number;
    signalLine: number;
    histogram: number;
    signal: "bullish" | "bearish";
  };
  /** RSI(14) computed on weekly closes. */
  weeklyRsi?: number;
  /** RSI(14) computed on monthly closes. */
  monthlyRsi?: number;
  /**
   * Distance from all-time high in the available bar history.
   * `pct` is a negative or zero number (0 = at ATH, -12.3 = 12.3% below).
   */
  distanceFromATH?: { pct: number; daysAgo: number; athPrice: number };
  /**
   * Distance from the nearest Ichimoku cloud edge, in % of current price.
   * Positive = price is above cloud top by that %. Negative = below cloud bottom.
   * Zero = inside the cloud.
   */
  distanceFromCloudEdge?: { pct: number; position: "above" | "below" | "inside" };
  /** MACD divergence detection on daily bars vs recent MACD history. */
  macdDivergence?: {
    type: "bullish" | "bearish" | "none";
    detail: string;
  };
};

// ── Risk alert types ──

export type RiskAlert = {
  level: "critical" | "warning" | "watch" | "clear";
  signals: {
    name: string;
    status: "danger" | "caution" | "ok";
    detail: string;
  }[];
  summary: string;
  dangerCount: number;
  cautionCount: number;
};

// ── Pure computation functions ──

export function computeSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export function computeEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // default neutral
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth with Wilder's method
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeMACD(closes: number[]): {
  macdLine: number;
  signalLine: number;
  histogram: number;
  macdHistory: number[];
  signalHistory: number[];
} {
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);

  const macdHistory: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdHistory.push(ema12[i] - ema26[i]);
  }

  const signalHistory = computeEMA(macdHistory, 9);

  const macdLine = macdHistory[macdHistory.length - 1] ?? 0;
  const signalLine = signalHistory[signalHistory.length - 1] ?? 0;
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram, macdHistory, signalHistory };
}

// ── Ichimoku computation ──

function periodHighLow(highs: number[], lows: number[], end: number, period: number): { high: number; low: number } {
  const start = Math.max(0, end - period + 1);
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= end; i++) {
    if (highs[i] > high) high = highs[i];
    if (lows[i] < low) low = lows[i];
  }
  return { high, low };
}

function computeIchimoku(
  closes: number[],
  highs: number[],
  lows: number[]
): TechnicalIndicators["ichimoku"] | null {
  const len = closes.length;
  if (len < 52) return null; // Need at least 52 periods

  const idx = len - 1; // Current bar index
  const currentPrice = closes[idx];

  // Tenkan-sen (Conversion Line): (9-period high + 9-period low) / 2
  const tenkan9 = periodHighLow(highs, lows, idx, 9);
  const tenkanSen = (tenkan9.high + tenkan9.low) / 2;

  // Kijun-sen (Base Line): (26-period high + 26-period low) / 2
  const kijun26 = periodHighLow(highs, lows, idx, 26);
  const kijunSen = (kijun26.high + kijun26.low) / 2;

  // Senkou Span A: (Tenkan + Kijun) / 2, plotted 26 periods ahead
  // For current cloud, we use the value computed 26 periods ago
  const spanAIdx = idx - 26;
  let senkouSpanA: number;
  if (spanAIdx >= 8) {
    const t9 = periodHighLow(highs, lows, spanAIdx, 9);
    const k26 = periodHighLow(highs, lows, spanAIdx, 26);
    senkouSpanA = ((t9.high + t9.low) / 2 + (k26.high + k26.low) / 2) / 2;
  } else {
    senkouSpanA = (tenkanSen + kijunSen) / 2;
  }

  // Senkou Span B: (52-period high + 52-period low) / 2, plotted 26 periods ahead
  // For current cloud, we use the value computed 26 periods ago
  let senkouSpanB: number;
  if (spanAIdx >= 51) {
    const s52 = periodHighLow(highs, lows, spanAIdx, 52);
    senkouSpanB = (s52.high + s52.low) / 2;
  } else {
    const s52 = periodHighLow(highs, lows, idx, 52);
    senkouSpanB = (s52.high + s52.low) / 2;
  }

  const cloudTop = Math.max(senkouSpanA, senkouSpanB);
  const cloudBottom = Math.min(senkouSpanA, senkouSpanB);

  // Chikou Span: current close compared to price 26 periods ago
  const chikouRefIdx = idx - 26;
  const chikouSpan = currentPrice;
  const chikouRefPrice = chikouRefIdx >= 0 ? closes[chikouRefIdx] : currentPrice;
  const chikouVsPrice = chikouRefPrice !== 0 ? ((chikouSpan - chikouRefPrice) / chikouRefPrice) * 100 : 0;

  // ── Derive signals ──

  // Price vs Cloud
  let priceVsCloud: "above" | "inside" | "below";
  if (currentPrice > cloudTop) priceVsCloud = "above";
  else if (currentPrice < cloudBottom) priceVsCloud = "below";
  else priceVsCloud = "inside";

  // TK Cross (Tenkan vs Kijun)
  let tkCross: "bullish" | "bearish" | "neutral" = "neutral";
  if (tenkanSen > kijunSen) tkCross = "bullish";
  else if (tenkanSen < kijunSen) tkCross = "bearish";

  // Detect recent TK crossover (within last 5 days)
  let tkCrossRecent = false;
  for (let i = Math.max(0, len - 6); i < len - 1; i++) {
    const prevT = periodHighLow(highs, lows, i, 9);
    const prevK = periodHighLow(highs, lows, i, 26);
    const prevTenkan = (prevT.high + prevT.low) / 2;
    const prevKijun = (prevK.high + prevK.low) / 2;
    const curT = periodHighLow(highs, lows, i + 1, 9);
    const curK = periodHighLow(highs, lows, i + 1, 26);
    const curTenkan = (curT.high + curT.low) / 2;
    const curKijun = (curK.high + curK.low) / 2;
    if ((prevTenkan <= prevKijun && curTenkan > curKijun) ||
        (prevTenkan >= prevKijun && curTenkan < curKijun)) {
      tkCrossRecent = true;
    }
  }

  // Cloud Trend: future Span A vs Span B (using current values projected ahead)
  const futureSpanA = (tenkanSen + kijunSen) / 2;
  const futureSpanB52 = periodHighLow(highs, lows, idx, 52);
  const futureSpanB = (futureSpanB52.high + futureSpanB52.low) / 2;
  let cloudTrend: "bullish" | "bearish" | "twisting" = "neutral" as any;
  if (futureSpanA > futureSpanB && senkouSpanA > senkouSpanB) cloudTrend = "bullish";
  else if (futureSpanA < futureSpanB && senkouSpanA < senkouSpanB) cloudTrend = "bearish";
  else cloudTrend = "twisting";

  // Chikou Signal
  let chikouSignal: "bullish" | "bearish" | "neutral" = "neutral";
  if (chikouVsPrice > 2) chikouSignal = "bullish";
  else if (chikouVsPrice < -2) chikouSignal = "bearish";

  // Cloud thickness as % of price
  const cloudThickness = currentPrice !== 0 ? ((cloudTop - cloudBottom) / currentPrice) * 100 : 0;

  // Overall Ichimoku signal (5 factors)
  let bullPoints = 0;
  let bearPoints = 0;

  // 1. Price vs cloud (2 points — most important)
  if (priceVsCloud === "above") bullPoints += 2;
  else if (priceVsCloud === "below") bearPoints += 2;

  // 2. TK cross
  if (tkCross === "bullish") bullPoints += 1;
  else if (tkCross === "bearish") bearPoints += 1;

  // 3. Cloud trend
  if (cloudTrend === "bullish") bullPoints += 1;
  else if (cloudTrend === "bearish") bearPoints += 1;

  // 4. Chikou
  if (chikouSignal === "bullish") bullPoints += 1;
  else if (chikouSignal === "bearish") bearPoints += 1;

  let overallSignal: TechnicalIndicators["ichimoku"]["overallSignal"];
  const net = bullPoints - bearPoints;
  if (net >= 4) overallSignal = "strong_bullish";
  else if (net >= 2) overallSignal = "bullish";
  else if (net <= -4) overallSignal = "strong_bearish";
  else if (net <= -2) overallSignal = "bearish";
  else overallSignal = "neutral";

  // Summary
  const parts: string[] = [];
  if (priceVsCloud === "above") parts.push("price above cloud (bullish)");
  else if (priceVsCloud === "below") parts.push("price below cloud (bearish)");
  else parts.push("price inside cloud (indecision)");

  if (tkCrossRecent) parts.push(`recent TK ${tkCross} cross`);
  else if (tkCross !== "neutral") parts.push(`TK ${tkCross}`);

  if (cloudTrend === "twisting") parts.push("cloud twisting (trend change)");
  else parts.push(`cloud ${cloudTrend}`);

  if (chikouSignal !== "neutral") parts.push(`chikou ${chikouSignal}`);

  const signalLabel = overallSignal.replace("_", " ");
  const signalSummary = `Ichimoku ${signalLabel}: ${parts.join(", ")}`;

  return {
    tenkanSen,
    kijunSen,
    senkouSpanA,
    senkouSpanB,
    cloudTop,
    cloudBottom,
    chikouSpan,
    chikouVsPrice,
    priceVsCloud,
    tkCross,
    tkCrossRecent,
    cloudTrend,
    chikouSignal,
    cloudThickness,
    overallSignal,
    signalSummary,
  };
}

// ── Resampling helpers ──
//
// Daily → weekly (ISO-week, Monday-anchored) or monthly (calendar month).
// Aggregate OHLCV: first bar's open, max high, min low, last close,
// summed volume. Bars with non-finite prices are skipped.
//
// Used to feed computeRSI / computeMACD on higher timeframes without
// double-fetching from Yahoo — we already have daily bars for every
// scored stock.

export function resampleToWeekly(bars: readonly OHLCVBar[]): OHLCVBar[] {
  if (!bars.length) return [];
  const byWeek = new Map<string, OHLCVBar>();
  for (const b of bars) {
    if (!isFinite(b.close) || b.close <= 0) continue;
    const d = new Date(b.date);
    if (!isFinite(d.getTime())) continue;
    const dayIdx = d.getUTCDay() || 7; // Sunday = 7
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dayIdx - 1)));
    const key = monday.toISOString().slice(0, 10);
    const ex = byWeek.get(key);
    if (!ex) {
      byWeek.set(key, { date: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      ex.high = Math.max(ex.high, b.high);
      ex.low = Math.min(ex.low, b.low);
      ex.close = b.close;
      ex.volume += b.volume;
    }
  }
  return [...byWeek.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function resampleToMonthly(bars: readonly OHLCVBar[]): OHLCVBar[] {
  if (!bars.length) return [];
  const byMonth = new Map<string, OHLCVBar>();
  for (const b of bars) {
    if (!isFinite(b.close) || b.close <= 0) continue;
    const d = new Date(b.date);
    if (!isFinite(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const ex = byMonth.get(key);
    if (!ex) {
      byMonth.set(key, { date: `${key}-01`, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      ex.high = Math.max(ex.high, b.high);
      ex.low = Math.min(ex.low, b.low);
      ex.close = b.close;
      ex.volume += b.volume;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Distance from all-time high in the provided bar history. Returns null
 * when there's no usable data. `pct` is <= 0: 0 means "at the ATH",
 * -12.3 means 12.3% below ATH.
 */
export function computeDistanceFromATH(bars: readonly OHLCVBar[]): { pct: number; daysAgo: number; athPrice: number } | null {
  if (!bars.length) return null;
  let athIdx = -1;
  let athPrice = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].high;
    if (isFinite(h) && h > athPrice) {
      athPrice = h;
      athIdx = i;
    }
  }
  if (athIdx < 0 || !isFinite(athPrice) || athPrice <= 0) return null;
  const last = bars[bars.length - 1].close;
  if (!isFinite(last) || last <= 0) return null;
  const pct = ((last - athPrice) / athPrice) * 100;
  return { pct, daysAgo: bars.length - 1 - athIdx, athPrice };
}

/**
 * Signed distance from the nearest Ichimoku cloud edge as a % of the
 * current price.
 *   - Price above cloud: +N% (distance above the cloud top).
 *   - Price below cloud: -N% (distance below the cloud bottom).
 *   - Price inside cloud: 0%.
 */
export function computeDistanceFromCloudEdge(
  price: number,
  cloudTop: number,
  cloudBottom: number
): { pct: number; position: "above" | "below" | "inside" } | null {
  if (!isFinite(price) || price <= 0 || !isFinite(cloudTop) || !isFinite(cloudBottom)) return null;
  if (price > cloudTop) return { pct: ((price - cloudTop) / price) * 100, position: "above" };
  if (price < cloudBottom) return { pct: ((price - cloudBottom) / price) * 100, position: "below" };
  return { pct: 0, position: "inside" };
}

/**
 * MACD divergence detection over roughly the last N bars of MACD history.
 *
 *   - Bullish divergence: price prints a LOWER low but MACD prints a
 *     HIGHER low (momentum diverging positively from price).
 *   - Bearish divergence: price prints a HIGHER high but MACD prints a
 *     LOWER high.
 *
 * We pick the two most-recent swing extremes inside the lookback window
 * and compare them. This is an approximation (proper divergence uses
 * confirmed pivots) but catches the same cases Newton flags on charts.
 */
export function computeMacdDivergence(
  bars: readonly OHLCVBar[],
  macdHistory: readonly number[],
  lookback: number = 40
): { type: "bullish" | "bearish" | "none"; detail: string } {
  if (bars.length < lookback || macdHistory.length < lookback) {
    return { type: "none", detail: "Insufficient history for divergence check" };
  }
  const n = bars.length;
  const m = macdHistory.length;
  const slice = bars.slice(n - lookback);
  const macdSlice = macdHistory.slice(m - lookback);

  // Split into two halves: older vs newer. Compare price low/high and
  // macd low/high in each half.
  const half = Math.floor(lookback / 2);
  let oldLowIdx = 0, oldHighIdx = 0, newLowIdx = half, newHighIdx = half;
  for (let i = 0; i < half; i++) {
    if (slice[i].low < slice[oldLowIdx].low) oldLowIdx = i;
    if (slice[i].high > slice[oldHighIdx].high) oldHighIdx = i;
  }
  for (let i = half; i < lookback; i++) {
    if (slice[i].low < slice[newLowIdx].low) newLowIdx = i;
    if (slice[i].high > slice[newHighIdx].high) newHighIdx = i;
  }

  const priceLowerLow = slice[newLowIdx].low < slice[oldLowIdx].low;
  const macdHigherLow = macdSlice[newLowIdx] > macdSlice[oldLowIdx];
  const priceHigherHigh = slice[newHighIdx].high > slice[oldHighIdx].high;
  const macdLowerHigh = macdSlice[newHighIdx] < macdSlice[oldHighIdx];

  // Require the newer swing to be in the most recent ~15 bars so we
  // don't flag ancient divergences that already played out.
  const recentWindow = Math.min(15, lookback);
  const newLowRecent = newLowIdx >= lookback - recentWindow;
  const newHighRecent = newHighIdx >= lookback - recentWindow;

  if (priceLowerLow && macdHigherLow && newLowRecent) {
    return { type: "bullish", detail: `Price made lower low; MACD made higher low — bullish divergence` };
  }
  if (priceHigherHigh && macdLowerHigh && newHighRecent) {
    return { type: "bearish", detail: `Price made higher high; MACD made lower high — bearish divergence` };
  }
  return { type: "none", detail: "No divergence detected in recent swings" };
}

// ── Master computation function ──

export function computeTechnicals(bars: OHLCVBar[]): TechnicalIndicators | null {
  if (bars.length < 30) return null; // Need minimum data

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const currentPrice = closes[closes.length - 1];

  // Moving averages
  const sma50 = computeSMA(closes, 50);
  const sma200 = computeSMA(closes, 200);

  // DMA crossover detection
  let dmaSignal: TechnicalIndicators["dmaSignal"] = "between";
  let dmaCrossoverDaysAgo: number | undefined;

  if (closes.length >= 200) {
    // Compute SMA50 and SMA200 for recent days to detect crossovers
    const lookback = Math.min(60, closes.length - 200);
    let lastCrossoverDay: number | undefined;
    let crossoverType: "golden_cross" | "death_cross" | undefined;

    for (let i = closes.length - lookback; i < closes.length; i++) {
      const prevSma50 = computeSMA(closes.slice(0, i), 50);
      const prevSma200 = computeSMA(closes.slice(0, i), 200);
      const curSma50 = computeSMA(closes.slice(0, i + 1), 50);
      const curSma200 = computeSMA(closes.slice(0, i + 1), 200);

      if (prevSma50 <= prevSma200 && curSma50 > curSma200) {
        lastCrossoverDay = closes.length - 1 - i;
        crossoverType = "golden_cross";
      } else if (prevSma50 >= prevSma200 && curSma50 < curSma200) {
        lastCrossoverDay = closes.length - 1 - i;
        crossoverType = "death_cross";
      }
    }

    if (crossoverType && lastCrossoverDay != null && lastCrossoverDay <= 20) {
      dmaSignal = crossoverType;
      dmaCrossoverDaysAgo = lastCrossoverDay;
    } else if (currentPrice > sma50 && currentPrice > sma200) {
      dmaSignal = "above_both";
    } else if (currentPrice < sma50 && currentPrice < sma200) {
      dmaSignal = "below_both";
    } else {
      dmaSignal = "between";
    }
  } else {
    // Not enough data for 200 SMA; use 50 only
    if (currentPrice > sma50) dmaSignal = "above_both";
    else dmaSignal = "below_both";
  }

  // RSI
  const rsi14 = computeRSI(closes, 14);
  let rsiSignal: TechnicalIndicators["rsiSignal"] = "neutral";
  if (rsi14 >= 70) rsiSignal = "overbought";
  else if (rsi14 <= 30) rsiSignal = "oversold";

  // MACD
  const macd = computeMACD(closes);
  let macdSignal: TechnicalIndicators["macdSignal"] = macd.macdLine >= macd.signalLine ? "bullish" : "bearish";
  let macdCrossoverDaysAgo: number | undefined;

  // Detect recent MACD crossovers
  const macdLen = macd.macdHistory.length;
  for (let i = Math.max(0, macdLen - 10); i < macdLen - 1; i++) {
    const prevDiff = macd.macdHistory[i] - macd.signalHistory[i];
    const curDiff = macd.macdHistory[i + 1] - macd.signalHistory[i + 1];
    if (prevDiff <= 0 && curDiff > 0) {
      macdSignal = "bullish_crossover";
      macdCrossoverDaysAgo = macdLen - 1 - (i + 1);
    } else if (prevDiff >= 0 && curDiff < 0) {
      macdSignal = "bearish_crossover";
      macdCrossoverDaysAgo = macdLen - 1 - (i + 1);
    }
  }

  // Volume
  const volumeAvg50 = volumes.length >= 50
    ? volumes.slice(-50).reduce((s, v) => s + v, 0) / 50
    : volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const volumeLatest = volumes[volumes.length - 1];
  const volumeRatio = volumeAvg50 > 0 ? volumeLatest / volumeAvg50 : 1;
  let volumeSignal: TechnicalIndicators["volumeSignal"] = "normal";
  if (volumeRatio > 1.5) volumeSignal = "high_volume";
  else if (volumeRatio < 0.5) volumeSignal = "low_volume";

  // 52-week range
  const week52High = Math.max(...highs);
  const week52Low = Math.min(...lows);
  const week52Range = week52High - week52Low;
  const week52Position = week52Range > 0 ? (currentPrice - week52Low) / week52Range : 0.5;

  // Price changes
  const priceChange5d = closes.length >= 6
    ? ((currentPrice - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
    : 0;
  const priceChange20d = closes.length >= 21
    ? ((currentPrice - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
    : 0;

  const ichimokuResolved = computeIchimoku(closes, highs, lows) ?? {
    tenkanSen: 0, kijunSen: 0, senkouSpanA: 0, senkouSpanB: 0,
    cloudTop: 0, cloudBottom: 0, chikouSpan: 0, chikouVsPrice: 0,
    priceVsCloud: "inside" as const, tkCross: "neutral" as const, tkCrossRecent: false,
    cloudTrend: "bullish" as const, chikouSignal: "neutral" as const,
    cloudThickness: 0, overallSignal: "neutral" as const, signalSummary: "Insufficient data for Ichimoku",
  };
  const distanceFromCloudEdge = computeDistanceFromCloudEdge(
    currentPrice,
    ichimokuResolved.cloudTop,
    ichimokuResolved.cloudBottom,
  ) ?? undefined;

  return {
    sma50,
    sma200,
    dmaSignal,
    dmaCrossoverDaysAgo,
    rsi14,
    rsiSignal,
    macdLine: macd.macdLine,
    signalLine: macd.signalLine,
    macdHistogram: macd.histogram,
    macdSignal,
    macdCrossoverDaysAgo,
    volumeAvg50,
    volumeLatest,
    volumeRatio,
    volumeSignal,
    week52High,
    week52Low,
    week52Position: Math.max(0, Math.min(1, week52Position)),
    currentPrice,
    priceChange5d,
    priceChange20d,

    // Higher-timeframe MACD / RSI (resample in place from daily bars).
    // Computed opportunistically: if there aren't enough weekly/monthly
    // bars for a meaningful read, leave the field undefined.
    ...(() => {
      const weekly = resampleToWeekly(bars);
      const monthly = resampleToMonthly(bars);
      const wClose = weekly.map((b) => b.close);
      const mClose = monthly.map((b) => b.close);
      const extras: Partial<TechnicalIndicators> = {};
      if (wClose.length >= 35) {
        const wm = computeMACD(wClose);
        extras.weeklyMacd = {
          macdLine: wm.macdLine,
          signalLine: wm.signalLine,
          histogram: wm.histogram,
          signal: wm.macdLine >= wm.signalLine ? "bullish" : "bearish",
        };
        extras.weeklyRsi = computeRSI(wClose, 14);
      }
      if (mClose.length >= 35) {
        const mm = computeMACD(mClose);
        extras.monthlyMacd = {
          macdLine: mm.macdLine,
          signalLine: mm.signalLine,
          histogram: mm.histogram,
          signal: mm.macdLine >= mm.signalLine ? "bullish" : "bearish",
        };
        extras.monthlyRsi = computeRSI(mClose, 14);
      }
      const ath = computeDistanceFromATH(bars);
      if (ath) extras.distanceFromATH = ath;
      extras.macdDivergence = computeMacdDivergence(bars, macd.macdHistory);
      return extras;
    })(),
    distanceFromCloudEdge,

    // Ichimoku Cloud
    ichimoku: ichimokuResolved,
  };
}

// ── Risk alert computation ──

export function computeRiskAlert(
  technicals: TechnicalIndicators,
  healthData?: HealthData
): RiskAlert {
  const signals: RiskAlert["signals"] = [];

  // 1. Trend
  if (technicals.dmaSignal === "death_cross" || technicals.dmaSignal === "below_both") {
    signals.push({ name: "Trend", status: "danger", detail: technicals.dmaSignal === "death_cross" ? `Death cross ${technicals.dmaCrossoverDaysAgo != null ? `${technicals.dmaCrossoverDaysAgo}d ago` : "recent"} — 50 DMA crossed below 200 DMA` : `Below both 50 & 200 DMA — sustained downtrend` });
  } else if (technicals.dmaSignal === "between") {
    signals.push({ name: "Trend", status: "caution", detail: "Between 50 & 200 DMA — mixed trend signal" });
  } else {
    signals.push({ name: "Trend", status: "ok", detail: technicals.dmaSignal === "golden_cross" ? `Golden cross ${technicals.dmaCrossoverDaysAgo != null ? `${technicals.dmaCrossoverDaysAgo}d ago` : "recent"}` : "Above both moving averages — uptrend intact" });
  }

  // 2. Momentum (RSI)
  if (technicals.rsi14 > 75) {
    signals.push({ name: "Momentum (RSI)", status: "danger", detail: `RSI at ${technicals.rsi14.toFixed(0)} — severely overbought` });
  } else if (technicals.rsi14 > 70) {
    signals.push({ name: "Momentum (RSI)", status: "caution", detail: `RSI at ${technicals.rsi14.toFixed(0)} — overbought territory` });
  } else if (technicals.rsi14 < 25) {
    signals.push({ name: "Momentum (RSI)", status: "danger", detail: `RSI at ${technicals.rsi14.toFixed(0)} — extreme oversold, crash risk` });
  } else if (technicals.rsi14 < 30) {
    signals.push({ name: "Momentum (RSI)", status: "caution", detail: `RSI at ${technicals.rsi14.toFixed(0)} — approaching oversold` });
  } else {
    signals.push({ name: "Momentum (RSI)", status: "ok", detail: `RSI at ${technicals.rsi14.toFixed(0)} — neutral zone` });
  }

  // 3. MACD
  if (technicals.macdSignal === "bearish_crossover" && (technicals.macdCrossoverDaysAgo == null || technicals.macdCrossoverDaysAgo <= 5)) {
    signals.push({ name: "MACD", status: "danger", detail: `Bearish MACD crossover ${technicals.macdCrossoverDaysAgo != null ? `${technicals.macdCrossoverDaysAgo}d ago` : "recent"} — momentum shifting negative` });
  } else if (technicals.macdSignal === "bearish" || technicals.macdSignal === "bearish_crossover") {
    signals.push({ name: "MACD", status: "caution", detail: `MACD bearish — histogram at ${technicals.macdHistogram.toFixed(2)}` });
  } else {
    signals.push({ name: "MACD", status: "ok", detail: technicals.macdSignal === "bullish_crossover" ? `Bullish MACD crossover ${technicals.macdCrossoverDaysAgo != null ? `${technicals.macdCrossoverDaysAgo}d ago` : "recent"}` : `MACD bullish — histogram at +${technicals.macdHistogram.toFixed(2)}` });
  }

  // 4. Volume
  if (technicals.volumeSignal === "high_volume" && technicals.priceChange5d < -2) {
    signals.push({ name: "Volume", status: "danger", detail: `Distribution — volume ${technicals.volumeRatio.toFixed(1)}x avg on ${technicals.priceChange5d.toFixed(1)}% price decline` });
  } else if (technicals.volumeSignal === "high_volume" && technicals.priceChange5d < 0) {
    signals.push({ name: "Volume", status: "caution", detail: `Elevated volume ${technicals.volumeRatio.toFixed(1)}x avg with slight price weakness` });
  } else {
    signals.push({ name: "Volume", status: "ok", detail: `Volume ${technicals.volumeRatio.toFixed(1)}x 50d average — normal` });
  }

  // 5. Ichimoku Cloud
  const ichi = technicals.ichimoku;
  if (ichi.overallSignal === "strong_bearish" || (ichi.priceVsCloud === "below" && ichi.tkCross === "bearish")) {
    signals.push({ name: "Ichimoku Cloud", status: "danger", detail: ichi.signalSummary });
  } else if (ichi.overallSignal === "bearish" || ichi.priceVsCloud === "below" || ichi.priceVsCloud === "inside") {
    signals.push({ name: "Ichimoku Cloud", status: "caution", detail: ichi.signalSummary });
  } else {
    signals.push({ name: "Ichimoku Cloud", status: "ok", detail: ichi.signalSummary });
  }

  // 7. Short Interest (from healthData)
  if (healthData?.shortPercentOfFloat != null) {
    if (healthData.shortPercentOfFloat > 10) {
      signals.push({ name: "Short Interest", status: "danger", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — elevated bearish positioning` });
    } else if (healthData.shortPercentOfFloat > 5) {
      signals.push({ name: "Short Interest", status: "caution", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — moderate` });
    } else {
      signals.push({ name: "Short Interest", status: "ok", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — low` });
    }
  }

  // Valuation (PEG) intentionally excluded from risk alerts — tracked in Stock Health Monitor only

  // Compute counts and level
  const dangerCount = signals.filter((s) => s.status === "danger").length;
  const cautionCount = signals.filter((s) => s.status === "caution").length;

  let level: RiskAlert["level"] = "clear";
  if (dangerCount >= 3) level = "critical";
  else if (dangerCount >= 2 || cautionCount >= 4) level = "warning";
  else if (dangerCount >= 1 || cautionCount >= 2) level = "watch";

  // Auto-generate summary
  let summary: string;
  if (level === "critical") {
    const dangerNames = signals.filter((s) => s.status === "danger").map((s) => s.name.toLowerCase());
    summary = `${dangerCount} danger signals converging: ${dangerNames.join(", ")} — elevated risk of further downside.`;
  } else if (level === "warning") {
    const issueNames = signals.filter((s) => s.status !== "ok").map((s) => s.name.toLowerCase());
    summary = `Elevated risk with ${dangerCount} danger and ${cautionCount} caution signals: ${issueNames.join(", ")}.`;
  } else if (level === "watch") {
    const issueNames = signals.filter((s) => s.status !== "ok").map((s) => s.name.toLowerCase());
    summary = `Monitor: ${issueNames.join(", ")} flagging — no immediate action required.`;
  } else {
    summary = "All technical and fundamental signals within normal ranges.";
  }

  return { level, signals, summary, dangerCount, cautionCount };
}

// ── "Improving" signal detection ──
// Identifies stocks trending TOWARD positive territory (not already there).
// Requires raw OHLCV bars to compute trailing indicator values.

export type ImprovingSignal = {
  name: string;
  active: boolean;
  detail: string;
};

export type ImprovingScore = {
  signals: ImprovingSignal[];
  score: number; // 0-6
  label: "Strong" | "Moderate" | "Weak" | "None";
};

export function computeImprovingSignals(bars: OHLCVBar[], current: TechnicalIndicators): ImprovingScore {
  const signals: ImprovingSignal[] = [];
  const closes = bars.map((b) => b.close);

  // We need at least 30 bars for meaningful lookback
  if (closes.length < 30) {
    return { signals: [], score: 0, label: "None" };
  }

  // 1. RSI Rising from Oversold
  // RSI was below 40 within last 10 days and is now higher (momentum building)
  {
    const lookback = 10;
    let wasLow = false;
    let minRecentRsi = 100;
    for (let i = Math.max(0, closes.length - lookback - 1); i < closes.length - 1; i++) {
      const pastRsi = computeRSI(closes.slice(0, i + 1), 14);
      if (pastRsi < 40) wasLow = true;
      if (pastRsi < minRecentRsi) minRecentRsi = pastRsi;
    }
    const rising = wasLow && current.rsi14 > minRecentRsi + 3 && current.rsi14 < 65;
    signals.push({
      name: "RSI Recovery",
      active: rising,
      detail: rising
        ? `RSI rising from ${minRecentRsi.toFixed(0)} to ${current.rsi14.toFixed(0)} — momentum building`
        : `RSI at ${current.rsi14.toFixed(0)} — no recovery pattern`,
    });
  }

  // 2. MACD Histogram Improving
  // Histogram was negative and is now less negative or just crossed positive
  {
    const macd = computeMACD(closes);
    const histLen = macd.macdHistory.length;
    let improving = false;
    let detail = "";
    if (histLen >= 5) {
      const hist5ago = macd.macdHistory[histLen - 5] - (computeEMA(macd.macdHistory, 9)[histLen - 5] ?? 0);
      const histNow = current.macdHistogram;
      improving = hist5ago < 0 && histNow > hist5ago && (histNow > hist5ago * 0.5 || histNow > 0);
      detail = improving
        ? `Histogram improving from ${hist5ago.toFixed(3)} to ${histNow.toFixed(3)} — momentum turning`
        : `Histogram at ${histNow.toFixed(3)} — not improving`;
    } else {
      detail = "Insufficient MACD history";
    }
    signals.push({ name: "MACD Improving", active: improving, detail });
  }

  // 3. Price Approaching 50 DMA from Below
  // Price is below 50 DMA but within 3%, or just crossed above within last 5 days
  {
    const pctFrom50 = current.sma50 !== 0 ? ((current.currentPrice - current.sma50) / current.sma50) * 100 : 0;
    const approaching = pctFrom50 > -3 && pctFrom50 < 1 && current.currentPrice < current.sma50;
    const justCrossed = current.dmaSignal === "between" && pctFrom50 >= 0 && pctFrom50 < 2;

    // Check if price was below 50 DMA 5 days ago and now closer or above
    let wasFurtherBelow = false;
    if (closes.length >= 6) {
      const price5ago = closes[closes.length - 6];
      const sma50_5ago = computeSMA(closes.slice(0, closes.length - 5), 50);
      const pctThen = sma50_5ago !== 0 ? ((price5ago - sma50_5ago) / sma50_5ago) * 100 : 0;
      wasFurtherBelow = pctThen < pctFrom50 && pctThen < 0;
    }

    const active = approaching || justCrossed || wasFurtherBelow;
    signals.push({
      name: "DMA Approach",
      active,
      detail: active
        ? approaching
          ? `Price ${pctFrom50.toFixed(1)}% from 50 DMA — approaching from below`
          : justCrossed
          ? `Price just crossed above 50 DMA (+${pctFrom50.toFixed(1)}%)`
          : `Price closing gap with 50 DMA — was further below 5 days ago`
        : `Price ${pctFrom50.toFixed(1)}% from 50 DMA — no approach pattern`,
    });
  }

  // 4. Recent Bullish Crossover (golden cross or MACD bullish crossover within last 10 days)
  {
    const recentGolden = current.dmaSignal === "golden_cross" && current.dmaCrossoverDaysAgo != null && current.dmaCrossoverDaysAgo <= 10;
    const recentMacdBull = current.macdSignal === "bullish_crossover" && current.macdCrossoverDaysAgo != null && current.macdCrossoverDaysAgo <= 10;
    const recentTkBull = current.ichimoku.tkCrossRecent && current.ichimoku.tkCross === "bullish";
    const active = recentGolden || recentMacdBull || recentTkBull;
    const parts: string[] = [];
    if (recentGolden) parts.push(`golden cross ${current.dmaCrossoverDaysAgo}d ago`);
    if (recentMacdBull) parts.push(`MACD bullish crossover ${current.macdCrossoverDaysAgo}d ago`);
    if (recentTkBull) parts.push("recent TK bullish cross");
    signals.push({
      name: "Bullish Crossover",
      active,
      detail: active ? `Recent crossovers: ${parts.join(", ")}` : "No recent bullish crossovers",
    });
  }

  // 5. Ichimoku Cloud Entry — price entering cloud from below or breaking above
  {
    const entering = current.ichimoku.priceVsCloud === "inside" && current.priceChange5d > 0;
    // Check if was below cloud recently
    let wasBelowCloud = false;
    if (closes.length >= 6) {
      const price5ago = closes[closes.length - 6];
      if (price5ago < current.ichimoku.cloudBottom) wasBelowCloud = true;
    }
    const breakingOut = current.ichimoku.priceVsCloud === "above" && wasBelowCloud;
    const active = (entering && wasBelowCloud) || breakingOut;
    signals.push({
      name: "Cloud Breakout",
      active,
      detail: active
        ? breakingOut
          ? "Price broke above Ichimoku cloud — bullish breakout"
          : "Price entering cloud from below — potential reversal forming"
        : `Price ${current.ichimoku.priceVsCloud} cloud — no entry pattern`,
    });
  }

  // 6. Volume Accumulation — high volume on positive price days
  {
    const active = current.volumeSignal === "high_volume" && current.priceChange5d > 1;
    signals.push({
      name: "Accumulation",
      active,
      detail: active
        ? `Volume ${current.volumeRatio.toFixed(1)}x avg with +${current.priceChange5d.toFixed(1)}% price gain — accumulation`
        : current.volumeSignal === "high_volume"
        ? `High volume but price ${current.priceChange5d.toFixed(1)}% — not accumulation`
        : `Volume normal (${current.volumeRatio.toFixed(1)}x)`,
    });
  }

  const score = signals.filter((s) => s.active).length;
  const label: ImprovingScore["label"] =
    score >= 4 ? "Strong" : score >= 2 ? "Moderate" : score >= 1 ? "Weak" : "None";

  return { signals, score, label };
}

// ── Helper to format technicals summary for Claude prompt ──

export function formatTechnicalsForPrompt(t: TechnicalIndicators): string {
  return [
    `TECHNICAL INDICATORS SUMMARY:`,
    `Price: $${t.currentPrice.toFixed(2)} | 5d change: ${t.priceChange5d.toFixed(1)}% | 20d change: ${t.priceChange20d.toFixed(1)}%`,
    `50 DMA: $${t.sma50.toFixed(2)} | 200 DMA: $${t.sma200.toFixed(2)} | Signal: ${t.dmaSignal}`,
    `RSI(14): ${t.rsi14.toFixed(1)} (${t.rsiSignal})`,
    `MACD: ${t.macdLine.toFixed(3)} | Signal: ${t.signalLine.toFixed(3)} | Histogram: ${t.macdHistogram.toFixed(3)} (${t.macdSignal})`,
    `Volume: ${t.volumeRatio.toFixed(1)}x 50d avg (${t.volumeSignal})`,
    `52-Week: $${t.week52Low.toFixed(2)} - $${t.week52High.toFixed(2)} (${(t.week52Position * 100).toFixed(0)}% position)`,
    `Ichimoku Cloud: ${t.ichimoku.signalSummary} | Cloud: $${t.ichimoku.cloudBottom.toFixed(2)}-$${t.ichimoku.cloudTop.toFixed(2)} (${t.ichimoku.cloudThickness.toFixed(1)}% thick)`,
  ].join("\n");
}

// ── SMA series for chart overlays ──

export function computeSMASeries(bars: OHLCVBar[], period: number): { date: string; value: number }[] {
  const result: { date: string; value: number }[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    result.push({ date: bars[i].date, value: sum / period });
  }
  return result;
}
