"use client";

import React, { useEffect, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * Street panel — the FactSet alerts ingested from the Gmail inbox (analyst
 * roundups, results recaps, transcript intelligence, news flashes).
 * Read-only: each alert is a date + one-sentence row; the full content
 * (per-firm views, results vs consensus, guidance, figures, chips) sits one
 * persisted click away (`stock.street.detail`). The same data feeds the
 * scoring prompt.
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
type NewsFigure = { label: string; value: string; context?: string };
type Takeaway = {
  id: string; ticker: string; date: string; event?: string;
  kind?: "takeaways" | "metrics" | "transcript" | "news" | "other";
  headline?: string; keyPoints?: string[]; figures?: NewsFigure[];
  overview?: string; guidance?: string; firms: FirmView[];
  results?: ResultLine[]; guidanceLines?: GuidanceLine[];
  managementOutlook?: string; trackRecord?: TrackRecord;
  consensus?: { analystCount?: number; buyPct?: number; holdPct?: number; sellPct?: number; avgTarget?: number; avgTargetChangePct?: number; impliedUpsidePct?: number };
  valuation?: { ntmPe?: number; ntmPeFiveYrAvg?: number; evEbitda?: number; evEbitdaFiveYrAvg?: number };
  estimateRevisions?: { period?: string; revenueChangePct?: number; epsChangePct?: number };
};

function fmtDate(d: string): string {
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return d;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function kindWord(e: Takeaway): string {
  return e.kind === "news" ? "News" : e.kind === "metrics" ? "Results" : e.kind === "transcript" ? "Transcript" : "Analyst reaction";
}

/** The one-line read for the compact row: headline, else event + a count. */
function oneLine(e: Takeaway): string {
  if (e.headline) return e.headline;
  const firms = e.firms ?? [];
  const cuts = firms.filter((f) => f.targetAction === "lowers").length;
  const raises = firms.filter((f) => f.targetAction === "raises").length;
  const gRaised = (e.guidanceLines ?? []).filter((g) => g.direction === "raised").length;
  const gLowered = (e.guidanceLines ?? []).filter((g) => g.direction === "lowered").length;
  const bits: string[] = [];
  if (e.event) bits.push(e.event);
  if (e.kind === "metrics") {
    if (gRaised > 0) bits.push(`${gRaised} guide raised`);
    if (gLowered > 0) bits.push(`${gLowered} guide lowered`);
  } else if (firms.length > 0) {
    bits.push(`${firms.length} firm${firms.length === 1 ? "" : "s"}`);
    if (raises > 0) bits.push(`${raises} PT up`);
    if (cuts > 0) bits.push(`${cuts} PT down`);
  }
  if (e.overview && bits.length === 0) return e.overview;
  return bits.join(" · ") || kindWord(e);
}

export default function StreetTakeawaysTile({ ticker, className = "" }: { ticker: string; className?: string }) {
  const [entries, setEntries] = useState<Takeaway[] | null>(null);
  // One-at-a-time per-firm accordion (exempt from persistence).
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, toggleDetail] = usePersistedOpen("stock.street.detail", false);

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

  // Header meta: the most recent alert that carried a consensus read.
  const latestCons = entries.find((e) => e.consensus?.avgTarget != null || e.consensus?.buyPct != null)?.consensus;
  const headerMeta = latestCons
    ? [
        latestCons.avgTarget != null ? `Avg PT $${latestCons.avgTarget}` : null,
        latestCons.analystCount != null ? `${latestCons.analystCount} analysts` : null,
        latestCons.buyPct != null ? `${latestCons.buyPct}% Buy` : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <section className={`panel ${className}`}>
      <div className="panel-h">
        <span className="t">Street</span>
        <span className="m">FactSet alerts · feeds scoring</span>
        {headerMeta && <span className="m ml-auto">{headerMeta}</span>}
        <button
          onClick={toggleDetail}
          className={`${headerMeta ? "" : "ml-auto"} grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink`}
          aria-expanded={detail}
          aria-label={detail ? "Hide alert details" : "Show alert details"}
          title={detail ? "Hide full alert content" : "Show full alert content (results, guidance, figures, per-firm views)"}
        >
          <AppIcon name={detail ? "chevU" : "chevD"} size={14} />
        </button>
      </div>

      <div className={`flex flex-col px-3.5 py-2 ${detail ? "divide-y divide-line-soft" : "gap-1.5"}`}>
        {entries.map((e) => {
          const open = openId === e.id;
          const firms = e.firms ?? [];
          return (
            <div key={e.id} className={detail ? "py-2.5 first:pt-1 last:pb-1" : ""}>
              {/* Compact row: mono date + sentence */}
              <div className="flex items-baseline gap-2 text-[12.5px] leading-[1.5] text-ink-2">
                <span className="w-12 shrink-0 font-mono text-[11.5px] text-ink-3">{fmtDate(e.date)}</span>
                <span className="min-w-0 flex-1">
                  {oneLine(e)}
                  <span className="ml-1.5 text-[11px] text-ink-3">{kindWord(e)}</span>
                </span>
              </div>

              {detail && (
                <div className="mt-1.5 pl-14 text-[12px] leading-[1.5] text-ink-2">
                  {e.event && e.headline && <div className="text-ink-3">{e.event}</div>}
                  {e.guidance && (
                    <div><span className="font-medium text-ink">Guidance:</span> {e.guidance}</div>
                  )}
                  {e.overview && <p>{e.overview}</p>}

                  {/* News: stated figures, each with the baseline the item gave it */}
                  {e.figures && e.figures.length > 0 && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {e.figures.map((f, i) => (
                        <div key={i}>
                          <span className="font-medium text-ink">{f.label}:</span>{" "}
                          <span className="font-mono">{f.value}</span>
                          {f.context && <span className="text-ink-3"> ({f.context})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {e.keyPoints && e.keyPoints.length > 0 && (
                    <ul className="mt-1 list-disc pl-4">
                      {e.keyPoints.map((k, i) => (
                        <li key={i}>{k}</li>
                      ))}
                    </ul>
                  )}

                  {/* Results vs consensus */}
                  {e.results && e.results.length > 0 && (
                    <div className="mt-1.5 overflow-x-auto">
                      <table className="data-table">
                        <thead>
                          <tr><th>Line</th><th className="n">Actual</th><th className="n">Consensus</th><th className="n">YoY</th></tr>
                        </thead>
                        <tbody>
                          {e.results.map((r, i) => (
                            <tr key={i}>
                              <td>{r.label}</td>
                              <td className="n">{r.actual ?? "—"}</td>
                              <td className="n text-ink-3">{r.consensus ?? ""}</td>
                              <td className="n text-pos">{r.yoy ?? ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Guidance vs prior guide */}
                  {e.guidanceLines && e.guidanceLines.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-0.5">
                      {e.guidanceLines.map((g, i) => (
                        <div key={i}>
                          <span className="font-medium text-ink">{g.period} {g.metric}:</span>{" "}
                          <span className="font-mono">{g.value}</span>
                          {g.priorGuidance && <span className="text-ink-3"> (was {g.priorGuidance})</span>}
                          {g.direction && (
                            <span className={g.direction === "raised" ? "text-pos" : g.direction === "lowered" ? "text-neg" : "text-ink-3"}>
                              {" "}· {g.direction}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {e.managementOutlook && (
                    <p className="mt-1.5 border-l-2 border-line pl-2 italic">&ldquo;{e.managementOutlook}&rdquo;</p>
                  )}

                  {/* Beat track record + earnings-day context + consensus + valuation — plain text reads */}
                  {(() => {
                    const bits: React.ReactNode[] = [];
                    const tr = e.trackRecord;
                    if (tr?.epsBeatRate) bits.push(<span key="eps">EPS beat <span className="font-mono text-pos">{tr.epsBeatRate}</span></span>);
                    if (tr?.revenueBeatRate) bits.push(<span key="rev">Rev beat <span className="font-mono">{tr.revenueBeatRate}</span></span>);
                    if (tr?.impliedMovePct != null) bits.push(<span key="imp">implied <span className="font-mono">±{tr.impliedMovePct}%</span></span>);
                    if (tr?.recentEarningsMoves?.length) bits.push(<span key="last4">last 4: <span className="font-mono">{tr.recentEarningsMoves.join(", ")}</span></span>);
                    if (e.consensus?.avgTarget != null) {
                      bits.push(
                        <span key="pt">
                          Avg PT <span className="font-mono">${e.consensus.avgTarget}</span>
                          {e.consensus.avgTargetChangePct != null && (
                            <span className={`font-mono ${e.consensus.avgTargetChangePct < 0 ? "text-neg" : "text-pos"}`}>
                              {" "}{e.consensus.avgTargetChangePct > 0 ? "+" : ""}{e.consensus.avgTargetChangePct}%
                            </span>
                          )}
                          {e.consensus.impliedUpsidePct != null && <span className="text-ink-3"> · {e.consensus.impliedUpsidePct > 0 ? "+" : ""}{e.consensus.impliedUpsidePct}% upside</span>}
                        </span>,
                      );
                    }
                    if (e.consensus?.buyPct != null) {
                      bits.push(
                        <span key="mix">
                          {e.consensus.analystCount != null ? `${e.consensus.analystCount} analysts · ` : ""}
                          <span className="font-mono text-pos">B {e.consensus.buyPct}%</span>
                          {" / "}<span className="font-mono">H {e.consensus.holdPct ?? "?"}%</span>{" / "}
                          <span className="font-mono text-neg">S {e.consensus.sellPct ?? "?"}%</span>
                        </span>,
                      );
                    }
                    if (e.valuation?.ntmPe != null) {
                      bits.push(<span key="pe">NTM P/E <span className="font-mono">{e.valuation.ntmPe}x</span>{e.valuation.ntmPeFiveYrAvg != null ? <span className="text-ink-3"> vs 5y {e.valuation.ntmPeFiveYrAvg}x</span> : null}</span>);
                    }
                    if (e.estimateRevisions?.epsChangePct != null) {
                      bits.push(
                        <span key="est">
                          {e.estimateRevisions.period ?? "FY"} EPS{" "}
                          <span className={`font-mono ${e.estimateRevisions.epsChangePct < 0 ? "text-neg" : "text-pos"}`}>
                            {e.estimateRevisions.epsChangePct > 0 ? "+" : ""}{e.estimateRevisions.epsChangePct}%
                          </span>
                        </span>,
                      );
                    }
                    if (bits.length === 0) return null;
                    return (
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-2">
                        {bits}
                      </div>
                    );
                  })()}

                  {/* News flashes carry no analyst panel — the toggle would read
                      "Show per-firm views (0)" and open onto nothing. */}
                  {firms.length > 0 && (
                    <button
                      onClick={() => setOpenId(open ? null : e.id)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
                    >
                      <AppIcon name={open ? "chevU" : "chevD"} size={12} />
                      {open ? "Hide per-firm views" : `Show per-firm views (${firms.length})`}
                    </button>
                  )}

                  {open && (
                    <div className="mt-1.5 flex flex-col divide-y divide-line-soft">
                      {firms.map((f, i) => (
                        <div key={i} className="py-1.5 text-[12px] leading-[1.5]">
                          <div className="flex flex-wrap items-baseline gap-x-1.5">
                            <span className="font-medium text-ink">{f.firm}</span>
                            {f.analyst && <span className="text-ink-3">{f.analyst}</span>}
                            {f.rating && <span className="text-ink-2">{f.rating}</span>}
                            {f.target != null && (
                              <span className={`font-mono ${f.targetAction === "lowers" ? "text-neg" : f.targetAction === "raises" ? "text-pos" : "text-ink-2"}`}>
                                {f.priorTarget != null ? `$${f.priorTarget} → $${f.target}` : `PT $${f.target}`}
                              </span>
                            )}
                          </div>
                          {f.basis && <div className="text-ink-3">Basis: {f.basis}</div>}
                          {f.points && f.points.length > 0 && (
                            <ul className="list-disc pl-4 text-ink-2">
                              {f.points.map((p, j) => (
                                <li key={j}>{p}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
