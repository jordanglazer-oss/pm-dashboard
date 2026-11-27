/**
 * The signal grid (Nov 26 2026 team session): six separate reads per name,
 * each Positive / Neutral / Negative, with NO aggregate score. Pure — no I/O.
 * READ-ONLY use: nothing here is stored and nothing feeds a score, a weight
 * or a trade. Thresholds live in signal-config.ts.
 *
 * "pending" = the source is not on file; it is never counted as neutral and
 * never guessed. Every signal carries the numbers behind it (`rows`) so a
 * cell can be opened to see why it reads the way it does.
 */

import { SIGNAL_CONFIG, type SignalConfig } from "./signal-config";

export type SignalState = "positive" | "neutral" | "negative" | "pending";
export type SignalRow = { label: string; value: string; read: SignalState };
export type Signal = { state: SignalState; summary: string; rows: SignalRow[]; asOf?: string | null };
export type SignalKey = "fundamentals" | "analyst" | "upside" | "house" | "technicals" | "relStrength";
export const SIGNAL_COLUMNS: { key: SignalKey; label: string; short: string }[] = [
  { key: "fundamentals", label: "Fundamentals", short: "Fund." },
  { key: "analyst", label: "Analyst consensus", short: "Analysts" },
  { key: "upside", label: "Upside to target", short: "Upside" },
  { key: "house", label: "House views", short: "House" },
  { key: "technicals", label: "Technicals", short: "Tech." },
  { key: "relStrength", label: "Relative strength", short: "Rel. str." },
];

export type HouseRating = "outperform" | "neutral" | "underperform" | "not-covered";

export type SignalInput = {
  price?: number | null;
  // Fundamentals (percent values are percents: 12 = 12%)
  peg?: number | null;
  fcfMargin?: number | null;
  roic?: number | null;
  revenueGrowth?: number | null;
  forwardPE?: number | null;
  forwardPE5yAvg?: number | null;
  evEbitda?: number | null;
  evEbitda5yAvg?: number | null;
  /** From the FactSet pull: % vs the market / sector median P/E, coverage and leverage. */
  peVsMarketPct?: number | null;
  peVsSectorPct?: number | null;
  interestCoverage?: number | null;
  netDebtEbitda?: number | null;
  /** No debt on file: coverage and leverage both read well. */
  noDebt?: boolean;
  // Street
  avgTarget?: number | null;
  analystCount?: number | null;
  revUp?: number | null;
  revDown?: number | null;
  streetAsOf?: string | null;
  // House
  rbc?: { rating?: HouseRating; target?: number | null; asOf?: string | null } | null;
  jpm?: { rating?: HouseRating; target?: number | null; asOf?: string | null } | null;
  // Technicals
  sma50?: number | null;
  sma200?: number | null;
  rsi14?: number | null;
  week52High?: number | null;
  marketEdgeOpinion?: "long" | "neutral" | "avoid" | null;
  // Relative strength
  sia?: number | null;
};

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const fmt = (v: number, d = 1) => v.toFixed(d);
const pctVs = (a: number, b: number) => (a / b - 1) * 100;

/** positives − negatives over the rows that have data → the signal. */
function tally(rows: SignalRow[], min: number, pos: number, neg: number): { state: SignalState; summary: string } {
  const live = rows.filter((r) => r.read !== "pending");
  const p = live.filter((r) => r.read === "positive").length;
  const n = live.filter((r) => r.read === "negative").length;
  if (live.length < min) return { state: "pending", summary: `${live.length} of ${rows.length} checks have data` };
  const net = p - n;
  return { state: net >= pos ? "positive" : net <= neg ? "negative" : "neutral", summary: `${p} positive, ${n} negative of ${live.length} with data` };
}

function metricRead(value: number, m: { better: string; positive: number; negative: number }): SignalState {
  if (m.better === "higher") return value >= m.positive ? "positive" : value <= m.negative ? "negative" : "neutral";
  return value <= m.positive ? "positive" : value >= m.negative ? "negative" : "neutral";
}

