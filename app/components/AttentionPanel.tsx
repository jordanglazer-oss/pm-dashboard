"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { AppIcon } from "./AppIcon";
import type { Alert, Opportunity, RegimeTailwind } from "@/app/lib/alerts";

/**
 * "Needs your attention" — ONE line on the Portfolio home.
 *
 * It used to be the full alert list with metrics and so-whats. The Brief's
 * action queue carries the same alerts (plus kill trips, prints and change
 * events) and is the only place with done / snooze, so the list here was a
 * second, weaker copy. This row is the count, the first few headlines, and
 * the way to the queue. Renders nothing when calm.
 */

export function AttentionPanel() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [tailwind, setTailwind] = useState<RegimeTailwind | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setAlerts(Array.isArray(j?.alerts) ? j.alerts : []);
        setOpps(Array.isArray(j?.opportunities) ? j.opportunities : []);
        setTailwind(j?.regimeTailwind ?? null);
      })
      .catch(() => alive && setAlerts([]));
    return () => {
      alive = false;
    };
  }, []);

  const hasPositive = opps.length > 0 || !!tailwind;
  if (!alerts || (alerts.length === 0 && !hasPositive)) return null;

  const high = alerts.filter((a) => a.priority === "high").length;
  const medium = alerts.length - high;
  const lead = [...alerts.filter((a) => a.priority === "high"), ...alerts.filter((a) => a.priority !== "high")].slice(0, 3);
  const dot = high > 0 ? "bg-neg" : alerts.length > 0 ? "bg-warn" : "bg-pos";

  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface px-3.5 py-2 text-[12.5px]">
      <span className={`dot ${dot}`} aria-hidden />
      <span className="font-medium">
        {high > 0 && <span className="text-neg">{high} high</span>}
        {high > 0 && medium > 0 && <span className="text-ink-faint"> · </span>}
        {medium > 0 && <span className="text-warn">{medium} to watch</span>}
        {alerts.length === 0 && <span className="text-pos">{tailwind && opps.length === 0 ? "Regime tailwind" : `${opps.length} improving`}</span>}
      </span>
      {lead.length > 0 && (
        <span className="min-w-0 flex-1 truncate text-ink-2">
          {lead.map((a, i) => (
            <span key={a.id}>
              {i > 0 && <span className="text-ink-faint"> · </span>}
              {a.ticker && (
                <Link href={`/stock/${a.ticker.toLowerCase()}`} className="font-mono font-semibold text-ink hover:underline">
                  {a.ticker.toUpperCase()}
                </Link>
              )}
              {a.ticker ? " " : ""}
              {a.title}
            </span>
          ))}
          {alerts.length > lead.length && <span className="text-ink-3"> · +{alerts.length - lead.length} more</span>}
        </span>
      )}
      {alerts.length > 0 && (opps.length > 0 || tailwind) && (
        <span className="shrink-0 text-[11px] font-semibold text-pos">
          {tailwind && opps.length === 0 ? "regime tailwind" : `${opps.length} improving`}
        </span>
      )}
      <Link href="/brief#s-act" className="ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] !text-accent-ink hover:!text-accent">
        Open the queue<AppIcon name="arrowR" size={12} strokeWidth={2} />
      </Link>
    </section>
  );
}
