/**
 * Market FACTS for the redesign pages — the inputs the regime engine reads,
 * shown as plain facts: value, prior, change, context, as-of date, source.
 *
 * Deliberately carries NO direction, vote, label or score: the `direction`
 * fields on the regime read-outs are never read here. Pure — no fetch.
 */

import type { ForwardLookingBundle, ForwardPointBundle, MarketData } from "@/app/lib/types";
import type { MarketRegimeData, RatioReadout } from "@/app/lib/market-regime";

export type FactGroup = "tactical" | "cyclical" | "structural";

export const GROUPS: { id: FactGroup; label: string; horizon: string }[] = [
  { id: "tactical", label: "Tactical", horizon: "days to weeks" },
  { id: "cyclical", label: "Cyclical", horizon: "months" },
  { id: "structural", label: "Structural", horizon: "a year or more" },
];

export type Fact = {
  id: string;
  group: FactGroup;
  label: string;
  /** Formatted current value; "—" when missing. */
  value: string;
  prior: string;
  /** Formatted change vs prior; "" when not available. */
  change: string;
  /** Sign of the change, for colouring only (never a judgment). */
  changeNum: number | null;
  /** What the prior is ("1 week ago", "20 trading days ago"). */
  priorLabel: string;
  /** Historical context: an average, a range, a scale. */
  context: string;
  asOf: string | null;
  source: string;
  /** Typed in by hand (so it can go stale). */
  manual: boolean;
  missing: boolean;
  /** On the short "key facts" list for the main screen. */
  key?: boolean;
};

const n = (v: number | null | undefined, d: number, unit = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}${unit}`);
const s = (v: number | null | undefined, d: number, unit = "") => (v == null || !Number.isFinite(v) ? "" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}${unit}`);

type PtOpts = { id: string; group: FactGroup; label: string; digits: number; unit?: string; changeUnit?: string; priorLabel?: string; context?: string; manual?: boolean; key?: boolean; source?: string };

function fromPoint(p: ForwardPointBundle | undefined, o: PtOpts): Fact {
  const value = p?.value ?? null;
  const prev = p?.previous ?? null;
  const diff = value != null && prev != null ? value - prev : null;
  const t = p?.trend;
  const range = t && Number.isFinite(t.rangeLow) && Number.isFinite(t.rangeHigh) ? `Recent range ${n(t.rangeLow, o.digits)}–${n(t.rangeHigh, o.digits)}${o.unit ?? ""}` : "";
  return {
    id: o.id,
    group: o.group,
    label: o.label,
    value: n(value, o.digits, o.unit),
    prior: n(prev, o.digits, o.unit),
    change: s(diff, o.digits, o.changeUnit ?? o.unit ?? ""),
    changeNum: diff,
    priorLabel: o.priorLabel ?? "1 week ago",
    context: [o.context, range].filter(Boolean).join(" · "),
    asOf: p?.asOf ?? null,
    source: o.source ?? p?.sourceLabel ?? "—",
    manual: Boolean(o.manual),
    missing: value == null,
    key: o.key,
  };
}

function fromRatio(r: RatioReadout | null | undefined, o: { id: string; label: string; what: string; asOf: string | null; key?: boolean }): Fact {
  return {
    id: o.id,
    group: "cyclical",
    label: o.label,
    value: r ? `${s(r.change20dPct, 1, "%")}` : "—",
    prior: "—",
    change: "",
    changeNum: r ? r.change20dPct : null,
    priorLabel: "",
    context: r ? `${o.what}, change over 20 trading days · ratio is ${Math.abs(r.distancePct).toFixed(1)}% ${r.distancePct >= 0 ? "above" : "below"} its 50-day average` : o.what,
    asOf: o.asOf,
    source: "Yahoo Finance (ETF prices)",
    manual: false,
    missing: !r,
    key: o.key,
  };
}