export function fundamentalsSignal(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): Signal {
  const values: Record<string, number | null> = {
    peVsOwn5y: num(i.forwardPE) && num(i.forwardPE5yAvg) && i.forwardPE5yAvg > 0 ? pctVs(i.forwardPE, i.forwardPE5yAvg) : null,
    evEbitdaVsOwn5y: num(i.evEbitda) && num(i.evEbitda5yAvg) && i.evEbitda5yAvg > 0 ? pctVs(i.evEbitda, i.evEbitda5yAvg) : null,
    peg: num(i.peg) && i.peg > 0 ? i.peg : null,
    fcfMargin: num(i.fcfMargin) ? i.fcfMargin : null,
    roic: num(i.roic) ? i.roic : null,
    revenueGrowth: num(i.revenueGrowth) ? i.revenueGrowth : null,
    peVsMarket: num(i.peVsMarketPct) ? i.peVsMarketPct : null,
    peVsIndustry: num(i.peVsSectorPct) ? i.peVsSectorPct : null,
    interestCoverage: num(i.interestCoverage) ? i.interestCoverage : null,
    leverage: num(i.netDebtEbitda) ? i.netDebtEbitda : null,
  };
  const rows: SignalRow[] = cfg.fundamentals.metrics.map((m) => {
    const v = "pending" in m && m.pending ? null : (values[m.id] ?? null);
    if (v == null && i.noDebt && (m.id === "interestCoverage" || m.id === "leverage")) return { label: m.label, value: "no debt", read: "positive" as const };
    if (v == null) return { label: m.label, value: "pending" in m && m.pending ? "source pending" : "no data", read: "pending" as const };
    return { label: m.label, value: `${fmt(v)}${m.unit.startsWith("%") ? "%" : m.unit === "x" ? "x" : ""}${m.unit.includes("vs") ? " " + m.unit.replace(/^% /, "") : ""}`, read: metricRead(v, m) };
  });
  return { ...tally(rows, cfg.fundamentals.minMetrics, cfg.fundamentals.netForPositive, cfg.fundamentals.netForNegative), rows };
}

export function analystSignal(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): Signal {
  const rows: SignalRow[] = [{ label: "Average rating", value: "source pending", read: "pending" }];
  const up = num(i.revUp) ? i.revUp : null;
  const down = num(i.revDown) ? i.revDown : null;
  const count = num(i.analystCount) ? i.analystCount : null;
  if (up == null || down == null) {
    rows.push({ label: "Estimate revisions, 30 days", value: "no data", read: "pending" });
    return { state: "pending", summary: "No revision data on file", rows, asOf: i.streetAsOf };
  }
  const base = count != null && count >= cfg.analyst.minAnalysts ? count : Math.max(up + down, 1);
  const share = (up - down) / base;
  const read: SignalState = share >= cfg.analyst.positiveAboveShare ? "positive" : share <= cfg.analyst.negativeBelowShare ? "negative" : "neutral";
  rows.push({ label: "Estimate revisions, 30 days", value: `${up} up, ${down} down${count != null ? ` of ${count} analysts` : ""}`, read });
  return { state: read, summary: read === "positive" ? "Estimates rising ▲" : read === "negative" ? "Estimates falling ▼" : "Estimates flat", rows, asOf: i.streetAsOf };
}

/** ▲ / ▼ / "" for the revision trend, for the grid cell. */
export function revisionArrow(s: Signal): string {
  return s.state === "positive" ? "▲" : s.state === "negative" ? "▼" : s.state === "neutral" ? "→" : "";
}

export function upsideSignal(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): Signal {
  if (!num(i.avgTarget) || !num(i.price) || !(i.price > 0) || !(i.avgTarget > 0)) return { state: "pending", summary: "No street target or price on file", rows: [{ label: "Average street target", value: num(i.avgTarget) ? fmt(i.avgTarget, 2) : "no data", read: "pending" }], asOf: i.streetAsOf };
  const up = pctVs(i.avgTarget, i.price);
  const read: SignalState = up > cfg.upside.positiveAbovePct ? "positive" : up < cfg.upside.negativeBelowPct ? "negative" : "neutral";
  return {
    state: read,
    summary: `${up >= 0 ? "+" : ""}${fmt(up)}% to target`,
    rows: [
      { label: "Average street target", value: fmt(i.avgTarget, 2), read },
      { label: "Price", value: fmt(i.price, 2), read: "neutral" },
      { label: "Upside", value: `${up >= 0 ? "+" : ""}${fmt(up)}%`, read },
    ],
    asOf: i.streetAsOf,
  };
}

const houseRead = (r: HouseRating | undefined): SignalState => (r === "outperform" ? "positive" : r === "underperform" ? "negative" : r === "neutral" ? "neutral" : "pending");
const houseLabel = (r: HouseRating | undefined) => (r === "outperform" ? "Outperform" : r === "underperform" ? "Underperform" : r === "neutral" ? "Neutral" : r === "not-covered" ? "Not covered" : "No report on file");

