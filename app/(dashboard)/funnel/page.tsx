"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { PipelineStages, buildStages, usePipelineData, type EntryRowLite } from "@/app/components/PipelineStages";
import { VERDICT_LABEL } from "@/app/lib/synthesis-screen-display";

/**
 * Pipeline (/funnel) — the one page that shows the idea pipeline as a PIPELINE:
 *
 *   Research (ranked lists) → Suggested (2+ lists) → Synthesis (AI base/bull/
 *   bear) → Watchlist → Portfolio → Underwritten (thesis + kill conditions)
 *   → monitored (thesis health, kill-condition sweep) → Review queue.
 *
 * Every number is read from the surface that owns it (same endpoints, no new
 * stores — see `usePipelineData`), so this page can never disagree with the
 * stage it summarises. It writes nothing.
 */

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] !text-ink-2 hover:bg-surface-hover hover:!text-ink";
const BTN22 = "inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] !text-ink-2 hover:bg-surface-hover hover:!text-ink";
const BTN22_NEG = "inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] !text-neg hover:bg-neg-soft";

function Panel({ title, count, sub, children, className = "" }: { title: string; count: number; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-h flex-wrap gap-y-1 py-1.5">
        <span className="t">
          {title} <span className="ml-1 font-mono text-[11.5px] font-normal text-ink-3">{count}</span>
        </span>
        {sub && <span className="m min-w-0 flex-1">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text, icon = "check" }: { text: string; icon?: string }) {
  return <EmptyState className="!py-6" glyph={<AppIcon name={icon} size={18} />} title={text} />;
}

const NameCell = ({ ticker, name }: { ticker: string; name?: string }) => (
  <td className="pl-3.5">
    <TickerLink ticker={ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(ticker)}</TickerLink>
    {name && <span className="ml-2 text-[12px] text-ink-3">{name}</span>}
  </td>
);

const Improving = () => (
  <span className="inline-flex items-center gap-0.5 text-pos">
    <AppIcon name="chevU" size={11} strokeWidth={2.25} />improving
  </span>
);

/** Entry-signal chips: met = ink-2, not met = faint + struck. */
function Signals({ r }: { r: EntryRowLite }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-mono text-[12px] font-medium text-pos" title={`${r.met} of ${r.known} known signals met`}>
        {r.met}<span className="text-ink-faint">/{r.known}</span>
      </span>
      {r.signals.filter((x) => x.status !== "unknown").map((x) => (
        <span key={x.key} className={`text-[11px] ${x.status === "met" ? "text-ink-2" : "text-ink-faint line-through"}`} title={x.reading}>{x.label}</span>
      ))}
    </span>
  );
}

