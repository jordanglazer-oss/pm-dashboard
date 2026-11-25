"use client";

/**
 * Portfolio Snapshot — the home page (Nov 24 2026 hackathon, Phase 1).
 * "What's our model up?" answered at a glance, in the look of the landscape
 * client-report slide (cream cards, navy + gold, serif headings).
 *
 *   mandate toggle · Top Holdings (as held / look-through) · asset
 *   allocation · sector exposure · performance by period
 *
 * FACTS ONLY and READ-ONLY. Everything comes from the same `useReportData`
 * hook the client report uses (positions × live prices, look-through fund
 * holdings), the recorded model series, and price history. It writes
 * nothing except the chosen mandate / tab / period into pm:ui-prefs.
 *
 * Deliberately NOT here (team decision): drawdown, upside / downside
 * capture, performance notes, and Core-vs-sleeve performance (that belongs
 * on the Performance page). The underlying logic is untouched.
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Playfair_Display } from "next/font/google";
import { useStocks } from "@/app/lib/StockContext";
import { useReportData, type ReportAllocationSlice } from "@/app/lib/useReportData";
import type { PimProfileType } from "@/app/lib/pim-types";
import { useBenchmarkHistory } from "@/app/lib/useBenchmarkHistory";
import { yahooClassShare } from "@/app/lib/yahoo-symbol";
import { tickerMatch } from "@/app/lib/rebalance";

const serif = Playfair_Display({ subsets: ["latin"], style: ["normal", "italic"], weight: ["500", "600", "700"], display: "swap" });
const SERIF = serif.style.fontFamily;

// The client report's palette (app/(dashboard)/client-report/page.tsx THEME).
const T = {
  navy: "#0A2A50",
  gold: "#B8893F",
  goldBand: "#DEB165",
  cream: "#FBF7EE",
  card: "#FFFDF8",
  sky: "#DCE7F2",
  ink: "#1C2B44",
  muted: "#5F6B7E",
  rule: "#E6DAC0",
  pos: "#2F7D5B",
  neg: "#B4423C",
} as const;
const SLICE: Record<ReportAllocationSlice["key"], string> = {
  coreEtfs: "#0A2A50", usEquity: "#3D6AA3", canadianEquity: "#B8893F", globalEquity: "#7FA3CC",
  fixedIncome: "#8A97AB", alternatives: "#DEB165", preferredShares: "#5B4A7A", cash: "#CFC4AE",
};
const SECTOR_RAMP = ["#0A2A50", "#1D4272", "#305A93", "#4673AE", "#6189C0", "#7FA0CF", "#9DB7DC", "#B9CCE6"];

const MANDATES: { id: PimProfileType; label: string }[] = [
  { id: "conservative", label: "Conservative" },
  { id: "balanced", label: "Balanced" },
  { id: "growth", label: "Growth" },
  { id: "allEquity", label: "All-Equity" },
];

type Period = "1d" | "1w" | "1m" | "3m" | "ytd" | "1y" | "si";
const PERIODS: { id: Period; label: string; long: string }[] = [
  { id: "1d", label: "1D", long: "1 day" },
  { id: "1w", label: "1W", long: "1 week" },
  { id: "1m", label: "1M", long: "1 month" },
  { id: "3m", label: "3M", long: "3 months" },
  { id: "ytd", label: "YTD", long: "year to date" },
  { id: "1y", label: "1Y", long: "1 year" },
  { id: "si", label: "Since inception", long: "since inception" },
];
const TRADING_DAYS: Partial<Record<Period, number>> = { "1d": 1, "1w": 5, "1m": 21, "3m": 63 };

type Pt = { date: string; value: number };
const ET = "America/New_York";
const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(ms));

/** Return (%) over a period on one series. `inception` = the model's first recorded day. Null when the series does not reach back far enough. */
function periodReturn(series: Pt[], p: Period, inception: string | null): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  let base: Pt | null = null;
  const n = TRADING_DAYS[p];
  if (n != null) base = series.length - 1 - n >= 0 ? series[series.length - 1 - n] : null;
  else {
    let start: string | null = null;
    if (p === "ytd") start = `${last.date.slice(0, 4)}-01-01`;
    else if (p === "1y") start = `${Number(last.date.slice(0, 4)) - 1}${last.date.slice(4)}`;
    else start = inception;
    if (!start) return null;
    // YTD is measured from the last close BEFORE the year began; 1Y and
    // since-inception from the last close on or before the start date.
    for (const pt of series) {
      if (p === "ytd" ? pt.date < start : pt.date <= start) base = pt;
      else break;
    }
    // The series must actually reach the start (within a week), or it is not that period.
    if (base && p !== "ytd" && Date.parse(start) - Date.parse(base.date) > 7 * 86_400_000) base = null;
  }
  if (!base || !(base.value > 0)) return null;
  return (last.value / base.value - 1) * 100;
}

