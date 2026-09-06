"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { useStocks } from "@/app/lib/StockContext";
import { Skeleton } from "../Skeleton";
import { Fold, Pct, SectionHeading, timeAgo } from "./summary-ui";
import { AlphaCoreCard, BenchmarkStrip, BottomLineCard, CashCard, ChangedStrip, HedgeCard, RegimeCard } from "./SummaryTop";
import { ActionQueue, ThesisBookCard } from "./SummaryAct";
import { NextUpCard } from "./NextUp";
import { EarningsCard, EconCard } from "./SummaryCalendar";
import { DriversCard, ModelsCard, SectorMapCard } from "./SummaryMarket";
import { RegimeDetail } from "./RegimeDetail";

/**
 * The Brief cockpit.
 *
 * Design goal: everything that answers a daily question fits above the fold —
 * the four decision tiles, what needs a decision, what is coming. Everything
 * else is a one-row rail that stays closed, and each CLOSED rail carries a
 * live one-line read so you can tell whether it is worth opening. Open/closed
 * persists per person in pm:ui-prefs.
 *
 * Section ids feed the sticky command bar's rail, together with the
 * narrative's s-board / s-horizon / s-narrative from MorningBrief.
 */

const REGIME_PREF = "brief.summary.regimeDetail";

export const SUMMARY_SECTIONS = [
  { id: "s-today", label: "Today" },
  { id: "s-act", label: "Act" },
  { id: "s-calendar", label: "Calendar" },
  { id: "s-market", label: "Market" },
  { id: "s-board", label: "Board" },
  { id: "s-horizon", label: "Horizons" },
  { id: "s-narrative", label: "Narrative" },
];