/** Positive only when BOTH rate it positively; negative when both negative; neutral when mixed or one is missing; pending when neither is on file. */
export function houseSignal(i: SignalInput): Signal {
  const a = houseRead(i.rbc?.rating);
  const b = houseRead(i.jpm?.rating);
  const row = (name: string, e: SignalInput["rbc"], read: SignalState): SignalRow => ({ label: name, value: `${houseLabel(e?.rating)}${num(e?.target) ? ` · target ${fmt(e!.target as number, 2)}` : ""}${e?.asOf ? ` · ${e.asOf}` : ""}`, read });
  const rows = [row("RBC", i.rbc, a), row("J.P. Morgan", i.jpm, b)];
  if (a === "pending" && b === "pending") return { state: "pending", summary: "No RBC or J.P. Morgan rating on file", rows };
  const state: SignalState = a === "positive" && b === "positive" ? "positive" : a === "negative" && b === "negative" ? "negative" : "neutral";
  return { state, summary: state === "positive" ? "Both rate it positively" : state === "negative" ? "Both rate it negatively" : a === "pending" || b === "pending" ? "One rating missing" : "Mixed", rows };
}

export function technicalsSignal(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): Signal {
  const t = cfg.technicals;
  const rows: SignalRow[] = [];
  const vs = (label: string, avg: number | null | undefined) => {
    if (!num(i.price) || !num(avg) || !(avg > 0)) return rows.push({ label, value: "no data", read: "pending" });
    const d = pctVs(i.price, avg);
    rows.push({ label, value: `${d >= 0 ? "+" : ""}${fmt(d)}%`, read: d >= 0 ? "positive" : "negative" });
  };
  vs("Price vs 50-day average", i.sma50);
  vs("Price vs 200-day average", i.sma200);
  if (num(i.rsi14)) rows.push({ label: "RSI (14-day)", value: fmt(i.rsi14, 0), read: i.rsi14 >= t.rsi.overbought ? "negative" : i.rsi14 <= t.rsi.oversold ? "negative" : i.rsi14 >= 50 ? "positive" : "neutral" });
  else rows.push({ label: "RSI (14-day)", value: "no data", read: "pending" });
  if (num(i.price) && num(i.week52High) && i.week52High > 0) {
    const below = -pctVs(i.price, i.week52High);
    rows.push({ label: "Below 52-week high", value: `${fmt(Math.max(below, 0))}%`, read: below <= t.high52.positiveWithinPct ? "positive" : below >= t.high52.negativeBeyondPct ? "negative" : "neutral" });
  } else rows.push({ label: "Below 52-week high", value: "no data", read: "pending" });
  rows.push({ label: "Market Edge opinion", value: i.marketEdgeOpinion ? i.marketEdgeOpinion.charAt(0).toUpperCase() + i.marketEdgeOpinion.slice(1) : "no data", read: !i.marketEdgeOpinion ? "pending" : i.marketEdgeOpinion === t.marketEdge.positive ? "positive" : i.marketEdgeOpinion === t.marketEdge.negative ? "negative" : "neutral" });
  rows.push({ label: "On-balance volume", value: "source pending", read: "pending" });
  return { ...tally(rows, t.minChecks, t.netForPositive, t.netForNegative), rows };
}

export function relStrengthSignal(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): Signal {
  if (!num(i.sia)) return { state: "pending", summary: "No SIA reading on file", rows: [{ label: "SIA SMAX (0 to 10)", value: "no data", read: "pending" }] };
  const read: SignalState = i.sia >= cfg.relStrength.positiveAtOrAbove ? "positive" : i.sia <= cfg.relStrength.negativeAtOrBelow ? "negative" : "neutral";
  return { state: read, summary: `SMAX ${fmt(i.sia, 0)} of 10`, rows: [{ label: "SIA SMAX (0 to 10)", value: fmt(i.sia, 0), read }] };
}

export type SignalSet = Record<SignalKey, Signal> & { positives: number; withData: number };

/** All six signals for one name, plus the count of positives (a count, not a score). */
export function computeSignals(i: SignalInput, cfg: SignalConfig = SIGNAL_CONFIG): SignalSet {
  const s = {
    fundamentals: fundamentalsSignal(i, cfg),
    analyst: analystSignal(i, cfg),
    upside: upsideSignal(i, cfg),
    house: houseSignal(i),
    technicals: technicalsSignal(i, cfg),
    relStrength: relStrengthSignal(i, cfg),
  };
  const all = Object.values(s);
  return { ...s, positives: all.filter((x) => x.state === "positive").length, withData: all.filter((x) => x.state !== "pending").length };
}
