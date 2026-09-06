"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Skeleton } from "../Skeleton";
import { SectionHeading, timeAgo } from "./summary-ui";
import { AlphaCoreCard, BenchmarkStrip, BottomLineCard, CashCard, ChangedStrip, HedgeCard, RegimeCard } from "./SummaryTop";
import { ActionQueue, ThesisBookCard } from "./SummaryAct";
import { EarningsCard, EconCard } from "./SummaryCalendar";
import { DriversCard, ModelsCard, SectorMapCard } from "./SummaryMarket";
import { FunnelCard, InflowCard, JournalCard } from "./SummaryDesk";

/**
 * The deterministic summary that now leads the Brief page. Paints from
 * /api/daily-summary (no Anthropic spend); the AI narrative folds render
 * beneath it inside MorningBrief.
 *
 * Section ids (s-today, s-act, s-calendar, s-market, s-desk) feed the sticky
 * command bar's rail together with the narrative's s-board / s-horizon /
 * s-narrative.
 */

export const SUMMARY_SECTIONS = [
  { id: "s-today", label: "Today" },
  { id: "s-act", label: "Act" },
  { id: "s-calendar", label: "Calendar" },
  { id: "s-market", label: "Market" },
  { id: "s-desk", label: "Desk" },
  { id: "s-board", label: "Board" },
  { id: "s-horizon", label: "Horizons" },
  { id: "s-narrative", label: "Narrative" },
];

export function DailySummaryView({ onLoaded }: { onLoaded?: (s: DailySummary) => void }) {
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

  const onMark = useCallback(
    async (id: string, status: "done" | "snoozed" | "clear") => {
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
    },
    []
  );

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
        <Skeleton className="h-6 w-2/3" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[230px]" />)}
        </div>
        <Skeleton className="h-[90px]" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
          <Skeleton className="h-[260px]" />
          <Skeleton className="h-[260px]" />
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-card border border-neg-border bg-neg-soft px-4 py-3 text-[12px] text-neg">
        Summary failed to load{error ? `: ${error}` : ""}.{" "}
        <button onClick={() => load()} className="underline">Retry</button>
      </div>
    );
  }
  const s = data;

  return (
    <div className="space-y-5">
      {/* ── Today ── */}
      <SectionHeading id="s-today" title="Today" sub={`${s.todayLabel} · summary ${timeAgo(s.generatedAt)}`} />
      <ChangedStrip s={s} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AlphaCoreCard s={s} />
        <RegimeCard s={s} />
        <CashCard s={s} />
        <HedgeCard s={s} />
      </div>
      <BottomLineCard s={s} />

      {/* ── Act ── */}
      <SectionHeading id="s-act" title="Act" sub="what needs a decision, and the thesis monitor behind it" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <ActionQueue s={s} onMark={onMark} />
        <ThesisBookCard s={s} />
      </div>

      {/* ── Calendar ── */}
      <SectionHeading id="s-calendar" title="Calendar" sub="prints across the book and the funnel, and the macro tape" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <EarningsCard s={s} />
        <EconCard s={s} />
      </div>

      {/* ── Market ── */}
      <SectionHeading id="s-market" title="Market" sub="who is moving the index, sector leadership, and every model's return" />
      <BenchmarkStrip s={s} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_1fr]">
        <DriversCard s={s} onRefresh={refreshDrivers} refreshing={refreshingDrivers} />
        <SectorMapCard s={s} />
      </div>
      <ModelsCard s={s} />

      {/* ── Desk ── */}
      <SectionHeading id="s-desk" title="Desk" sub="what arrived, where the funnel stands, and whether the process is working" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <InflowCard s={s} />
        <FunnelCard s={s} />
        <JournalCard s={s} />
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
