"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppIcon } from "./AppIcon";
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
  "relative-strength": "Rel. strength",
};

const SEV_DOT: Record<Severity, string> = {
  down: "bg-neg",
  warn: "bg-warn",
  info: "bg-accent",
  up: "bg-pos",
};
const SEV_TEXT: Record<Severity, string> = {
  down: "text-neg",
  warn: "text-warn",
  info: "text-accent",
  up: "text-pos",
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
    <div className="panel">
      <div className={`panel-h ${collapsed ? "border-b-0" : ""}`}>
        <button onClick={toggleCollapsed} className="flex items-center gap-2 text-left" aria-expanded={!collapsed}>
          <span className={`text-ink-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}><AppIcon name="chevD" size={14} strokeWidth={2} /></span>
          <span className="t">Changes</span>
        </button>
        <span className="m">{windowDays === 1 ? "24h" : `${windowDays}d`}{events && counts.all > 0 ? ` · ${counts.all} events` : ""}</span>
        {!collapsed && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="seg">
              {(["all", ...typesPresent] as (ChangeType | "all")[]).map((t) => (
                <button key={t} onClick={() => setFilter(t)} className={filter === t ? "on" : ""} aria-pressed={filter === t}>
                  {t === "all" ? "All" : TYPE_LABELS[t]}
                  <span className="c">{counts[t] ?? 0}</span>
                </button>
              ))}
            </div>
            <select value={scope} onChange={(e) => setScope(e.target.value as "all" | "Portfolio" | "Watchlist")} className="h-7 rounded-control border border-line bg-surface px-1.5 text-[12px] text-ink-2">
              <option value="all">All names</option>
              <option value="Portfolio">Portfolio</option>
              <option value="Watchlist">Watchlist</option>
            </select>
            <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} className="h-7 rounded-control border border-line bg-surface px-1.5 text-[12px] text-ink-2">
              <option value={1}>24 hours</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
            <label className="flex items-center gap-1 text-[11.5px] text-ink-3">
              <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} className="accent-accent" />
              reviewed
            </label>
          </div>
        )}
      </div>

      {!collapsed && (
        <div>
          {/* rows */}
          {events === null ? (
            <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Nothing material changed in this window. {!showReviewed && counts.all === 0 && scoped.some((e) => reviewed[e.id]) ? "(all reviewed)" : ""}</p>
          ) : (
            <div className="divide-y divide-line-soft">
              {visible.map((e) => {
                const isReviewed = !!reviewed[e.id];
                return (
                  <div key={e.id} className={`flex min-h-[34px] items-center gap-2.5 px-3.5 py-1 text-[12.5px] ${isReviewed ? "opacity-45" : ""}`}>
                    <span className={`dot ${SEV_DOT[e.severity]}`} aria-hidden />
                    <Link href={`/stock/${e.ticker.toLowerCase()}`} className="w-[60px] shrink-0 font-mono font-medium text-ink hover:underline">
                      {e.ticker}
                    </Link>
                    <span className="w-[128px] shrink-0 truncate text-ink-2" title={TYPE_LABELS[e.type]}>{TYPE_LABELS[e.type]}</span>
                    <div className="min-w-0 flex-1 truncate" title={`${e.headline} — ${e.detail}`}>
                      <span className={SEV_TEXT[e.severity]}>{e.headline}</span>
                      {e.detail && <span className="text-ink-3"> · {e.detail}</span>}
                    </div>
                    {e.delta && <span className={`shrink-0 font-mono text-[12px] ${SEV_TEXT[e.severity]}`}>{e.delta}</span>}
                    <button
                      onClick={() => toggleReviewed(e.id)}
                      title={isReviewed ? "Mark unreviewed" : "Mark reviewed"}
                      aria-label={isReviewed ? "Mark unreviewed" : "Mark reviewed"}
                      className={`grid h-6 w-6 shrink-0 place-items-center rounded border transition-colors ${
                        isReviewed ? "border-pos-border bg-pos-soft text-pos" : "border-line text-ink-faint hover:text-ink-3"
                      }`}
                    >
                      <AppIcon name="check" size={12} strokeWidth={2.25} />
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
