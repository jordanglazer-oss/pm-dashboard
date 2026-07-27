"use client";

import React, { useEffect, useState } from "react";

/**
 * Street Takeaways tile — the FactSet post-earnings analyst roundup ingested
 * from the Gmail inbox. Read-only: shows per-firm price-target changes with
 * each firm's argument, the full-panel rating mix, and valuation vs the
 * name's own history. The same data feeds the scoring prompt.
 */

type FirmView = {
  firm: string; analyst?: string; rating?: string;
  target?: number; priorTarget?: number;
  targetAction?: "raises" | "lowers" | "maintains";
  basis?: string; points?: string[];
};
type Takeaway = {
  id: string; ticker: string; date: string; event?: string;
  overview?: string; guidance?: string; firms: FirmView[];
  consensus?: { analystCount?: number; buyPct?: number; holdPct?: number; sellPct?: number; avgTarget?: number; avgTargetChangePct?: number; impliedUpsidePct?: number };
  valuation?: { ntmPe?: number; ntmPeFiveYrAvg?: number; evEbitda?: number; evEbitdaFiveYrAvg?: number };
  estimateRevisions?: { period?: string; revenueChangePct?: number; epsChangePct?: number };
};

export default function StreetTakeawaysTile({ ticker, className = "" }: { ticker: string; className?: string }) {
  const [entries, setEntries] = useState<Takeaway[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/street-takeaways?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setEntries(Array.isArray(j?.entries) ? j.entries : []); })
      .catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [ticker]);

  // Nothing ingested for this name — render nothing rather than an empty box.
  if (!entries || entries.length === 0) return null;

  return (
    <div className={`rounded-card border border-line bg-white p-4 sm:p-5 shadow-sm ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Street Takeaways</h2>
        <span className="text-[10px] text-ink-3">FactSet analyst roundup · feeds scoring</span>
      </div>

      <div className="mt-3 space-y-3">
        {entries.map((e) => {
          const open = openId === e.id;
          const cuts = e.firms.filter((f) => f.targetAction === "lowers").length;
          const raises = e.firms.filter((f) => f.targetAction === "raises").length;
          return (
            <div key={e.id} className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-ink">
                  {e.date}{e.event ? ` · ${e.event}` : ""}
                </span>
                <span className="text-[11px] text-ink-3">
                  {e.firms.length} firm{e.firms.length === 1 ? "" : "s"}
                  {raises > 0 && <span className="text-pos"> · {raises} PT ↑</span>}
                  {cuts > 0 && <span className="text-neg"> · {cuts} PT ↓</span>}
                </span>
              </div>

              {e.guidance && (
                <div className="mt-1.5 text-[11px] leading-4 text-ink">
                  <span className="font-semibold">Guidance:</span> {e.guidance}
                </div>
              )}
              {e.overview && <p className="mt-1 text-[11px] leading-4 text-ink-2">{e.overview}</p>}

              {/* Consensus + valuation headline chips */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {e.consensus?.avgTarget != null && (
                  <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] font-semibold text-ink-2">
                    Avg PT ${e.consensus.avgTarget}
                    {e.consensus.avgTargetChangePct != null && (
                      <span className={e.consensus.avgTargetChangePct < 0 ? "text-neg" : "text-pos"}>
                        {" "}{e.consensus.avgTargetChangePct > 0 ? "+" : ""}{e.consensus.avgTargetChangePct}%
                      </span>
                    )}
                    {e.consensus.impliedUpsidePct != null && <span className="text-ink-3"> · {e.consensus.impliedUpsidePct > 0 ? "+" : ""}{e.consensus.impliedUpsidePct}% upside</span>}
                  </span>
                )}
                {e.consensus?.buyPct != null && (
                  <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                    {e.consensus.analystCount != null ? `${e.consensus.analystCount} analysts · ` : ""}
                    <span className="text-pos font-semibold">B {e.consensus.buyPct}%</span>
                    {" / "}H {e.consensus.holdPct ?? "?"}%{" / "}
                    <span className="text-neg">S {e.consensus.sellPct ?? "?"}%</span>
                  </span>
                )}
                {e.valuation?.ntmPe != null && (
                  <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                    NTM P/E {e.valuation.ntmPe}x{e.valuation.ntmPeFiveYrAvg != null ? ` vs 5y ${e.valuation.ntmPeFiveYrAvg}x` : ""}
                  </span>
                )}
                {e.estimateRevisions?.epsChangePct != null && (
                  <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                    {e.estimateRevisions.period ?? "FY"} EPS{" "}
                    <span className={e.estimateRevisions.epsChangePct < 0 ? "text-neg" : "text-pos"}>
                      {e.estimateRevisions.epsChangePct > 0 ? "+" : ""}{e.estimateRevisions.epsChangePct}%
                    </span>
                  </span>
                )}
              </div>

              <button
                onClick={() => setOpenId(open ? null : e.id)}
                className="mt-2 text-[11px] font-medium text-accent hover:underline"
              >
                {open ? "▾ Hide per-firm views" : `▸ Show per-firm views (${e.firms.length})`}
              </button>

              {open && (
                <div className="mt-2 space-y-2">
                  {e.firms.map((f, i) => (
                    <div key={i} className="border-t border-line/60 pt-1.5 text-[11px] leading-4">
                      <div className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="font-semibold text-ink">{f.firm}</span>
                        {f.analyst && <span className="text-ink-3">{f.analyst}</span>}
                        {f.rating && <span className="rounded bg-white px-1 py-0.5 text-[10px] text-ink-2 border border-line">{f.rating}</span>}
                        {f.target != null && (
                          <span className={f.targetAction === "lowers" ? "text-neg font-semibold" : f.targetAction === "raises" ? "text-pos font-semibold" : "text-ink-2"}>
                            {f.priorTarget != null ? `$${f.priorTarget} → $${f.target}` : `PT $${f.target}`}
                          </span>
                        )}
                      </div>
                      {f.basis && <div className="text-ink-3">Basis: {f.basis}</div>}
                      {f.points?.map((p, j) => (
                        <div key={j} className="text-ink-2">• {p}</div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
