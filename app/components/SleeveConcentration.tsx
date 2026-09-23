"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { canonicalTicker, displayTicker } from "@/app/lib/ticker";
import { sleevesOf, isCoreDesignated } from "@/app/lib/sleeves";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { RiskAnalytics, RiskCluster } from "@/app/lib/risk-analytics";

/* Concentration by theme, per sleeve. The 10% cap is per NAME; the real risk
 * is five Tactical names that are one trade. The risk lens already clusters
 * the book by correlation (≥0.7, 1y daily) — this shows each stock cluster
 * with its members' sleeves and weight, and flags the ones that are big or
 * Tactical-heavy. Read-only; served from the risk-analytics cache. */

const BIG_CLUSTER = 0.15;   // of the included book
const TACTICAL_HEAVY = 3;   // Tactical names in one cluster

export function SleeveConcentration() {
  const { stocks } = useStocks();
  const [risk, setRisk] = useState<RiskAnalytics | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  useEffect(() => {
    let alive = true;
    fetch("/api/risk-analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d?.data?.clusters) { setRisk(d.data); setState("ok"); } else setState("none"); })
      .catch(() => alive && setState("none"));
    return () => { alive = false; };
  }, []);

  const sleeveOf = useMemo(() => {
    const m = new Map<string, "Thesis" | "Tactical" | "Thesis + Tactical" | "Core" | "—">();
    for (const s of stocks) {
      if (s.bucket !== "Portfolio") continue;
      const sl = sleevesOf(s);
      m.set(canonicalTicker(s.ticker), isCoreDesignated(s) ? "Core" : sl.thesis && sl.tactical ? "Thesis + Tactical" : sl.thesis ? "Thesis" : sl.tactical ? "Tactical" : "—");
    }
    return m;
  }, [stocks]);
  const weightOf = useMemo(() => new Map((risk?.names ?? []).map((n) => [canonicalTicker(n.ticker), n.weight])), [risk]);

  const clusters = useMemo(() => (risk?.clusters ?? [])
    .filter((c: RiskCluster) => (c.kind ?? "stock") === "stock" && c.members.length >= 2)
    .map((c) => {
      const members = c.members.map((tk) => ({ tk, sleeve: sleeveOf.get(canonicalTicker(tk)) ?? "—", w: weightOf.get(canonicalTicker(tk)) ?? null }));
      const tactical = members.filter((m) => m.sleeve.includes("Tactical")).length;
      const flag = c.totalWeight >= BIG_CLUSTER ? "big" : tactical >= TACTICAL_HEAVY ? "tactical-heavy" : null;
      return { ...c, members, tactical, flag };
    })
    .sort((a, b) => Number(Boolean(b.flag)) - Number(Boolean(a.flag)) || b.totalWeight - a.totalWeight), [risk, sleeveOf, weightOf]);

  return (
    <CollapsibleSection prefKey="review.concentration" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Concentration by theme" subtitle={risk ? `correlation clusters from the risk lens · ${risk.computedAt.slice(0, 10)}` : undefined} defaultCollapsed right={<Link href="/risk" className="text-[12px] !text-accent hover:underline">Risk lens</Link>}>
      {state === "loading" ? <p className="text-[12px] text-ink-3">Loading…</p> : state === "none" || clusters.length === 0 ? (
        <p className="text-[12px] text-ink-3">No stock clusters right now (names correlate below the 0.7 threshold, or the risk lens has not run).</p>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 text-[12px]">
          {clusters.map((c, i) => (
            <div key={i} className={`rounded-card border px-3 py-2 ${c.flag ? "border-warn-border bg-warn-soft" : "border-line bg-surface"}`}>
              <div className="flex items-baseline gap-2">
                <span className="font-mono font-semibold tabular-nums text-ink">{(c.totalWeight * 100).toFixed(1)}%</span>
                <span className="text-ink-3">of the book · corr {c.avgCorr.toFixed(2)} · {c.members.length} names · {c.tactical} Tactical</span>
                {c.flag && <span className="ml-auto text-[11px] font-medium text-warn">{c.flag === "big" ? `≥ ${BIG_CLUSTER * 100}% in one theme` : `${c.tactical} Tactical names move together`}</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {c.members.map((m) => (
                  <span key={m.tk} className="whitespace-nowrap">
                    <Link href={`/stock/${m.tk.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">{displayTicker(m.tk)}</Link>
                    <span className={`ml-1 text-[11px] ${m.sleeve.includes("Tactical") ? "text-violet" : m.sleeve === "Thesis" ? "text-accent" : "text-ink-3"}`}>{m.sleeve}</span>
                    {m.w != null && <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-3">{(m.w * 100).toFixed(1)}%</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