export function buildFacts(f: ForwardLookingBundle | null, r: MarketRegimeData | null): Fact[] {
  const out: Fact[] = [];
  const rAt = r?.computedAt ?? null;

  // ── Tactical ──
  out.push(fromPoint(f?.vixWeek, { id: "vix", group: "tactical", label: "VIX (stock-market volatility)", digits: 1, context: "Long-run average about 19.5", key: true }));
  out.push(fromPoint(f?.fearGreed, { id: "fearGreed", group: "tactical", label: "CNN Fear & Greed", digits: 0, context: "0 = extreme fear, 100 = extreme greed", key: true }));
  out.push(fromPoint(f?.aaiiBullBear, { id: "aaii", group: "tactical", label: "AAII bulls minus bears", digits: 1, unit: " pts", priorLabel: "prior survey", context: "Weekly survey · long-run averages: bulls 37.5%, bears 31%" }));
  out.push(fromPoint(f?.putCallRatio, { id: "putCall", group: "tactical", label: "Put/call ratio (total)", digits: 2, priorLabel: "prior entry", context: "Above 1.0 = more puts than calls", manual: true }));
  out.push(fromPoint(f?.spOscillator, { id: "oscillator", group: "tactical", label: "S&P Oscillator (MarketEdge)", digits: 1, priorLabel: "prior entry", context: "Below −4 is called oversold, above +4 overbought", manual: true }));
  out.push(fromPoint(f?.breadth50Wk, { id: "breadth50", group: "tactical", label: "% of S&P 500 above 50-day average", digits: 1, unit: "%", changeUnit: " pts", manual: true, key: true }));
  out.push(fromPoint(f?.newHighsWk, { id: "newHighs", group: "tactical", label: "NYSE new 52-week highs", digits: 0, manual: true }));
  out.push(fromPoint(f?.newLowsWk, { id: "newLows", group: "tactical", label: "NYSE new 52-week lows", digits: 0, manual: true }));
  out.push(fromPoint(f?.moveWeek, { id: "move", group: "tactical", label: "MOVE (bond-market volatility)", digits: 1 }));

  // ── Cyclical ──
  out.push(fromPoint(f?.breadth200Wk, { id: "breadth200", group: "cyclical", label: "% of S&P 500 above 200-day average", digits: 1, unit: "%", changeUnit: " pts", manual: true, key: true }));
  out.push(fromPoint(f?.hyOasTrend, { id: "hyOas", group: "cyclical", label: "High-yield credit spread", digits: 0, unit: " bps", context: "Extra yield over Treasuries", key: true }));
  out.push(fromPoint(f?.igOasTrend, { id: "igOas", group: "cyclical", label: "Investment-grade credit spread", digits: 0, unit: " bps" }));
  out.push(fromRatio(r?.sectorRatios?.xlkXlu, { id: "techUtil", label: "Technology vs utilities", what: "XLK ÷ XLU", asOf: rAt, key: true }));
  out.push(fromRatio(r?.sectorRatios?.xlyXlp, { id: "discStaples", label: "Discretionary vs staples", what: "XLY ÷ XLP", asOf: rAt }));
  out.push(fromRatio(r?.breadth, { id: "equalWeight", label: "Equal-weight vs cap-weight S&P 500", what: "RSP ÷ SPY", asOf: rAt }));
  out.push(fromPoint(f?.curve10y2y, { id: "curve", group: "cyclical", label: "Yield curve (10-year minus 2-year)", digits: 0, unit: " bps", context: "Below 0 = inverted" }));
  out.push(fromPoint(f?.yield10y, { id: "y10", group: "cyclical", label: "10-year Treasury yield", digits: 2, unit: "%", changeUnit: " pts" }));
  const pmi = r?.ismPmi;
  out.push({
    id: "pmi", group: "cyclical", label: "ISM manufacturing PMI",
    value: n(pmi?.level, 1), prior: n(pmi?.prior, 1), change: s(pmi?.change1mAbs, 1), changeNum: pmi?.change1mAbs ?? null,
    priorLabel: "prior month", context: "50 = line between expansion and contraction",
    asOf: pmi?.asOf ?? null, source: "FRED", manual: false, missing: !pmi,
  });

  // ── Structural ──
  const t = r?.spx10m;
  out.push({
    id: "spx10m", group: "structural", label: "S&P 500 vs its 10-month average",
    value: t ? `${s(t.distancePct, 1, "%")}` : "—", prior: "—", change: "", changeNum: t ? t.distancePct : null, priorLabel: "",
    context: t ? `Index ${n(t.price, 0)} · 10-month average ${n(t.ma, 0)} · the trend line Mark Newton watches` : "The trend line Mark Newton watches",
    asOf: rAt, source: "Yahoo Finance (computed)", manual: false, missing: !t, key: true,
  });
  out.push(fromPoint(f?.spyForwardPE, { id: "fwdPE", group: "structural", label: "S&P 500 forward P/E", digits: 1, unit: "×", priorLabel: "prior reading", key: true }));
  out.push(fromPoint(f?.spyTrailingPE, { id: "trlPE", group: "structural", label: "S&P 500 trailing P/E", digits: 1, unit: "×", priorLabel: "prior reading" }));
  out.push(fromPoint(f?.spxYtd, { id: "spxYtd", group: "structural", label: "S&P 500 year to date", digits: 1, unit: "%", changeUnit: " pts", priorLabel: "prior reading" }));

  return out;
}

