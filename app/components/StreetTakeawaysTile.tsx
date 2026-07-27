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
type ResultLine = { label: string; actual?: string; consensus?: string; range?: string; yoy?: string };
type GuidanceLine = { period: string; metric: string; value: string; priorGuidance?: string; consensus?: string; direction?: "raised" | "lowered" | "maintained" | "initiated" };
type TrackRecord = { epsBeatRate?: string; revenueBeatRate?: string; guidanceBeatRate?: string; impliedMovePct?: number; recentEarningsMoves?: string[]; priceVsIndex?: string };
type Takeaway = {
  id: string; ticker: string; date: string; event?: string;
  kind?: "takeaways" | "metrics";
  overview?: string; guidance?: string; firms: FirmView[];
  results?: ResultLine[]; guidanceLines?: GuidanceLine[];
  managementOutlook?: string; trackRecord?: TrackRecord;
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
          const gRaised = (e.guidanceLines ?? []).filter((g) => g.direction === "raised").length;
          const gLowered = (e.guidanceLines ?? []).filter((g) => g.direction === "lowered").length;
          return (
            <div key={e.id} className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-ink">
                  {e.date}{e.event ? ` · ${e.event}` : ""}
                  <span className="ml-1.5 rounded bg-white px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-3 border border-line">
                    {e.kind === "metrics" ? "Results" : "Analyst reaction"}
                  </span>
                </span>
                <span className="text-[11px] text-ink-3">
                  {e.kind === "metrics" ? (
                    <>
                      {gRaised > 0 && <span className="text-pos">{gRaised} guide ↑</span>}
                      {gRaised > 0 && gLowered > 0 && " · "}
                      {gLowered > 0 && <span className="text-neg">{gLowered} guide ↓</span>}
                    </>
                  ) : (
                    <>
                      {e.firms.length} firm{e.firms.length === 1 ? "" : "s"}
                      {raises > 0 && <span className="text-pos"> · {raises} PT ↑</span>}
                      {cuts > 0 && <span className="text-neg"> · {cuts} PT ↓</span>}
                    </>
                  )}
                </span>
              </div>

              {e.guidance && (
                <div className="mt-1.5 text-[11px] leading-4 text-ink">
                  <span className="font-semibold">Guidance:</span> {e.guidance}
                </div>
              )}
              {e.overview && <p className="mt-1 text-[11px] leading-4 text-ink-2">{e.overview}</p>}

              {/* Results vs consensus */}
              {e.results && e.results.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-[10px]">
                    <tbody>
                      {e.results.map((r, i) => (
                        <tr key={i} className="text-ink-2">
                          <td className="pr-2 font-medium text-ink">{r.label}</td>
                          <td className="pr-2 font-mono">{r.actual ?? "—"}</td>
                          <td className="pr-2 font-mono text-ink-3">{r.consensus ? `vs ${r.consensus}` : ""}</td>
                          <td className="font-mono text-pos">{r.yoy ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Guidance vs prior guide */}
              {e.guidanceLines && e.guidanceLines.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {e.guidanceLines.map((g, i) => (
                    <div key={i} className="text-[10px] leading-4 text-ink-2">
                      <span className="font-medium text-ink">{g.period} {g.metric}:</span>{" "}
                      <span className="font-mono">{g.value}</span>
                      {g.priorGuidance && <span className="text-ink-3"> (was {g.priorGuidance})</span>}
                      {g.direction && (
                        <span className={g.direction === "raised" ? "text-pos font-semibold" : g.direction === "lowered" ? "text-neg font-semibold" : "text-ink-3"}>
                          {" "}{g.direction === "raised" ? "↑ raised" : g.direction === "lowered" ? "↓ lowered" : g.direction}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {e.managementOutlook && (
                <p className="mt-2 border-l-2 border-line pl-2 text-[10px] italic leading-4 text-ink-2">
                  &ldquo;{e.managementOutlook}&rdquo;
                </p>
              )}

              {/* Beat track record + earnings-day context */}
              {e.trackRecord && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {e.trackRecord.epsBeatRate && (
                    <span className="rounded-full border border-pos-border bg-white px-2 py-0.5 text-[10px] font-semibold text-pos">
                      EPS beat {e.trackRecord.epsBeatRate}
                    </span>
                  )}
                  {e.trackRecord.revenueBeatRate && (
                    <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                      Rev beat {e.trackRecord.revenueBeatRate}
                    </span>
                  )}
                  {e.trackRecord.impliedMovePct != null && (
                    <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                      implied ±{e.trackRecord.impliedMovePct}%
                    </span>
                  )}
                  {e.trackRecord.recentEarningsMoves?.length && (
                    <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[10px] text-ink-2">
                      last 4: {e.trackRecord.recentEarningsMoves.join(", ")}
                    </span>
                  )}
                </div>
              )}

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