const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const signed = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v === 0 ? T.ink : v > 0 ? T.pos : T.neg);
const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  // A plain date is shown as written; a timestamp is shown as its Eastern day.
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = plain ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: plain ? "UTC" : ET });
};

const isFund = (sym: string) => /^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(sym);
/** Price-history ticker for a model symbol. Mutual funds (FUNDSERV codes) go bare, and get their NAV history with distributions reinvested. */
const historyTicker = (sym: string) => (isFund(sym) ? sym.replace(/-T$/i, "") : sym.endsWith("-T") ? yahooClassShare(sym.replace(/-T$/, ".TO")) : sym);

/**
 * The last view, kept in THIS browser so the page paints at once on the next
 * visit and then updates itself. A convenience copy only: never a source of
 * record, never written to the server, always labelled with its time while it
 * is what is on screen. `id` says what the copy describes (a mandate, a list
 * of symbols); a copy for a different id is ignored.
 */
function useSaved<T>(slot: string, id: string, live: T | null): { value: T | null; savedAt: string | null } {
  const [kept, setKept] = useState<{ slot: string; id: string; at: string; value: T } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    // Read after mount (the server render has no browser storage).
    Promise.resolve().then(() => {
      if (!alive) return;
      try {
        const raw = window.localStorage.getItem(`snapshot.saved.${slot}`);
        const parsed = raw ? (JSON.parse(raw) as { id?: string; at?: string; value?: T }) : null;
        if (parsed && parsed.id === id && parsed.at && parsed.value != null) setKept({ slot, id, at: parsed.at, value: parsed.value });
      } catch {
        /* no saved copy — the page simply waits for live data */
      }
    });
    return () => {
      alive = false;
    };
  }, [slot, id]);
  useEffect(() => {
    if (live == null || !id) return;
    try {
      window.localStorage.setItem(`snapshot.saved.${slot}`, JSON.stringify({ id, at: new Date().toISOString(), value: live }));
    } catch {
      /* storage full or blocked — nothing depends on it */
    }
  }, [slot, id, live]);
  if (live != null) return { value: live, savedAt: null };
  return kept && kept.slot === slot && kept.id === id ? { value: kept.value, savedAt: kept.at } : { value: null, savedAt: null };
}