// ── Manual inputs: what is typed in by hand, and how fresh it is ──

export type ManualField = {
  id: string;
  label: string;
  /** Where to find it and exactly what to type. */
  how: string;
  url?: string;
  /** Path into pm:market: a top-level key, or a breadthOverride field. */
  store: "top" | "breadth";
  key: string;
  step?: string;
  placeholder?: string;
};

export const MANUAL_FIELDS: ManualField[] = [
  { id: "above200", label: "% of S&P 500 above 200-day average", how: "Barchart $S5TH — type the last value, e.g. 51.4", url: "https://www.barchart.com/stocks/quotes/$S5TH", store: "breadth", key: "above200", placeholder: "51.4" },
  { id: "above50", label: "% of S&P 500 above 50-day average", how: "Barchart $S5FI — type the last value", url: "https://www.barchart.com/stocks/quotes/$S5FI", store: "breadth", key: "above50", placeholder: "44.0" },
  { id: "broadAbove200", label: "% of broad market above 200-day average", how: "Barchart Market Momentum — the 200-day row", url: "https://www.barchart.com/stocks/momentum", store: "breadth", key: "broadAbove200", placeholder: "48.2" },
  { id: "broadAbove50", label: "% of broad market above 50-day average", how: "Barchart Market Momentum — the 50-day row", url: "https://www.barchart.com/stocks/momentum", store: "breadth", key: "broadAbove50", placeholder: "41.0" },
  { id: "newHighs", label: "NYSE new 52-week highs", how: "Barchart $MAHN — today's count", url: "https://www.barchart.com/stocks/quotes/$MAHN", store: "breadth", key: "newHighs", step: "1", placeholder: "85" },
  { id: "newLows", label: "NYSE new 52-week lows", how: "Barchart $MALN — today's count", url: "https://www.barchart.com/stocks/quotes/$MALN", store: "breadth", key: "newLows", step: "1", placeholder: "40" },
  { id: "upVolume", label: "NYSE advancing volume", how: "Barchart market overview — up volume (same unit as down volume)", url: "https://www.barchart.com/stocks/momentum", store: "breadth", key: "upVolume", placeholder: "2.1" },
  { id: "downVolume", label: "NYSE declining volume", how: "Barchart market overview — down volume (same unit as up volume)", url: "https://www.barchart.com/stocks/momentum", store: "breadth", key: "downVolume", placeholder: "1.4" },
  { id: "putCall", label: "Put/call ratio (total)", how: "CBOE daily market statistics — Total Put/Call Ratio", url: "https://www.cboe.com/us/options/market_statistics/daily/", store: "top", key: "putCall", step: "0.01", placeholder: "0.92" },
  { id: "spOscillator", label: "S&P Oscillator", how: "MarketEdge (login needed) — the S&P Short Range Oscillator", store: "top", key: "spOscillator", step: "0.1", placeholder: "-2.1" },
];

export type ManualStatus = { field: ManualField; value: number | null; editedAt: string | null; today: boolean };

/** Current value + last-edit stamp per manual field. `stamps` = pm:market.manualEditedAt (top-level fields). */
export function manualStatus(m: MarketData | null | undefined, today: string): ManualStatus[] {
  const bo = (m?.breadthOverride ?? {}) as Record<string, unknown> & { editedAt?: Record<string, string | undefined> };
  const top = ((m as unknown as { manualEditedAt?: Record<string, string | undefined> } | null)?.manualEditedAt ?? {}) as Record<string, string | undefined>;
  return MANUAL_FIELDS.map((field) => {
    const raw = field.store === "breadth" ? bo[field.key] : (m as unknown as Record<string, unknown> | null)?.[field.key];
    const editedAt = (field.store === "breadth" ? bo.editedAt?.[field.key] : top[field.key]) ?? null;
    const day = editedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(editedAt)) : null;
    return { field, value: typeof raw === "number" && Number.isFinite(raw) ? raw : null, editedAt, today: day === today };
  });
}
