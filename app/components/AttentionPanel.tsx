"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { Alert, Opportunity, RegimeTailwind } from "@/app/lib/alerts";

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
  const positiveCount = opps.length + (tailwind ? 1 : 0);

  return (
    <CollapsibleSection
      prefKey="dashboard.attentionCollapsed"
      className="border-line"
      title={alerts.length > 0 ? "Needs your attention" : "Opportunities"}
      right={
        alerts.length > 0 ? (
          <span className="text-[12px] font-semibold">
            {high > 0 && <span className="text-neg">{high} high</span>}
            {high > 0 && medium > 0 && <span className="text-ink-faint"> · </span>}
            {medium > 0 && <span className="text-warn">{medium} to watch</span>}
          </span>
        ) : (
          <span className="text-[11px] font-semibold text-pos">
            {tailwind && opps.length === 0 ? "Regime tailwind" : `${positiveCount} improving`}
          </span>
        )
      }
    >
      {alerts.length > 0 && (
      <ul className="flex flex-col gap-3">
        {alerts.map((a) => (
          <li key={a.id} className="flex items-start gap-2.5 text-[13px]">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${a.priority === "high" ? "bg-neg" : "bg-warn"}`}
              aria-hidden
            />
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
              {CAT_LABEL[a.category] ?? a.category}
            </span>
            <span className="min-w-0 flex-1">
              <span>
                {a.ticker ? (
                  <Link href={`/stock/${a.ticker.toLowerCase()}`} className="font-semibold text-ink hover:underline">
                    {a.title}
                  </Link>
                ) : (
                  <span className="font-semibold text-ink">{a.title}</span>
                )}
                {a.name && <span className="text-ink-3"> · {a.name}</span>}
                <span className="text-ink-3"> — {a.detail}</span>
              </span>
              {/* Supporting numbers behind the call — so it isn't a black box. */}
              {a.metrics && a.metrics.length > 0 && (
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {a.metrics.map((m, i) => (
                    <span
                      key={i}
                      className="rounded border border-line-soft bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2"
                    >
                      {m}
                    </span>
                  ))}
                </span>
              )}
              {/* The so-what. */}
              {a.action && (
                <span className="mt-1 block text-[12px] leading-5 text-ink-2">
                  <span className="font-semibold text-ink-3">→ </span>
                  {a.action}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      )}

      {/* Positive zone — regime tailwind (market-level) + watchlist names improving. */}
      {hasPositive && (
        <div className={alerts.length > 0 ? "mt-4 border-t border-line-soft pt-3" : ""}>
          {/* Regime tailwind — the positive counterpart to a toward-Risk-Off
              alert. A shift toward Risk-On reads green, not as a red risk. */}
          {tailwind && (
            <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-pos/30 bg-pos-soft px-3 py-2 text-[13px]">
              <span className="mt-0.5 shrink-0 rounded bg-pos px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                Regime
              </span>
              <span className="min-w-0">
                <span className="font-semibold text-ink">
                  {tailwind.leaning === "toward Risk-On"
                    ? `Shifting ${tailwind.leaning} — ${tailwind.likelihood.toLowerCase()} conviction`
                    : `Thawing ${tailwind.leaning} from ${tailwind.basedOnRegime} — ${tailwind.likelihood.toLowerCase()}`}
                </span>
                <span className="text-ink-3"> — {tailwind.detail}</span>
              </span>
            </div>
          )}
          {opps.length > 0 && (
          <>
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
                  {o.name && <span className="text-ink-3"> · {o.name}</span>}
                  {typeof o.composite === "number" && (
                    <span className="text-ink-3"> · composite {o.composite.toFixed(1)}</span>
                  )}
                  {o.sector && <span className="text-ink-3"> · {o.sector}</span>}
                  <span className="text-ink-3"> — {o.signals.join(" · ")}</span>
                </span>
              </li>
            ))}
          </ul>
          </>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