export function DailySummaryView({ onLoaded }: { onLoaded?: (s: DailySummary) => void }) {
  const { uiPrefs, setUiPref } = useStocks();
  const [data, setData] = useState<DailySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingDrivers, setRefreshingDrivers] = useState(false);

  const load = useCallback(
    async (opts: { drivers?: boolean } = {}) => {
      try {
        const res = await fetch(`/api/daily-summary${opts.drivers ? "?drivers=1" : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as DailySummary;
        setData(j);
        setError(null);
        onLoaded?.(j);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [onLoaded]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const onMark = useCallback(async (id: string, status: "done" | "snoozed" | "clear") => {
    const until = status === "snoozed" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined;
    // Optimistic: move the item between open / dismissed locally, then persist.
    setData((prev) => {
      if (!prev?.actions) return prev;
      const a = prev.actions;
      const all = [...a.items, ...a.dismissed];
      const items: typeof a.items = [];
      const dismissed: typeof a.dismissed = [];
      for (const it of all) {
        const { state: _drop, ...bare } = it;
        void _drop;
        if (it.id === id) {
          if (status === "clear") items.push(bare);
          else dismissed.push({ ...bare, state: { status, at: new Date().toISOString(), ...(until ? { until } : {}) } });
        } else if (it.state) dismissed.push(it);
        else items.push(it);
      }
      return {
        ...prev,
        actions: {
          ...a,
          items,
          dismissed,
          counts: {
            high: items.filter((i) => i.priority === "high").length,
            medium: items.filter((i) => i.priority === "medium").length,
            low: items.filter((i) => i.priority === "low").length,
            open: items.length,
            cleared: dismissed.length,
          },
        },
      };
    });
    try {
      await fetch("/api/kv/action-state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status, until }) });
    } catch {
      /* the next load re-syncs */
    }
  }, []);

  const refreshDrivers = useCallback(async () => {
    setRefreshingDrivers(true);
    try {
      await load({ drivers: true });
    } finally {
      setRefreshingDrivers(false);
    }
  }, [load]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-2/3" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[200px]" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr]">
          <Skeleton className="h-[300px]" />
          <Skeleton className="h-[300px]" />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[42px]" />
        ))}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-card border border-neg-border bg-neg-soft px-4 py-3 text-[12px] text-neg">
        Summary failed to load{error ? `: ${error}` : ""}.{" "}
        <button onClick={() => load()} className="underline">
          Retry
        </button>
      </div>
    );
  }
  const s = data;
  const regimeOpen = (uiPrefs[REGIME_PREF] ?? "1") !== "1";

  return (
    <div className="space-y-3">
      {/* ── Today: the four reads, above the fold ── */}
      <SectionHeading id="s-today" title="Today" sub={`${s.todayLabel} · summary ${timeAgo(s.generatedAt)}`} />
      <ChangedStrip s={s} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <RegimeCard s={s} detailOpen={regimeOpen} onOpenDetail={() => setUiPref(REGIME_PREF, regimeOpen ? "1" : "0")} />
        <AlphaCoreCard s={s} />
        <CashCard s={s} />
        <HedgeCard s={s} />
      </div>

      {regimeOpen && (
        <Fold
          prefKey={REGIME_PREF}
          title="Regime dial"
          meta="every signal, and what it is worth"
          defaultOpen
          tone={s.regime?.composite?.label === "Risk-On" ? "pos" : s.regime?.composite?.label === "Risk-Off" ? "neg" : "warn"}
        >
          <RegimeDetail s={s} />
        </Fold>
      )}

      <BottomLineCard s={s} />

      {/* ── Act: the queue, beside what is coming ── */}
      <SectionHeading id="s-act" title="Act" sub="what needs a decision, and what is coming" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.55fr_1fr]">
        <ActionQueue s={s} onMark={onMark} scrollable />
        <NextUpCard s={s} />
      </div>

      {/* ── Rails: closed by default, each carrying a live one-line read ── */}
      <div className="space-y-2 pt-1">
        <Fold
          prefKey="brief.summary.thesis"
          title="Thesis & book"
          meta="monitoring"
          preview={<ThesisPreview s={s} />}
          right={<RailHint>kill conditions · coverage · risk</RailHint>}
        >
          <ThesisBookCard s={s} bare />
        </Fold>

        <Fold
          prefKey="brief.summary.calendar"
          id="s-calendar"
          title="Calendar"
          meta={s.calendar ? `${s.calendar.windowDays} days` : undefined}
          preview={<CalendarPreview s={s} />}
          right={<RailHint>earnings · economic releases</RailHint>}
        >
          <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
            <EarningsCard s={s} />
            <EconCard s={s} />
          </div>
        </Fold>

        <Fold
          prefKey="brief.summary.market"
          id="s-market"
          title="Market"
          preview={<MarketPreview s={s} />}
          right={<RailHint>drivers · sector map · models</RailHint>}
        >
          <div className="space-y-3 p-3">
            <BenchmarkStrip s={s} />
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.5fr_1fr]">
              <DriversCard s={s} onRefresh={refreshDrivers} refreshing={refreshingDrivers} />
              <SectorMapCard s={s} />
            </div>
            <ModelsCard s={s} />
          </div>
        </Fold>

      </div>

      {s.errors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[10.5px] text-ink-faint">
          {s.errors.map((e) => (
            <span key={e.section} title={e.error} className="rounded-pill border border-line px-2 py-[2px]">
              {e.section}: unavailable
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RailHint({ children }: { children: React.ReactNode }) {
  return <span className="hidden text-[11px] text-ink-faint lg:inline">{children}</span>;
}

/* ── the one-line reads a CLOSED rail carries ────────────────────────── */

function ThesisPreview({ s }: { s: DailySummary }) {
  const t = s.actions?.thesis;
  const b = s.book;
  if (!t && !b) return <span className="text-ink-3">unavailable</span>;
  const trips = t?.tripped.length ?? 0;
  return (
    <>
      {b && (
        <>
          <b className="text-pos">{b.thesis.intact}</b> intact · <b className="text-warn">{b.thesis.eroding}</b> eroding ·{" "}
          <b className={b.thesis.broken > 0 ? "text-neg" : ""}>{b.thesis.broken}</b> broken
        </>
      )}
      {trips > 0 && <span className="text-neg"> · {trips} tripped: {t!.tripped.map((x) => x.ticker).join(", ")}</span>}
      {t && <> · {t.underwritten}/{t.portfolioCount} underwritten</>}
      {b?.weightedBeta != null && <> · β <span className="font-mono">{b.weightedBeta}</span></>}
    </>
  );
}

function CalendarPreview({ s }: { s: DailySummary }) {
  const c = s.calendar;
  if (!c) return <span className="text-ink-3">unavailable</span>;
  const held = c.earnings.filter((e) => e.bucket === "Portfolio").length;
  const next = c.earnings[0];
  const nextEcon = c.econ[0];
  if (c.earnings.length === 0 && c.econ.length === 0) return <span className="text-ink-3">nothing scheduled</span>;
  return (
    <>
      <b>{c.earnings.length}</b> print{c.earnings.length === 1 ? "" : "s"} ({held} held)
      {next && <> · next <span className="font-mono">{next.ticker}</span> {relDaysShort(next.daysAway)}</>}
      {nextEcon && <> · {nextEcon.title} {relDaysShort(nextEcon.daysAway)}</>}
      {c.postPrints.length > 0 && <> · {c.postPrints.length} just reported</>}
    </>
  );
}

function MarketPreview({ s }: { s: DailySummary }) {
  const d = s.drivers;
  const idx = d?.indexes.find((i) => i.key === "spx");
  if (!idx || idx.namesPriced === 0) {
    const bench = s.performance?.benchmarks.find((b) => b.key === "sp500");
    if (!bench) return <span className="text-ink-3">drivers not built yet</span>;
    return (
      <>
        S&P <Pct v={bench.returns["1d"]} /> · TSX <Pct v={s.performance?.benchmarks.find((b) => b.key === "tsx")?.returns["1d"]} /> · run the drivers build for contributors
      </>
    );
  }
  const top = idx.top1d[0];
  const bottom = idx.bottom1d[0];
  const worstSector = idx.sectors[idx.sectors.length - 1];
  const heldInTop = idx.top1d.filter((r) => r.held === "Portfolio").length;
  return (
    <>
      S&P <Pct v={idx.ret1d} />
      {top && <> · <span className="font-mono">{top.ticker}</span> leads <span className="font-mono">{top.contrib1d! > 0 ? "+" : ""}{(top.contrib1d! * 100).toFixed(0)}bp</span></>}
      {bottom && bottom.contrib1d != null && bottom.contrib1d < 0 && (
        <> · <span className="font-mono">{bottom.ticker}</span> drags <span className="font-mono">{(bottom.contrib1d * 100).toFixed(0)}bp</span></>
      )}
      {worstSector && <> · {worstSector.sector} lags <Pct v={worstSector.ret1d} digits={1} /></>}
      {heldInTop > 0 && <> · you hold {heldInTop} of the top 10</>}
    </>
  );
}

function relDaysShort(n: number): string {
  if (!isFinite(n)) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n}d`;
}
