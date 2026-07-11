"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { ThesisHealth, ThesisVerdict } from "@/app/lib/thesis-health";

/**
 * Thesis Watch (Phase 03) — the automated half of the Living Thesis Tracker.
 * Surfaces holdings whose thesis is eroding or broken, from signals already
 * tracked (composite trend, estimate revisions, risk alerts). Read-only.
 */

type Holding = ThesisHealth & { name?: string; sector?: string };
type ThesisData = {
  builtAt: string;
  counts: { broken: number; eroding: number; intact: number };
  holdings: Holding[];
};

const VERDICT_BADGE: Record<ThesisVerdict, string> = {
  broken: "bg-neg-soft text-neg",
  eroding: "bg-warn-soft text-warn",
  intact: "bg-pos-soft text-pos",
};

export function ThesisWatch() {
  const [data, setData] = useState<ThesisData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/thesis-health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => alive && j?.thesisHealth?.holdings && setData(j.thesisHealth as ThesisData))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const flagged = (data?.holdings ?? []).filter((h) => h.verdict !== "intact");

  return (
    <CollapsibleSection
      prefKey="portfolio.thesisWatchCollapsed"
      className="border-line"
      title="Thesis watch"
      subtitle="Is the reason you own each name still intact?"
      right={
        data ? (
          <span className="flex items-center gap-2 text-[11px] font-semibold">
            {data.counts.broken > 0 && <span className="text-neg">{data.counts.broken} broken</span>}
            {data.counts.eroding > 0 && <span className="text-warn">{data.counts.eroding} eroding</span>}
            <span className="text-pos">{data.counts.intact} intact</span>
          </span>
        ) : null
      }
    >
      {loading && <p className="py-2 text-sm text-ink-3">Loading…</p>}

      {data && flagged.length === 0 && (
        <p className="py-2 text-sm text-ink-2">
          Every holding&apos;s thesis is <span className="font-semibold text-pos">intact</span> — no deterioration in the signals we track (composite score, estimate revisions, risk alerts).
        </p>
      )}

      {flagged.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[11.5px] text-ink-3">
            These names show deterioration in the signals we track — worth a look before the story fully turns.
          </p>
          {flagged.map((h) => (
            <div key={h.ticker} className="flex items-start gap-3 rounded-control border border-line-soft px-3 py-2.5">
              <Link
                href={`/stock/${h.ticker.toLowerCase()}`}
                className="w-[64px] shrink-0 font-mono text-sm font-semibold text-ink hover:underline"
              >
                {h.ticker}
              </Link>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${VERDICT_BADGE[h.verdict]}`}
              >
                {h.verdict}
              </span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {h.drivers
                  .filter((d) => d.direction === "negative")
                  .map((d, i) => (
                    <span
                      key={`${d.signal}-${i}`}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2"
                      title={d.detail}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-neg" aria-hidden />
                      {d.detail}
                    </span>
                  ))}
              </div>
            </div>
          ))}
          <p className="text-[10.5px] leading-4 text-ink-faint">
            Automated from the composite score trend (~45d), FactSet FY+1 estimate revisions, and technical risk alerts. Verdict: broken = multiple/strong signals; eroding = one signal; intact = none.
          </p>
        </div>
      )}
    </CollapsibleSection>
  );
}
