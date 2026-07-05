"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ChangeEvent, ChangeType, Severity } from "@/app/lib/change-monitor";
import { useCollapsed } from "@/app/lib/useCollapsed";

/**
 * Dashboard "change monitor" — surfaces what materially changed (ratings,
 * targets, price moves, signal splits, stale data) so the PM doesn't have to
 * re-review every name. Reads /api/change-monitor (derived from stored data)
 * and persists a per-event "reviewed" mark via /api/kv/change-monitor-reviewed.
 */

const TYPE_LABELS: Record<ChangeType, string> = {
  rating: "Ratings",
  score: "Score",
  target: "Targets",
  price: "Price",
  signal: "Signals",
  data: "Data",
  "research-removed": "List drops",
  estimate: "Estimates",
};

const SEV_DOT: Record<Severity, string> = {
  down: "bg-red-500",
  warn: "bg-amber-400",
  info: "bg-blue-500",
  up: "bg-emerald-500",
};
const SEV_TEXT: Record<Severity, string> = {
  down: "text-red-600",
  warn: "text-amber-600",
  info: "text-blue-600",
  up: "text-emerald-600",
};

export function ChangeMonitor() {
  const [events, setEvents] = useState<ChangeEvent[] | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const [windowDays, setWindowDays] = useState(7);
  const [filter, setFilter] = useState<ChangeType | "all">("all");
  const [scope, setScope] = useState<"all" | "Portfolio" | "Watchlist">("all");
  const [showReviewed, setShowReviewed] = useState(false);
  // Persisted so a collapsed monitor stays collapsed across tab nav + refresh.
  const [collapsed, toggleCollapsed] = useCollapsed("changeMonitor.collapsed");

  const load = useCallback(async (win: number) => {
    try {
      const [evRes, rvRes] = await Promise.all([
        fetch(`/api/change-monitor?window=${win}`).then((r) => r.json()),
        fetch(`/api/kv/change-monitor-reviewed`).then((r) => r.json()),
      ]);
      setEvents(Array.isArray(evRes.events) ? evRes.events : []);
      setReviewed(rvRes.reviewed ?? {});
    } catch {
      setEvents([]);
    }
  }, []);

  useEffect(() => { void load(windowDays); }, [load, windowDays]);

  const toggleReviewed = useCallback((id: string) => {
    const next = !reviewed[id];
    setReviewed((prev) => {
      const copy = { ...prev };
      if (next) copy[id] = new Date().toISOString(); else delete copy[id];
      return copy;
    });
    void fetch(`/api/kv/change-monitor-reviewed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, reviewed: next }),
    }).catch(() => {});
  }, [reviewed]);

  // Scope + reviewed filtering happens client-side; type counts reflect scope.
  const scoped = useMemo(
    () => (events ?? []).filter((e) => scope === "all" || e.bucket === scope),
    [events, scope],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const e of scoped) {
      if (showReviewed || !reviewed[e.id]) { c.all++; c[e.type] = (c[e.type] ?? 0) + 1; }
    }
    return c;
  }, [scoped, reviewed, showReviewed]);
  const visible = useMemo(
    () => scoped.filter((e) => (filter === "all" || e.type === filter) && (showReviewed || !reviewed[e.id])),
    [scoped, filter, reviewed, showReviewed],
  );

  const typesPresent = useMemo(() => {
    const set = new Set<ChangeType>();
    for (const e of scoped) set.add(e.type);
    return (Object.keys(TYPE_LABELS) as ChangeType[]).filter((t) => set.has(t));
  }, [scoped]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700">Change monitor</span>
          {events && counts.all > 0 && (
            <span className="text-[10px] font-bold rounded-full bg-slate-800 text-white px-2 py-0.5">{counts.all}</span>
          )}
        </div>
        <span className="text-[11px] text-slate-400">{collapsed ? "Show" : "Hide"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          {/* controls */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1.5">
              {(["all", ...typesPresent] as (ChangeType | "all")[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className={`text-[11.5px] rounded-full px-2.5 py-0.5 border inline-flex items-center gap-1.5 transition-colors ${
                    filter === t ? "bg-slate-100 border-slate-300 text-slate-800 font-semibold" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {t === "all" ? "All" : TYPE_LABELS[t]}
                  <span className="font-mono text-[10px] text-slate-400">{counts[t] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <select value={scope} onChange={(e) => setScope(e.target.value as "all" | "Portfolio" | "Watchlist")} className="text-[11px] rounded border border-slate-200 bg-white px-1.5 py-1 text-slate-600">
                <option value="all">All names</option>
                <option value="Portfolio">Portfolio</option>
                <option value="Watchlist">Watchlist</option>
              </select>
              <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} className="text-[11px] rounded border border-slate-200 bg-white px-1.5 py-1 text-slate-600">
                <option value={1}>24 hours</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
              <label className="flex items-center gap-1 text-[11px] text-slate-500">
                <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} />
                reviewed
              </label>
            </div>
          </div>

          {/* rows */}
          {events === null ? (
            <p className="text-sm text-slate-400 italic py-3">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-slate-400 italic py-3">Nothing material changed in this window. {!showReviewed && counts.all === 0 && scoped.some((e) => reviewed[e.id]) ? "(all reviewed)" : ""}</p>
          ) : (
            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100">
              {visible.map((e) => {
                const isReviewed = !!reviewed[e.id];
                return (
                  <div key={e.id} className={`flex items-center gap-3 px-3 py-2.5 ${isReviewed ? "opacity-45" : ""}`}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${SEV_DOT[e.severity]}`} aria-hidden />
                    <Link href={`/stock/${e.ticker.toLowerCase()}`} className="font-mono text-sm font-semibold text-slate-800 hover:underline min-w-[52px]">
                      {e.ticker}
                    </Link>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800">
                        <span className="text-[10px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5 mr-1.5">{TYPE_LABELS[e.type]}</span>
                        <span className={SEV_TEXT[e.severity]}>{e.headline}</span>
                      </div>
                      <div className="text-[12px] text-slate-500 truncate" title={e.detail}>{e.detail}</div>
                    </div>
                    {e.delta && <span className={`font-mono text-[12.5px] ${SEV_TEXT[e.severity]} shrink-0`}>{e.delta}</span>}
                    <button
                      onClick={() => toggleReviewed(e.id)}
                      title={isReviewed ? "Mark unreviewed" : "Mark reviewed"}
                      aria-label={isReviewed ? "Mark unreviewed" : "Mark reviewed"}
                      className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center text-xs transition-colors ${
                        isReviewed ? "bg-emerald-50 border-emerald-300 text-emerald-600" : "border-slate-200 text-slate-300 hover:text-slate-500 hover:border-slate-300"
                      }`}
                    >
                      ✓
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