export default function FunnelPage() {
  const d = usePipelineData();
  const stages = useMemo(() => buildStages(d), [d]);
  const {
    loading, entry, health, synthByTicker, awaitingSynthesis, readyToAdvance, thesisMissing,
    review, readyRows, buildingRows, watching, trippedCount,
  } = d;

  const reviewTone = review.some((r) => r.tone === "neg") ? "bg-neg" : review.length > 0 ? "bg-warn" : "bg-pos";

  return (
    <div className="flex flex-col gap-3.5">
      <PipelineStages stages={stages} loading={loading} />

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3">
        <a href="#review" className="inline-flex items-center gap-2 text-[12.5px] text-ink-2 hover:text-ink" title="Portfolio names whose thesis is under pressure">
          <span className={`dot ${reviewTone}`} />
          Review queue <span className="font-mono text-ink">{review.length}</span>
        </a>
        <span className="text-[11.5px] text-ink-3">
          {health?.counts.broken ?? 0} broken · {health?.counts.eroding ?? 0} eroding · {trippedCount} tripped
        </span>
        {loading && <span className="text-[11.5px] text-ink-3">Loading stages…</span>}
        <div className="ml-auto flex items-center gap-2">
          <Link href="/conviction" className={BTN}>
            Conviction ranking <AppIcon name="arrowR" size={13} strokeWidth={2} />
          </Link>
        </div>
      </div>

      {/* ── Review queue ── */}
      <div id="review" className="scroll-mt-24">
        <Panel title="Review queue" count={review.length} sub="Portfolio names whose thesis is under pressure — broken/eroding health, tripped kill conditions, an Exit-watch or Review synthesis, or an overdue re-underwrite. Leads to the Sell decision.">
          {review.length === 0 ? <Empty text="Nothing under review — every monitored thesis is intact." /> : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th className="pl-3.5">Name</th><th>Status</th><th>Why</th><th className="text-right pr-3.5">Action</th></tr></thead>
                <tbody>
                  {review.map((r) => (
                    <tr key={r.ticker}>
                      <NameCell ticker={r.ticker} name={r.name} />
                      <td className={r.tone === "neg" ? "text-neg" : "text-warn"}>
                        <span className={`dot mr-1.5 ${r.tone === "neg" ? "bg-neg" : "bg-warn"}`} />{r.tone === "neg" ? "Thesis tripped" : "Eroding"}
                      </td>
                      <td className="whitespace-normal py-2 text-[12px] text-ink-2">
                        <ul className="space-y-0.5">
                          {r.reasons.map((reason, i) => (
                            <li key={i} className={reason.includes("BROKEN") || reason.includes("tripped") || reason.includes("Exit watch") ? "text-neg" : ""}>{reason}</li>
                          ))}
                        </ul>
                      </td>
                      <td className="pr-3.5 text-right">
                        <span className="inline-flex gap-1">
                          <Link href={`/stock/${encodeURIComponent(r.ticker)}#thesis-tile`} className={BTN22}>Thesis</Link>
                          <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className={BTN22}>Synthesis</Link>
                          <Link href="/portfolio" className={BTN22_NEG}>Buy / Sell</Link>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ── Ready to buy: the entry scorecard's push ── */}
      <Panel title="Ready to buy" count={readyRows.length} sub={`Watchlist and Suggested names where ${5}+ entry signals are met (200-day, 50/200, no critical alert, SIA level/trend, Equate, MarketEdge, revisions, synthesis Advance, catalyst, list confluence). A flip into ready raises a HIGH alert in the digest.${entry ? ` Scanned ${entry.builtAt.slice(0, 16).replace("T", " ")}.` : ""}`}>
        {readyRows.length === 0 ? <Empty text="Nothing reads ready yet." icon="clock" /> : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="pl-3.5">Name</th><th>Stage</th><th>Signals</th><th>Why</th><th>Ready since</th><th className="text-right pr-3.5">Action</th></tr></thead>
              <tbody>
                {readyRows.map((r) => (
                  <tr key={r.ticker}>
                    <NameCell ticker={r.ticker} name={r.name} />
                    <td className="text-ink-2">{r.bucket}</td>
                    <td className="whitespace-normal py-2"><Signals r={r} /></td>
                    <td className="whitespace-normal py-2 text-[12px] text-ink-2">{r.why ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="text-[12px] text-ink-3">
                      {r.readySince ?? "—"}{r.readySince && entry?.newlyReady.includes(r.ticker) ? <span className="ml-1 text-pos">new</span> : null}
                    </td>
                    <td className="pr-3.5 text-right">
                      <span className="inline-flex gap-1">
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className={BTN22}>Synthesis</Link>
                        {r.bucket === "Watchlist" ? (
                          <Link href="/portfolio" className={BTN22}>Buy / Sell</Link>
                        ) : (
                          <Link href="/?bucket=Suggested" className={BTN22}>Advance</Link>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {buildingRows.length > 0 && (
          <div className="flex min-h-8 items-center border-t border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
            Building: {buildingRows.map((r) => `${displayTicker(r.ticker)} ${r.met}/${r.known}`).join(" · ")}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
        {/* ── Thesis required ── */}
        <Panel title="Thesis required" count={thesisMissing.length} sub="Portfolio positions with no kill conditions on file — unmonitored until underwritten.">
          {thesisMissing.length === 0 ? <Empty text="Every Portfolio stock is underwritten." icon="filecheck" /> : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th className="pl-3.5">Name</th><th>Status</th><th className="text-right pr-3.5">Action</th></tr></thead>
                <tbody>
                  {thesisMissing.map((m) => (
                    <tr key={m.ticker}>
                      <NameCell ticker={m.ticker} name={m.name} />
                      <td className="text-warn"><span className="dot mr-1.5 bg-warn" />{m.hasProse ? "Written, no kill conditions" : "No thesis"}</td>
                      <td className="pr-3.5 text-right">
                        <Link href={`/stock/${encodeURIComponent(m.ticker)}#thesis-tile`} className={BTN22}>Underwrite <AppIcon name="arrowR" size={11} strokeWidth={2} /></Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── Ready to advance ── */}
        <Panel title="Ready to advance" count={readyToAdvance.length} sub="Suggested names whose synthesis says Advance and that you haven't acted on yet.">
          {readyToAdvance.length === 0 ? <Empty text="No Advance verdicts waiting." /> : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th className="pl-3.5">Name</th><th>Why</th><th className="text-right pr-3.5">Action</th></tr></thead>
                <tbody>
                  {readyToAdvance.map((r) => (
                    <tr key={r.ticker}>
                      <NameCell ticker={r.displayTicker ?? r.ticker} />
                      <td className="max-w-[420px] truncate text-[12px] text-ink-2" title={r.entry?.result.verdictReason}>{r.entry?.result.verdictReason ?? r.name}</td>
                      <td className="pr-3.5 text-right">
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className={BTN22}>Decide <AppIcon name="arrowR" size={11} strokeWidth={2} /></Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── Awaiting synthesis ── */}
        <Panel title="Awaiting synthesis" count={awaitingSynthesis.length} sub="Suggested names with no synthesis yet (Watch-decided names excluded), strongest confluence first.">
          {awaitingSynthesis.length === 0 ? <Empty text="Every Suggested name has a synthesis." icon="spark" /> : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th className="pl-3.5">Name</th><th className="n">Lists</th><th>Reports</th><th className="text-right pr-3.5">Action</th></tr></thead>
                <tbody>
                  {awaitingSynthesis.map((r) => (
                    <tr key={r.key}>
                      <NameCell ticker={r.ticker} name={r.name || undefined} />
                      <td className="n">{r.listCount}{r.improving.length > 0 && <span className="ml-1.5 text-[11px]"><Improving /></span>}</td>
                      <td className="text-[12px] text-ink-2">
                        {r.reports
                          ? [r.reports.rbc && "RBC", r.reports.jpm && "JPM", r.reports.morningstar && "MS"].filter(Boolean).join(" / ")
                          : r.coverageRequestedAt
                            ? <span className="text-ink-3">Coverage requested, no report yet</span>
                            : <span className="text-ink-3">No report</span>}
                      </td>
                      <td className="pr-3.5 text-right">
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className={BTN22}>Generate <AppIcon name="arrowR" size={11} strokeWidth={2} /></Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── Watched (quiet) ── */}
        <Panel title="Watching (30-day quiet)" count={watching.length} sub="Suggested names you marked Watch — kept on the list, not nagged for a fresh synthesis until the memory expires.">
          {watching.length === 0 ? <Empty text="None." icon="eye" /> : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th className="pl-3.5">Name</th><th className="n">Lists</th><th>Verdict</th><th className="text-right pr-3.5">Until</th></tr></thead>
                <tbody>
                  {watching.map((r) => {
                    const s = synthByTicker.get(r.ticker.toUpperCase());
                    return (
                      <tr key={r.key}>
                        <NameCell ticker={r.ticker} name={r.name || undefined} />
                        <td className="n">{r.listCount}{r.improving.length > 0 && <span className="ml-1.5 text-[11px]"><Improving /></span>}</td>
                        <td className="text-[12px] text-ink-2">{s?.entry ? VERDICT_LABEL[s.entry.result.verdict] : <span className="text-ink-faint">—</span>}</td>
                        <td className="pr-3.5 text-right font-mono text-[12px] text-ink-3">{r.decision?.expiresOn}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
