"use client";

/**
 * Brief → Performance (Nov 2026). Every PIM book — the equity sleeves (Core,
 * Thematic, Alpha, Stocks) and the client models (Conservative → All-Equity)
 * — plus the S&P 500 and TSX, by period, each read against Core.
 *
 * LIVE: history comes from pm:pim-performance (re-read every 5 min, so the
 * daily close lands without a reload); today's move comes from the same
 * live-today hook the Positioning / Performance tiles use (re-priced every
 * minute while the market is open) and is compounded onto the last close.
 * The brief itself is never regenerated for this. Read-only.
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkline } from "@/app/components/Sparkline";
import { useLiveTodayReturn } from "@/app/lib/useLiveTodayReturn";
import { getTodayET, isMarketOpenOrAfterET } from "@/app/lib/market-hours";
import { normalizeSeries, periodReturns, returnSince, type ValuePoint } from "@/app/lib/daily-summary/periods";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { PimPerformanceData, PimProfileType } from "@/app/lib/pim-types";

type ColKey = "1d" | "1w" | "1m" | "qtd" | "ytd" | "range";
const BASE_COLS: { key: ColKey; label: string }[] = [
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
  { key: "1m", label: "1M" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
];
type Range = { from: string; to: string };

const SLEEVES: { profile: PimProfileType; label: string; note: string }[] = [
  { profile: "core", label: "Core", note: "index ETFs" },
  { profile: "thematic", label: "Managed Alpha", note: "funds" },
  { profile: "stocks", label: "Individual Stocks", note: "picks only" },
  { profile: "alpha", label: "Total Alpha", note: "managed + stocks" },
];
const CLIENT: { profile: PimProfileType; label: string; note: string }[] = [
  { profile: "conservative", label: "Conservative", note: "" },
  { profile: "balanced", label: "Balanced", note: "" },
  { profile: "growth", label: "Growth", note: "" },
  { profile: "allEquity", label: "All-Equity", note: "" },
];

type Returns = Record<ColKey, number | null>;
type Computed = { returns: Returns; series: ValuePoint[]; first: string | null; live: boolean };

const isTradingHours = () => {
  if (!isMarketOpenOrAfterET()) return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date()));
  return h < 17; // keep re-pricing until shortly after the close
};

function quarterStart(today: string): string {
  const m = Number(today.slice(5, 7));
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return `${today.slice(0, 4)}-${String(q).padStart(2, "0")}-01`;
}

/** Return from the close BEFORE `from` to the last close on/before `to`; null when the series starts after `from`. */
function rangeReturn(series: ValuePoint[], r: Range | null): number | null {
  if (!r || !r.from || series.length < 2) return null;
  const to = r.to || getTodayET();
  const base = [...series].reverse().find((p) => p.date < r.from);
  const end = [...series].reverse().find((p) => p.date <= to);
  if (!base || !end || end.date <= base.date || !(base.value > 0)) return null;
  return parseFloat(((end.value / base.value - 1) * 100).toFixed(2));
}

/** Period returns on a value series, with today's live move compounded on when the series hasn't closed today yet. */
function compute(raw: { date: string; value: number }[], live: number | null, range: Range | null): Computed {
  const today = getTodayET();
  let series = normalizeSeries(raw);
  let isLive = false;
  if (live != null && series.length > 0 && series[series.length - 1].date < today) {
    series = [...series, { date: today, value: series[series.length - 1].value * (1 + live / 100) }];
    isLive = true;
  }
  const empty: Returns = { "1d": null, "1w": null, "1m": null, qtd: null, ytd: null, range: null };
  if (series.length < 2) return { returns: empty, series, first: series[0]?.date ?? null, live: isLive };
  const p = periodReturns(series);
  const qs = quarterStart(today);
  const dayBefore = (d: string) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  };
  return {
    returns: {
      "1d": p["1d"],
      "1w": p["1w"],
      "1m": p["1m"],
      qtd: series[0].date < qs ? returnSince(series, dayBefore(qs)) : null,
      ytd: p.ytd,
      range: rangeReturn(series, range),
    },
    series,
    first: series[0].date,
    live: isLive,
  };
}