function useHoldingHistory(symbols: string[]): { series: Record<string, Pt[]>; at: string | null } {
  const key = symbols.join(",");
  const [state, setState] = useState<{ key: string; series: Record<string, Pt[]>; at: string | null }>({ key: "", series: {}, at: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const syms = key.split(",");
    fetch("/api/report-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: syms.map(historyTicker), range: "5y", funds: true }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { series?: Record<string, [number, number][]>; fetchedAt?: string } | null) => {
        if (!alive || !d?.series) return;
        const series: Record<string, Pt[]> = {};
        for (const s of syms) series[s] = (d.series[historyTicker(s)] ?? []).map(([ms, v]) => ({ date: dayOf(ms), value: v }));
        setState({ key, series, at: d.fetchedAt ?? new Date().toISOString() });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  const fresh = state.key === key && key ? state : null;
  const saved = useSaved("history", key, fresh);
  return saved.value ?? { series: {}, at: null };
}

/** /api/prices ticker for a model or look-through symbol (same mapping the Positioning tab uses). */
const priceTicker = (s: string) => {
  if (/^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(s)) return s.replace(/-T$/i, "");
  if (s.endsWith("-T")) return s.replace("-T", ".TO");
  if (s.endsWith(".U")) return s.replace(".U", "-U.TO");
  return s;
};

/** Today's move per symbol: latest price vs the prior close (the existing /api/prices POST). Null when either is missing. */
function useDayMoves(symbols: string[]): { moves: Record<string, number | null>; at: string | null } {
  const key = [...new Set(symbols)].sort().join(",");
  const [state, setState] = useState<{ moves: Record<string, number | null>; at: string | null }>({ moves: {}, at: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const syms = key.split(",");
    const load = () =>
      fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: syms.map(priceTicker) }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { prices?: Record<string, number | null>; previousCloses?: Record<string, number | null> } | null) => {
          if (!alive || !d?.prices) return;
          const moves: Record<string, number | null> = {};
          for (const s of syms) {
            const t = priceTicker(s);
            const px = d.prices[t] ?? d.prices[s];
            const pc = d.previousCloses?.[t] ?? d.previousCloses?.[s];
            moves[s] = typeof px === "number" && typeof pc === "number" && px > 0 && pc > 0 ? (px / pc - 1) * 100 : null;
          }
          setState({ moves, at: new Date().toISOString() });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);
  const saved = useSaved("day", key, state.at ? state : null);
  return saved.value ?? state;
}

type Sort<K extends string> = { key: K; dir: "asc" | "desc" };
/** Numbers: missing values always sort last, whichever direction. Text: A–Z. */
function compare(a: number | string | null | undefined, b: number | string | null | undefined, dir: "asc" | "desc"): number {
  if (typeof a === "string" || typeof b === "string") {
    const r = String(a ?? "").localeCompare(String(b ?? ""), "en", { sensitivity: "base" });
    return dir === "asc" ? r : -r;
  }
  const an = a == null || !Number.isFinite(a), bn = b == null || !Number.isFinite(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return dir === "asc" ? (a as number) - (b as number) : (b as number) - (a as number);
}

/** A clickable column heading. First click sorts high-to-low for numbers, A–Z for text; a second click reverses. */
function SortTh<K extends string>({ k, label, sort, onSort, right, text, title }: { k: K; label: string; sort: Sort<K>; onSort: (s: Sort<K>) => void; right?: boolean; text?: boolean; title?: string }) {
  const on = sort.key === k;
  const next: Sort<K> = on ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: text ? "asc" : "desc" };
  return (
    <th className={`${TH} ${right ? "text-right" : "text-left"}`} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(next)} title={title ?? `Sort by ${label.toLowerCase()}`} className="inline-flex items-center gap-1 uppercase tracking-[0.1em] hover:underline" style={{ color: on ? T.navy : T.muted }}>
        {label}
        <span aria-hidden="true" className="text-[10px]" style={{ opacity: on ? 1 : 0.35 }}>{on ? (sort.dir === "asc" ? "▲" : "▼") : "▼"}</span>
      </button>
    </th>
  );
}

// ── Pieces ──

function CardBox({ eyebrow, right, children, tone: bg = "cream" }: { eyebrow: string; right?: React.ReactNode; children: React.ReactNode; tone?: "cream" | "sky" }) {
  return (
    <section className="flex min-w-0 flex-col rounded-[10px] border" style={{ backgroundColor: bg === "sky" ? T.sky : T.card, borderColor: T.rule }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3" style={{ borderColor: T.rule }}>
        <span className="text-[12.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: T.navy }}>{eyebrow}</span>
        {right && <div className="ml-auto flex flex-wrap items-center gap-1.5">{right}</div>}
      </div>
      <div className="min-w-0 flex-1 px-5 py-4">{children}</div>
    </section>
  );
}

function Pill({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className="h-9 rounded-full border px-4 text-[14px] font-semibold transition-colors"
      style={on ? { backgroundColor: T.navy, borderColor: T.navy, color: "#fff" } : { backgroundColor: "#fff", borderColor: T.rule, color: T.ink }}
    >
      {children}
    </button>
  );
}

function Donut({ slices, size = 150 }: { slices: ReportAllocationSlice[]; size?: number }) {
  const rows = slices.filter((s) => s.weight > 0);
  const total = rows.reduce((a, s) => a + s.weight, 0);
  if (!rows.length || total <= 0) return <p className="text-[14px]" style={{ color: T.muted }}>No allocation data.</p>;
  const r = size / 2 - 2, c = size / 2, inner = r * 0.56;
  let acc = 0;
  const arc = (from: number, to: number) => {
    const a0 = (from / total) * 2 * Math.PI - Math.PI / 2, a1 = (to / total) * 2 * Math.PI - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
  };
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Asset allocation" className="shrink-0">
        {rows.length === 1 ? (
          <circle cx={c} cy={c} r={(r + inner) / 2} fill="none" stroke={SLICE[rows[0].key] ?? rows[0].color} strokeWidth={r - inner} />
        ) : (
          rows.map((s) => {
            const d = arc(acc, acc + s.weight);
            acc += s.weight;
            return <path key={s.key} d={d} fill={SLICE[s.key] ?? s.color} stroke={T.card} strokeWidth={1} />;
          })
        )}
      </svg>
      <ul className="flex min-w-[170px] flex-1 flex-col gap-1.5">
        {rows.map((s) => (
          <li key={s.key} className="flex items-center gap-2.5 text-[14.5px]" style={{ color: T.ink }}>
            <span className="inline-block h-3 w-3 shrink-0 rounded-[3px]" style={{ backgroundColor: SLICE[s.key] ?? s.color }} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="font-semibold tabular-nums">{pct(s.weight)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  if (!rows.length) return <p className="text-[14px]" style={{ color: T.muted }}>Sector data appears once fund look-through data is on file.</p>;
  const max = Math.max(...rows.map((r) => r.value), 0.01);
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r, i) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-[14.5px]" style={{ color: T.ink }}>
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="font-semibold tabular-nums">{pct(r.value)}</span>
          </div>
          <div className="mt-1 h-[7px] rounded-full" style={{ backgroundColor: "rgba(10,42,80,0.10)" }}>
            <div className="h-[7px] rounded-full" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: SECTOR_RAMP[Math.min(i, SECTOR_RAMP.length - 1)] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const TH = "px-2 py-2 text-[12px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap";
const TDc = "px-2 py-2.5 align-middle border-t";

export default function Snapshot() {
  const { pimModels, stocks, uiPrefs, setUiPref, loading: ctxLoading } = useStocks();
  const group = pimModels?.groups?.find((g) => g.id === "pim") ?? null;
  // Only the mandates that exist in the model data — nothing hard-coded.
  const mandates = useMemo(() => MANDATES.filter((m) => group?.profiles?.[m.id]), [group]);
  const stored = uiPrefs["snapshot.mandate"] as PimProfileType | undefined;
  const mandate: PimProfileType = mandates.some((m) => m.id === stored) ? (stored as PimProfileType) : mandates.some((m) => m.id === "balanced") ? "balanced" : (mandates[0]?.id ?? "balanced");
  const tab = uiPrefs["snapshot.holdingsTab"] === "lookthrough" ? "lookthrough" : "held";
  const period = (PERIODS.some((p) => p.id === uiPrefs["snapshot.period"]) ? uiPrefs["snapshot.period"] : "ytd") as Period;

  const report = useReportData("pim", mandate);
  const { loading, error, refetch } = report;
  // Live data when it has arrived; until then the last view saved in this browser.
  const savedReport = useSaved("report", ctxLoading ? "" : mandate, report.data?.profile === mandate ? report.data : null);
  const data = savedReport.value;
  const benchLive = useBenchmarkHistory();
  const bench = useSaved("bench", "all", benchLive && Object.keys(benchLive).length ? benchLive : null).value ?? benchLive;

  // Holdings as held: one line per position, funds and ETFs a single line each.
  const held = useMemo(() => {
    const rows = (data?.rawHoldings ?? []).filter((h) => h.weight > 0.005);
    const currencyOf = (sym: string) => group?.holdings.find((h) => tickerMatch(h.symbol, sym))?.currency ?? "CAD";
    return rows.map((h) => ({ ...h, currency: currencyOf(h.symbol) })).sort((a, b) => b.weight - a.weight);
  }, [data, group]);
  const symbols = useMemo(() => held.map((h) => h.symbol), [held]);
  const hist = useHoldingHistory(symbols);

  const modelSeries: Pt[] = useMemo(() => (data?.tracker?.history ?? []).map((h) => ({ date: h.date, value: h.value })), [data]);
  const inception = modelSeries[0]?.date ?? null;
  const perfRows = useMemo(() => {
    const b = (k: "sp500cad" | "tsx" | "sp500") => (bench?.[k] ?? []).map((p) => ({ date: p.date, value: p.value }));
    return [
      { label: `${data?.profileLabel ?? "Model"} model`, series: modelSeries, model: true },
      { label: "S&P 500 (C$)", series: b("sp500cad") },
      { label: "S&P 500 (US$)", series: b("sp500") },
      { label: "S&P/TSX", series: b("tsx") },
    ];
  }, [modelSeries, bench, data]);

  // As-of dates of the fund holdings behind the look-through (provider data is often a month old).
  const fundAsOf = useMemo(() => {
    const dates = held
      .map((h) => stocks.find((s) => tickerMatch(s.ticker, h.symbol))?.fundData)
      .map((f) => f?.holdingsLastUpdated ?? f?.lastUpdated)
      .filter((d): d is string => Boolean(d))
      .map((d) => d.slice(0, 10))
      .sort();
    return dates.length ? { oldest: dates[0], newest: dates[dates.length - 1], n: dates.length } : null;
  }, [held, stocks]);

  const xrayTop = useMemo(() => (data?.xray ?? []).slice(0, 20), [data]);
  const day = useDayMoves(useMemo(() => [...symbols, ...xrayTop.map((r) => r.symbol)], [symbols, xrayTop]));
  type HeldKey = "name" | "ticker" | "weight" | "ret" | "day";
  type XrayKey = "name" | "weight" | "direct" | "via" | "day";
  const [heldSort, setHeldSort] = useState<Sort<HeldKey>>({ key: "weight", dir: "desc" });
  const [xraySort, setXraySort] = useState<Sort<XrayKey>>({ key: "weight", dir: "desc" });
  const xray = useMemo(() => {
    const val = (r: (typeof xrayTop)[number]) => (xraySort.key === "name" ? r.name || r.symbol : xraySort.key === "direct" ? r.direct : xraySort.key === "via" ? r.lookThrough : xraySort.key === "day" ? day.moves[r.symbol] : r.weight);
    return [...xrayTop].sort((a, b) => compare(val(a), val(b), xraySort.dir));
  }, [xrayTop, xraySort, day.moves]);
  const periodLabel = PERIODS.find((p) => p.id === period)!.label;
  const periodLong = PERIODS.find((p) => p.id === period)!.long;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const holdingsTable = (ccy: "CAD" | "USD") => {
    const ret = (sym: string) => periodReturn(hist.series[sym] ?? [], period, inception);
    const dayMove = (sym: string) => {
      const sr = isFund(sym) ? (hist.series[sym] ?? []) : [];
      return sr.length >= 2 ? (sr[sr.length - 1].value / sr[sr.length - 2].value - 1) * 100 : day.moves[sym];
    };
    const val = (h: (typeof held)[number]) => (heldSort.key === "name" ? h.name || h.symbol : heldSort.key === "ticker" ? h.symbol : heldSort.key === "ret" ? ret(h.symbol) : heldSort.key === "day" ? dayMove(h.symbol) : h.weight);
    const rows = held.filter((h) => h.currency === ccy).sort((a, b) => compare(val(a), val(b), heldSort.dir));
    if (!rows.length) return null;
    const sub = rows.reduce((a, h) => a + h.weight, 0);
    return (
      <tbody key={ccy}>
        <tr>
          <td colSpan={5} className="px-2 pb-1 pt-3 text-[12px] font-bold uppercase tracking-[0.14em]" style={{ color: T.gold }}>
            {ccy === "CAD" ? "Canadian-dollar holdings" : "US-dollar holdings"} <span className="font-semibold normal-case tracking-normal" style={{ color: T.muted }}>· {pct(sub)} of the portfolio</span>
          </td>
        </tr>
        {rows.map((h) => {
          const r = ret(h.symbol);
          // A mutual fund has no intraday price: its "today" is the latest NAV vs the one before, dated.
          const navSeries = isFund(h.symbol) ? (hist.series[h.symbol] ?? []) : [];
          const nav = navSeries.length >= 2 ? { move: (navSeries[navSeries.length - 1].value / navSeries[navSeries.length - 2].value - 1) * 100, date: navSeries[navSeries.length - 1].date } : null;
          const d1 = nav ? nav.move : day.moves[h.symbol];
          return (
            <tr key={h.symbol}>
              <td className={TDc} style={{ borderColor: T.rule }}>
                <Link href={`/stock/${encodeURIComponent(h.symbol.toLowerCase())}`} className="text-[15px] font-medium hover:underline" style={{ color: T.ink }}>{h.name || h.symbol}</Link>
              </td>
              <td className={`${TDc} whitespace-nowrap text-[13px] tabular-nums`} style={{ borderColor: T.rule, color: T.muted }}>{h.symbol}</td>
              <td className={`${TDc} text-right text-[15px] font-semibold tabular-nums`} style={{ borderColor: T.rule, color: T.navy }}>{pct(h.weight)}</td>
              <td className={`${TDc} text-right text-[15px] tabular-nums`} style={{ borderColor: T.rule, color: tone(d1) }}>
                {signed(d1)}
                {nav && <div className="text-[11.5px] font-normal" style={{ color: T.muted }} title="A mutual fund is priced once a day; this is its latest NAV against the one before">NAV {fmtDay(nav.date).replace(/, \d{4}$/, "")}</div>}
              </td>
              <td className={`${TDc} text-right text-[15px] tabular-nums`} style={{ borderColor: T.rule, color: tone(r) }}>{signed(r)}</td>
            </tr>
          );
        })}
      </tbody>
    );
  };

  return (
    <main className="min-h-screen pb-16" style={{ backgroundColor: T.cream, color: T.ink }}>
      <div className="mx-auto flex max-w-[1320px] flex-col gap-4 px-1 pt-3">
        {/* Masthead */}
        <header className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b pb-4" style={{ borderColor: T.rule }}>
          <div className="min-w-0">
            <h1 className="text-[34px] leading-tight" style={{ fontFamily: SERIF, color: T.navy, fontWeight: 600 }}>
              {data?.profileLabel ?? MANDATES.find((m) => m.id === mandate)?.label} Model, <span style={{ color: T.gold, fontStyle: "italic" }}>Portfolio Snapshot</span>
            </h1>
            <div className="mt-1 text-[13px] uppercase tracking-[0.18em]" style={{ color: T.muted }}>{today}</div>
            {savedReport.savedAt && (
              <div className="mt-1 text-[13px] font-semibold" style={{ color: T.gold }}>
                Saved view from {new Date(savedReport.savedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {error ? "live update failed" : "updating…"}
              </div>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2" role="group" aria-label="Mandate">
            {mandates.map((m) => (
              <Pill key={m.id} on={m.id === mandate} onClick={() => setUiPref("snapshot.mandate", m.id)}>{m.label}</Pill>
            ))}
          </div>
        </header>

        {error && (
          <div className="rounded-[10px] border px-4 py-3 text-[14.5px]" style={{ borderColor: T.neg, color: T.neg, backgroundColor: "#fff" }}>
            {error}. <button type="button" onClick={() => refetch()} className="font-semibold underline">Try again</button>
          </div>
        )}

        {data?.unpriced && data.unpriced.length > 0 && (
          <div className="rounded-[10px] border px-4 py-3 text-[14.5px]" style={{ borderColor: T.neg, color: T.neg, backgroundColor: "#fff" }}>
            Not shown, no price available: {data.unpriced.join(", ")}. The other weights are overstated until it returns. <button type="button" onClick={() => refetch()} className="font-semibold underline">Try again</button>
          </div>
        )}
        {data?.stalePriced && data.stalePriced.length > 0 && (
          <div className="text-[13px]" style={{ color: T.muted }}>
            Weighted at the last price on hand (live price did not arrive): {data.stalePriced.join(", ")}.
          </div>
        )}

        {/* Performance by period */}
        <CardBox eyebrow="Performance by period" right={<span className="text-[13px]" style={{ color: T.muted }}>recorded daily values, close to close · through {fmtDay(modelSeries[modelSeries.length - 1]?.date)}</span>}>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr style={{ color: T.muted }}>
                  <th className={`${TH} text-left`} />
                  {PERIODS.map((p) => (
                    <th key={p.id} className={`${TH} text-right`}>
                      <button type="button" onClick={() => setUiPref("snapshot.period", p.id)} title={`Show holdings returns for ${p.long}`} className="rounded px-1.5 py-0.5 uppercase tracking-[0.1em]" style={p.id === period ? { backgroundColor: T.navy, color: "#fff" } : undefined}>
                        {p.label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {perfRows.map((row) => (
                  <tr key={row.label}>
                    <td className={`${TDc} whitespace-nowrap ${row.model ? "text-[17px] font-semibold" : "text-[15px]"}`} style={{ borderColor: T.rule, color: row.model ? T.navy : T.ink, fontFamily: row.model ? SERIF : undefined }}>{row.label}</td>
                    {PERIODS.map((p) => {
                      const v = periodReturn(row.series, p.id, inception);
                      return (
                        <td key={p.id} className={`${TDc} text-right tabular-nums ${row.model ? "text-[19px] font-semibold" : "text-[15px]"}`} style={{ borderColor: T.rule, color: tone(v), backgroundColor: p.id === period ? "rgba(10,42,80,0.04)" : undefined }}>
                          {signed(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12.5px]" style={{ color: T.muted }}>
            {inception ? `Since inception = from ${fmtDay(inception)}, the model's first recorded day; the indices are measured from the same day.` : "No recorded model history yet."} Click a period to show holdings returns for it.
          </p>
        </CardBox>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* Top holdings */}
          <CardBox
            eyebrow="Top holdings"
            right={
              <>
                <Pill on={tab === "held"} onClick={() => setUiPref("snapshot.holdingsTab", "held")}>Portfolio holdings</Pill>
                <Pill on={tab === "lookthrough"} onClick={() => setUiPref("snapshot.holdingsTab", "lookthrough")}>Look-through</Pill>
              </>
            }
          >
            {(loading || ctxLoading) && !data ? (
              <p className="animate-pulse py-6 text-[14.5px]" style={{ color: T.muted }}>Loading live positions…</p>
            ) : tab === "held" ? (
              <>
                <div className="-mx-2 overflow-x-auto">
                  <table className="w-full min-w-[600px] border-collapse">
                    <thead>
                      <tr style={{ color: T.muted }}>
                        <SortTh k="name" label="Holding" sort={heldSort} onSort={setHeldSort} text />
                        <SortTh k="ticker" label="Ticker" sort={heldSort} onSort={setHeldSort} text />
                        <SortTh k="weight" label="% of portfolio" sort={heldSort} onSort={setHeldSort} right />
                        <SortTh k="day" label="Today" sort={heldSort} onSort={setHeldSort} right title="Sort by today's move (latest price vs the prior close)" />
                        <SortTh k="ret" label={periodLabel} sort={heldSort} onSort={setHeldSort} right title={`Sort by return over ${periodLong}`} />
                      </tr>
                    </thead>
                    {holdingsTable("CAD")}
                    {holdingsTable("USD")}
                    {data && data.totals.cash > 0.005 && (
                      <tbody>
                        <tr>
                          <td className={TDc} style={{ borderColor: T.rule }} colSpan={2}><span className="text-[15px] font-medium">Cash</span></td>
                          <td className={`${TDc} text-right text-[15px] font-semibold tabular-nums`} style={{ borderColor: T.rule, color: T.navy }}>{pct(data.totals.cash)}</td>
                          <td className={`${TDc} text-right`} style={{ borderColor: T.rule, color: T.muted }}>—</td>
                          <td className={`${TDc} text-right`} style={{ borderColor: T.rule, color: T.muted }}>—</td>
                        </tr>
                      </tbody>
                    )}
                  </table>
                </div>
                <p className="mt-2 text-[12.5px]" style={{ color: T.muted }}>
                  One line per position as held; funds and ETFs are a single line. Weights are {data?.weightsSource === "live" ? "live (positions × latest prices)" : "the model targets (no positions on file)"}. Click a heading to sort (within each currency group). Today = latest price vs the prior close. {periodLabel} = total return over {periodLong}. Both are in each holding&apos;s own currency, from Yahoo Finance{hist.at ? ` (${fmtDay(hist.at)})` : ""}. Mutual funds use their daily NAV with distributions reinvested (Globe and Mail fund data), so their &ldquo;today&rdquo; is the latest NAV, dated. “—” = no price history, or not held that long.
                </p>
              </>
            ) : (
              <>
                <div className="-mx-2 overflow-x-auto">
                  <table className="w-full min-w-[600px] border-collapse">
                    <thead>
                      <tr style={{ color: T.muted }}>
                        <th className={`${TH} text-left`}>#</th>
                        <SortTh k="name" label="Underlying stock" sort={xraySort} onSort={setXraySort} text />
                        <SortTh k="weight" label="% of portfolio" sort={xraySort} onSort={setXraySort} right />
                        <SortTh k="direct" label="Direct" sort={xraySort} onSort={setXraySort} right title="Sort by the weight we hold directly" />
                        <SortTh k="via" label="Via funds" sort={xraySort} onSort={setXraySort} right title="Sort by the weight held through funds and ETFs" />
                        <SortTh k="day" label="Today" sort={xraySort} onSort={setXraySort} right title="Sort by today's move (latest price vs the prior close)" />
                      </tr>
                    </thead>
                    <tbody>
                      {xray.map((r, i) => {
                        const own = r.direct > 0.0005;
                        return (
                          <tr key={r.symbol} style={own ? { backgroundColor: "rgba(184,137,63,0.12)" } : undefined}>
                            <td className={`${TDc} text-[13px] tabular-nums`} style={{ borderColor: T.rule, color: T.muted }}>{i + 1}</td>
                            <td className={TDc} style={{ borderColor: T.rule }}>
                              {/* The pill never breaks across lines: it wraps as ONE piece under a long name. */}
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-[15px] font-medium">{r.name || r.symbol}</span>
                                <span className="text-[13px] tabular-nums" style={{ color: T.muted }}>{r.symbol}</span>
                                {own && <span className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold leading-tight" style={{ backgroundColor: T.gold, color: "#fff" }}>Owned directly</span>}
                              </div>
                            </td>
                            <td className={`${TDc} text-right text-[15px] font-semibold tabular-nums`} style={{ borderColor: T.rule, color: T.navy }}>{pct(r.weight, 2)}</td>
                            <td className={`${TDc} text-right text-[14px] tabular-nums`} style={{ borderColor: T.rule, color: own ? T.ink : T.muted }}>{pct(r.direct, 2)}</td>
                            <td className={`${TDc} text-right text-[14px] tabular-nums`} style={{ borderColor: T.rule, color: T.muted }}>{pct(r.lookThrough, 2)}</td>
                            <td className={`${TDc} text-right text-[15px] tabular-nums`} style={{ borderColor: T.rule, color: tone(day.moves[r.symbol]) }}>{signed(day.moves[r.symbol])}</td>
                          </tr>
                        );
                      })}
                      {!xray.length && (
                        <tr><td colSpan={6} className="py-6 text-[14.5px]" style={{ color: T.muted }}>No look-through data yet. It fills in once fund holdings are on file.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[12.5px]" style={{ color: T.muted }}>
                  The 20 largest underlying stocks across the whole mandate, with funds and ETFs broken into their holdings. Highlighted = we also own it directly. Click a heading to sort; Today = latest price vs the prior close, in the stock&apos;s own currency.{" "}
                  {fundAsOf ? <span style={{ color: T.ink }}>Fund holdings data last fetched {fundAsOf.oldest === fundAsOf.newest ? fmtDay(fundAsOf.oldest) : `between ${fmtDay(fundAsOf.oldest)} and ${fmtDay(fundAsOf.newest)}`} ({fundAsOf.n} funds); the providers&apos; own lists are often a month old.</span> : "No date is on file for the fund holdings data."}
                </p>
              </>
            )}
          </CardBox>

          <div className="flex min-w-0 flex-col gap-4">
            <CardBox eyebrow="Asset allocation" right={data ? <span className="text-[13px]" style={{ color: T.muted }}>{data.weightsSource === "live" ? "live" : "model targets"}</span> : null}>
              {data ? (
                <>
                  <Donut slices={data.allocation} />
                  <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t pt-3" style={{ borderColor: T.rule }}>
                    {[["CAD", data.totals.cad], ["USD", data.totals.usd]].map(([k, v]) => (
                      <div key={k as string}>
                        <div className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: T.muted }}>{k}</div>
                        <div className="text-[22px] font-semibold tabular-nums" style={{ color: T.navy, fontFamily: SERIF }}>{pct(v as number)}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="animate-pulse py-6 text-[14.5px]" style={{ color: T.muted }}>Loading…</p>
              )}
            </CardBox>
            <CardBox eyebrow="Sector exposure" tone="sky" right={<span className="text-[13px]" style={{ color: T.muted }}>equity, look-through</span>}>
              {data ? <Bars rows={data.sectors.slice(0, 9).map((s) => ({ label: s.sector, value: s.weight }))} /> : <p className="animate-pulse py-6 text-[14.5px]" style={{ color: T.muted }}>Loading…</p>}
            </CardBox>
          </div>
        </div>

        <p className="text-[12.5px]" style={{ color: T.muted }}>
          Internal use only. Positions and prices loaded {data ? new Date(data.generatedAt).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"} ET.{" "}
          <Link href="/holdings" className="font-semibold underline" style={{ color: T.navy }}>Full holdings table</Link> · <Link href="/aa-performance" className="font-semibold underline" style={{ color: T.navy }}>Performance detail</Link> · <Link href={`/client-report?group=pim&profile=${mandate}&layout=landscape`} className="font-semibold underline" style={{ color: T.navy }}>Client report</Link>
        </p>
      </div>
    </main>
  );
}
