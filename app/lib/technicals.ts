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

    // Ichimoku Cloud
    ichimoku: computeIchimoku(closes, highs, lows) ?? {
      tenkanSen: 0, kijunSen: 0, senkouSpanA: 0, senkouSpanB: 0,
      cloudTop: 0, cloudBottom: 0, chikouSpan: 0, chikouVsPrice: 0,
      priceVsCloud: "inside" as const, tkCross: "neutral" as const, tkCrossRecent: false,
      cloudTrend: "bullish" as const, chikouSignal: "neutral" as const,
      cloudThickness: 0, overallSignal: "neutral" as const, signalSummary: "Insufficient data for Ichimoku",
    },
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

  // 7. Earnings Revisions (from healthData)
  if (healthData?.earningsCurrentEst != null && healthData?.earnings30dAgo != null) {
    if (healthData.earningsCurrentEst < healthData.earnings30dAgo) {
      signals.push({ name: "Earnings Revisions", status: "danger", detail: `Estimate cut: $${healthData.earningsCurrentEst.toFixed(2)} vs $${healthData.earnings30dAgo.toFixed(2)} 30d ago` });
    } else if (healthData.earningsCurrentEst === healthData.earnings30dAgo) {
      signals.push({ name: "Earnings Revisions", status: "caution", detail: `Estimates flat at $${healthData.earningsCurrentEst.toFixed(2)} — no positive revisions` });
    } else {
      signals.push({ name: "Earnings Revisions", status: "ok", detail: `Estimates revised up: $${healthData.earningsCurrentEst.toFixed(2)} vs $${healthData.earnings30dAgo.toFixed(2)} 30d ago` });
    }
  }

  // 8. Short Interest (from healthData)
  if (healthData?.shortPercentOfFloat != null) {
    if (healthData.shortPercentOfFloat > 10) {
      signals.push({ name: "Short Interest", status: "danger", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — elevated bearish positioning` });
    } else if (healthData.shortPercentOfFloat > 5) {
      signals.push({ name: "Short Interest", status: "caution", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — moderate` });
    } else {
      signals.push({ name: "Short Interest", status: "ok", detail: `Short interest at ${healthData.shortPercentOfFloat.toFixed(1)}% of float — low` });
    }
  }

  // 9. Valuation (PEG from healthData)
  if (healthData?.pegRatio != null) {
    if (healthData.pegRatio > 3) {
      signals.push({ name: "Valuation (PEG)", status: "danger", detail: `PEG ratio at ${healthData.pegRatio.toFixed(2)} — significantly overvalued on growth-adjusted basis` });
    } else if (healthData.pegRatio > 2) {
      signals.push({ name: "Valuation (PEG)", status: "caution", detail: `PEG ratio at ${healthData.pegRatio.toFixed(2)} — expensive relative to growth` });
    } else {
      signals.push({ name: "Valuation (PEG)", status: "ok", detail: `PEG ratio at ${healthData.pegRatio.toFixed(2)} — reasonable valuation` });
    }
  }

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