/** Points for the trend line: the custom range when one is set, else YTD. */
function trendSlice(series: ValuePoint[], range: Range | null): ValuePoint[] {
  if (series.length < 2) return [];
  const from = range?.from || `${getTodayET().slice(0, 4)}-01-01`;
  const to = range?.from ? range.to || getTodayET() : getTodayET();
  const idx = series.findIndex((p) => p.date >= from);
  const start = idx <= 0 ? 0 : idx - 1;
  return series.slice(start).filter((p) => p.date <= to);
}

const fmt = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const tone = (v: number | null) => (v == null ? "text-ink-faint" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

type Row = { key: string; label: string; note: string; c: Computed; market?: boolean };

/** One hook call per book (hooks can't run in a loop over a dynamic list). */
function useBookRows(perf: PimPerformanceData | null, tick: number, range: Range | null) {
  const hist = (p: PimProfileType) => perf?.models.find((m) => m.groupId === "pim" && m.profile === p)?.history ?? [];
  const core = useLiveTodayReturn("pim", "core");
  const thematic = useLiveTodayReturn("pim", "thematic");
  const alpha = useLiveTodayReturn("pim", "alpha");
  const stocks = useLiveTodayReturn("pim", "stocks");
  const conservative = useLiveTodayReturn("pim", "conservative");
  const balanced = useLiveTodayReturn("pim", "balanced");
  const growth = useLiveTodayReturn("pim", "growth");
  const allEquity = useLiveTodayReturn("pim", "allEquity");
  const live: Record<string, ReturnType<typeof useLiveTodayReturn>> = { core, thematic, alpha, stocks, conservative, balanced, growth, allEquity };

  // Re-price every minute during market hours (one round-trip per book, shared with every other consumer).
  useEffect(() => {
    if (tick === 0 || !isTradingHours()) return;
    for (const l of Object.values(live)) l.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const build = (list: typeof SLEEVES): Row[] =>
    list
      .map((b) => ({ key: b.profile, label: b.label, note: b.note, c: compute(hist(b.profile), live[b.profile].value, range) }))
      .filter((r) => r.c.series.length > 0 || r.key === "thematic" || r.key === "stocks");
  return { sleeves: build(SLEEVES), client: build(CLIENT).filter((r) => r.c.series.length > 0) };
}

/** S&P 500 / TSX: period returns from the summary, today's move live from /api/prices. */
function useMarketRows(s: DailySummary, tick: number): Row[] {
  const [quotes, setQuotes] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (!isTradingHours()) return;
    let alive = true;
    fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: ["^GSPC", "^GSPTSE"] }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { prices?: Record<string, number | null>; previousCloses?: Record<string, number | null> } | null) => {
        if (!alive || !d) return;
        const pct = (t: string) => {
          const p = d.prices?.[t];
          const c = d.previousCloses?.[t];
          return p && c && c > 0 ? ((p - c) / c) * 100 : null;
        };
        setQuotes({ sp500: pct("^GSPC"), tsx: pct("^GSPTSE") });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);

  const today = getTodayET();
  return (s.performance?.benchmarks ?? [])
    .filter((b) => b.key === "sp500" || b.key === "tsx")
    .map((b) => {
      const liveD = b.asOf && b.asOf < today ? quotes[b.key] ?? null : null;
      const comp = (v: number | null) => (v == null ? null : liveD == null ? v : parseFloat((((1 + v / 100) * (1 + liveD / 100) - 1) * 100).toFixed(2)));
      const returns: Returns = {
        "1d": liveD ?? b.returns["1d"],
        "1w": comp(b.returns["1w"]),
        "1m": comp(b.returns["1m"]),
        qtd: null,
        ytd: comp(b.returns.ytd),
        range: null,
      };
      return { key: b.key, label: b.key === "sp500" ? "S&P 500" : "S&P/TSX", note: b.key === "sp500" ? "USD" : "CAD", market: true, c: { returns, series: [], first: null, live: liveD != null } };
    });
}

export function PerformancePanel({ s }: { s: DailySummary }) {
  const [perf, setPerf] = useState<PimPerformanceData | null>(null);
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState<string | null>(null);

  // History: on mount and every 5 minutes (picks up the daily close without a reload).
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/kv/pim-performance", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: PimPerformanceData | null) => alive && d && Array.isArray(d.models) && setPerf(d))
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Live tick: every minute during market hours.
  useEffect(() => {
    const id = setInterval(() => {
      if (!isTradingHours()) return;
      setTick((t) => t + 1);
      setClock(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date()));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const activeRange = range.from ? range : null;
  const cols = activeRange
    ? [...BASE_COLS, { key: "range" as ColKey, label: `${range.from.slice(5)} → ${(range.to || getTodayET()).slice(5)}` }]
    : BASE_COLS;
  const { sleeves, client } = useBookRows(perf, tick, activeRange);
  const markets = useMarketRows(s, tick);
  const coreRow = sleeves.find((r) => r.key === "core");
  const anyLive = [...sleeves, ...client].some((r) => r.c.live);
  const lastClose = useMemo(() => {
    const d = coreRow?.c.series.filter((p) => !(coreRow.c.live && p.date === getTodayET())).at(-1)?.date;
    return d ?? null;
  }, [coreRow]);
  const firstDate = coreRow?.c.first ?? undefined;

  const vsCore = (r: Row, k: ColKey) => {
    if (r.key === "core") return null;
    const a = r.c.returns[k];
    const b = coreRow?.c.returns[k] ?? null;
    return a == null || b == null ? null : parseFloat((a - b).toFixed(2));
  };

  const renderRow = (r: Row, showTrend: boolean) => {
    const pts = showTrend ? trendSlice(r.c.series, activeRange) : [];
    const building = !r.market && r.c.series.length < 2;
    const short = r.c.first && r.c.first >= `${getTodayET().slice(0, 4)}-01-01` ? `since ${r.c.first.slice(5)}` : "";
    return (
      <tr key={r.key}>
        <td className="pl-3.5">
          <span className="font-medium text-ink">{r.label}</span>
          {(r.note || short) && <div className="text-[11px] text-ink-3">{[r.note, short].filter(Boolean).join(" · ")}</div>}
        </td>
        {cols.map((c) => {
          const v = r.c.returns[c.key];
          const d = vsCore(r, c.key);
          return (
            <td key={c.key} className="n">
              <div className={`font-mono ${tone(v)}`}>{building && c.key === "1d" ? "building" : fmt(v)}</div>
              {r.key !== "core" && (
                <div className={`font-mono text-[11px] ${d == null ? "text-ink-faint" : d > 0 ? "text-pos" : d < 0 ? "text-neg" : "text-ink-3"}`}>
                  {d == null ? "\u00a0" : `${d > 0 ? "+" : ""}${d.toFixed(2)}`}
                </div>
              )}
            </td>
          );
        })}
        <td className="pr-3.5">{pts.length > 1 ? <Sparkline points={pts} width={96} height={22} /> : <span className="text-[11px] text-ink-faint">{showTrend ? "building" : ""}</span>}</td>
      </tr>
    );
  };

  const group = (label: string) => (
    <tr>
      <td colSpan={cols.length + 2} className="pl-3.5" style={{ background: "var(--color-surface-2)" }}>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3">{label}</span>
      </td>
    </tr>
  );

  const DATE = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink";
  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Performance</span>
        <span className="m">
          {anyLive ? `Live${clock ? ` · ${clock} ET` : ""} · on the ${lastClose ?? "last"} close` : lastClose ? `Through the ${lastClose} close` : "Loading…"} · C$
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
          Range
          <input type="date" aria-label="Range from" value={range.from} min={firstDate} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className={DATE} />
          to
          <input type="date" aria-label="Range to" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className={DATE} />
          {(range.from || range.to) && (
            <button className="text-accent hover:text-accent-ink" onClick={() => setRange({ from: "", to: "" })}>
              Clear
            </button>
          )}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Book</th>
              {cols.map((c) => (
                <th key={c.key} className={`n ${c.key === "range" ? "text-accent" : ""}`}>
                  {c.label}
                </th>
              ))}
              <th className="pr-3.5">{activeRange ? "Range trend" : "YTD trend"}</th>
            </tr>
          </thead>
          <tbody>
            {group("Equity sleeves")}
            {sleeves.map((r) => renderRow(r, true))}
            {client.length > 0 && group("Client models")}
            {client.map((r) => renderRow(r, true))}
            {markets.length > 0 && group("Markets")}
            {markets.map((r) => renderRow(r, false))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2 text-[11.5px] text-ink-3">
        <span>Each cell: the return, and beneath it the points ahead of (+) or behind (−) Core over the same period. Set a range to add a column for any dates. Today&apos;s move is live while the market is open.</span>
        <Link href="/aa-performance" className="ml-auto text-accent hover:text-accent-ink">
          All performance
        </Link>
      </div>
    </section>
  );
}
