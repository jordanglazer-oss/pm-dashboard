"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { Alert, Opportunity } from "@/app/lib/alerts";

/**
 * "Needs your attention" panel (Phase 07) — the proactive in-app surface.
 * Aggregates the highest-signal items (thesis broken/eroding, regime transition
 * risk, critical risk alerts) from /api/alerts and shows them at the top of the
 * dashboard, so the PM doesn't have to go looking. Renders nothing when calm.
 */

const CAT_LABEL: Record<string, string> = { thesis: "Thesis", regime: "Regime", technical: "Technical" };

export function AttentionPanel() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setAlerts(Array.isArray(j?.alerts) ? j.alerts : []);
        setOpps(Array.isArray(j?.opportunities) ? j.opportunities : []);
      })
      .catch(() => alive && setAlerts([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!alerts || (alerts.length === 0 && opps.length === 0)) return null;

  const high = alerts.filter((a) => a.priority === "high").length;
  const medium = alerts.length - high;

  return (
    <section className="rounded-card border border-line bg-white p-4 shadow-sm">
      {alerts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-warn px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            Needs your attention
          </span>
          <span className="text-[12px] font-semibold text-ink-2">
            {high > 0 && <span className="text-neg">{high} high</span>}
            {high > 0 && medium > 0 && <span className="text-ink-faint"> · </span>}
            {medium > 0 && <span className="text-warn">{medium} to watch</span>}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {alerts.map((a) => (
          <li key={a.id} className="flex items-start gap-2.5 text-[13px]">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${a.priority === "high" ? "bg-neg" : "bg-warn"}`}
              aria-hidden
            />
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
              {CAT_LABEL[a.category] ?? a.category}
            </span>
            <span className="min-w-0">
              {a.ticker ? (
                <Link href={`/stock/${a.ticker.toLowerCase()}`} className="font-semibold text-ink hover:underline">
                  {a.title}
                </Link>
              ) : (
                <span className="font-semibold text-ink">{a.title}</span>
              )}
              <span className="text-ink-3"> — {a.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {/* Opportunities — the offensive twin: watchlist names improving. */}
      {opps.length > 0 && (
        <div className={alerts.length > 0 ? "mt-4 border-t border-line-soft pt-3" : ""}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-pos px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">Opportunities</span>
            <span className="text-[11.5px] text-ink-3">watchlist names improving — worth a look for the book</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {opps.map((o) => (
              <li key={o.id} className="flex items-start gap-2.5 text-[13px]">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-pos" aria-hidden />
                <span className="shrink-0 rounded bg-pos-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-pos">
                  {o.strength === "strong" ? "Strong" : "Building"}
                </span>
                <span className="min-w-0">
                  <Link href={`/stock/${o.ticker.toLowerCase()}`} className="font-semibold text-ink hover:underline">
                    {o.ticker}
                  </Link>
                  <span className="text-ink-3"> — {o.signals.join(" · ")}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
