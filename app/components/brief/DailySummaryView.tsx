"use client";

import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { useStocks } from "@/app/lib/StockContext";
import { Skeleton } from "../Skeleton";
import { AppIcon } from "../AppIcon";
import { DecisionPanel } from "./SummaryTop";
import { ActionQueue, ThesisBookPanel } from "./SummaryAct";
import { CalendarPanel } from "./NextUp";
import { MarketPanel } from "./SummaryMarket";
import { RegimeDetail } from "./RegimeDetail";
import { HedgeLedgerContext } from "./hedge-ledger";

/**
 * The Brief cockpit, to the canvas anatomy:
 *
 *   1. ONE decision panel — Regime · Cash · Hedging · Alpha vs core, with the
 *      Bottom line and the "since last brief" digest beneath (#s-today).
 *   2. The regime detail (every signal) directly under it, when opened from
 *      the Regime cell — persisted.
 *   3. A two-column band (#s-act): the Action queue — the BRIEF'S OWN
 *      recommendations only, everything else linked out through the
 *      "Elsewhere" strip — beside Calendar and Thesis & book.
 *   4. Market as a full-width band under it (#s-market): benchmarks, model
 *      returns and the main contributors/detractors all visible with nothing
 *      opened; the chevron adds the full driver table and sector map.
 *
 * The Board / Horizons / Narrative content lives in MorningBrief's tabbed
 * panel below this view.
 */

const REGIME_PREF = "brief.summary.regimeDetail";

export function DailySummaryView({ onLoaded }: { onLoaded?: (s: DailySummary) => void }) {
  const { uiPrefs, setUiPref } = useStocks();
  const ledger = useContext(HedgeLedgerContext);
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

  // A hedge logged or closed from the Hedging cell changes the active list
  // the summary derives — re-pull so the cell reflects it without a reload.
  const ledgerVersion = ledger?.version ?? 0;
  const seenVersion = useRef(0);
  useEffect(() => {
    if (ledgerVersion === seenVersion.current) return;
    seenVersion.current = ledgerVersion;
    if (ledgerVersion > 0) void load();
  }, [ledgerVersion, load]);

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
      <div className="flex flex-col gap-3.5">
        <Skeleton className="h-[220px]" />
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <Skeleton className="h-[260px]" />
          <div className="flex flex-col gap-3.5">
            <Skeleton className="h-[140px]" />
            <Skeleton className="h-[110px]" />
          </div>
        </div>
        <Skeleton className="h-[360px]" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel px-3.5 py-3 text-[12.5px] text-neg">
        Summary failed to load{error ? `: ${error}` : ""}.{" "}
        <button type="button" onClick={() => load()} className="text-accent hover:text-accent-ink">
          Retry
        </button>
      </div>
    );
  }
  const s = data;
  const regimeOpen = (uiPrefs[REGIME_PREF] ?? "1") !== "1";
  const toggleRegime = () => setUiPref(REGIME_PREF, regimeOpen ? "1" : "0");

  return (
    <div className="flex flex-col gap-3.5">
      <DecisionPanel s={s} regimeDetailOpen={regimeOpen} onToggleRegimeDetail={toggleRegime} />

      {regimeOpen && (
        <section className="panel animate-panel-in">
          <div className="panel-h">
            <span className="t-mark bg-hub-research" />
            <span className="t">Regime dial</span>
            <span className="m">every signal, and what it is worth</span>
            <button type="button" onClick={toggleRegime} className="ml-auto grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover" title="Hide the regime detail" aria-label="Hide the regime detail">
              <AppIcon name="chevU" size={14} />
            </button>
          </div>
          <RegimeDetail s={s} />
        </section>
      )}

      {/* Two-up: the brief's own recommendations beside what is scheduled and
          what the book is doing. Even shares now — the queue only carries the
          brief's calls, so it no longer needs 1.55fr, and nothing stretches to
          fill a short queue (the card sizes to its content). */}
      <div id="s-act" style={{ scrollMarginTop: 64 }} className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <ActionQueue s={s} onMark={onMark} scrollable />
        <div className="flex min-w-0 flex-col gap-3.5">
          <CalendarPanel s={s} />
          <ThesisBookPanel s={s} />
        </div>
      </div>

      {/* Market gets the full width: benchmarks, model returns and the main
          contributors/detractors all readable without opening anything. */}
      <MarketPanel s={s} onRefresh={refreshDrivers} refreshing={refreshingDrivers} />

      {s.errors.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
          {s.errors.map((e) => (
            <span key={e.section} title={e.error} className="inline-flex items-center gap-1.5">
              <span className="dot bg-warn" />
              {e.section}: unavailable
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
