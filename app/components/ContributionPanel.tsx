"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { RangeAttributionResponse } from "@/app/lib/range-attribution-load";
import type { HoldingContribution, Sleeve } from "@/app/lib/range-attribution";

/**
 * Contribution by holding (Nov 2026) — what added and what detracted over ANY
 * date range, for the PIM equity book, by sleeve, with the top 5 contributors
 * and detractors. Names sold inside the range are included for the days they
 * were held. READ-ONLY (GET /api/attribution/range); a model-level estimate,
 * shown next to the recorded return so the gap is visible.
 */

type Preset = "mtd" | "qtd" | "ytd" | "1y" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "Since start" },
  { key: "custom", label: "Custom" },
];
const SLEEVES: { key: "all" | Sleeve; label: string }[] = [
  { key: "all", label: "All" },
  { key: "core", label: "Core" },
  { key: "thematic", label: "Managed Alpha" },
  { key: "stocks", label: "Individual Stocks" },
];
/** Above this many points between the rebuilt estimate and the recorded return, the holding split is flagged. */
const GAP_WARN_PTS = 1.5;
const SLEEVE_LABEL: Record<Sleeve, string> = { core: "Core", thematic: "Managed Alpha", stocks: "Individual Stocks" };

const iso = (d: Date) => d.toISOString().slice(0, 10);
function rangeFor(p: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const today = iso(now);
  if (p === "custom") return { from: custom.from, to: custom.to };
  if (p === "all") return { from: "", to: "" };
  if (p === "mtd") return { from: `${today.slice(0, 7)}-01`, to: "" };
  if (p === "ytd") return { from: `${now.getFullYear()}-01-01`, to: "" };
  if (p === "qtd") return { from: iso(new Date(Date.UTC(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1))), to: "" };
  const y = new Date(now);
  y.setFullYear(y.getFullYear() - 1);
  return { from: iso(y), to: "" };
}

const pts = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`);
const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

function MoverList({ title, rows, empty }: { title: string; rows: HoldingContribution[]; empty: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</div>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.symbol} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium">{r.symbol}</span>
                <span className="text-ink-3"> · {SLEEVE_LABEL[r.sleeve]}{r.status === "closed" ? " · sold" : ""}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                <span className={`font-medium ${tone(r.contributionPct)}`}>{pts(r.contributionPct)}</span>
                <span className="text-[11.5px] text-ink-3"> ({pts(r.returnPct, 1)} at {r.avgWeightPct.toFixed(1)}%)</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Everything below the date controls: sleeve filter, summary sentence, top 5 /
 *  bottom 5, sleeve table, full table, caveats. Presentational — the caller
 *  owns the date range and the fetch (so a merged panel can load it once). */
export function ContributionView({ data, loading }: { data: RangeAttributionResponse | null; loading: boolean }) {
  const [sleeve, setSleeve] = useState<"all" | Sleeve>("all");
  const [showAll, toggleAll] = usePersistedOpen("perf.contribution.table", false);
  const [showNotes, toggleNotes] = usePersistedOpen("perf.contribution.notes", false);
  const view = useMemo(() => {
    if (!data || !data.ok) return null;
    const rows = sleeve === "all" ? data.holdings : data.holdings.filter((h) => h.sleeve === sleeve);
    return {
      rows,
      top: rows.filter((r) => r.contributionPct > 0).slice(0, 5),
      bottom: rows.filter((r) => r.contributionPct < 0).slice(-5).reverse(),
      total: rows.reduce((s, r) => s + r.contributionPct, 0),
    };
  }, [data, sleeve]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
        <div className="seg">
          {SLEEVES.map((s) => (
            <button key={s.key} className={sleeve === s.key ? "on" : ""} onClick={() => setSleeve(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        {loading && <span className="text-[12px] text-ink-3">Loading prices…</span>}
      </div>
      {!data ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
      ) : !data.ok ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">{data.error}</p>
      ) : view ? (
        <div className={loading ? "opacity-60" : ""}>
          {data.detailFrom && (
            <div className="mx-3.5 mt-2.5 rounded-control border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
              <span className="font-semibold text-ink">Holding detail starts {data.detailFrom}.</span> The trade log begins that day, so what was held earlier is not on file. Everything in this section covers {data.range.base} to {data.range.end} ({data.range.days} trading days); the recorded return for that same stretch is <span className="font-medium">{pts(data.reconciliation.book.recordedPct)}</span>. The summary above covers the whole period.
            </div>
          )}
          {(() => {
            const gap = data.reconciliation.book.differencePts;
            const off = gap != null && Math.abs(gap) >= GAP_WARN_PTS;
            return (
              <>
                {off && (
                  <div className="mx-3.5 mt-2.5 rounded-control border border-warn-border bg-warn-soft px-3 py-2 text-[12.5px] text-ink">
                    <span className="font-semibold">Treat the holding figures below with caution for this period.</span> They add up to {pts(data.estimatedReturnPct)}, but the recorded return is {pts(data.reconciliation.book.recordedPct)} — a gap of {Math.abs(gap!).toFixed(2)} points. The sleeve &quot;Recorded&quot; column is exact; the per-holding split is an estimate rebuilt from the trade log.
                    {data.byMonth.length > 1 && (
                      <div className="mt-2 overflow-x-auto">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Where the gap arises · estimate vs record, month by month</div>
                        <table className="w-full min-w-[560px] text-[12px] tabular-nums">
                          <thead>
                            <tr className="text-left text-[11px] text-ink-3">
                              <th className="font-normal">Month</th>
                              <th className="text-right font-normal">Book est.</th>
                              <th className="text-right font-normal">Book rec.</th>
                              <th className="text-right font-normal">Core est.</th>
                              <th className="text-right font-normal">Core rec.</th>
                              <th className="text-right font-normal">Total Alpha est.</th>
                              <th className="text-right font-normal">Total Alpha rec.</th>
                              <th className="text-right font-normal">Alpha gap</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.byMonth.map((m) => {
                              const g = m.nonCore.est != null && m.nonCore.rec != null ? m.nonCore.est - m.nonCore.rec : null;
                              return (
                                <tr key={m.month}>
                                  <td>{m.month}</td>
                                  <td className="text-right">{pts(m.book.est)}</td>
                                  <td className="text-right">{pts(m.book.rec)}</td>
                                  <td className="text-right">{pts(m.core.est)}</td>
                                  <td className="text-right">{pts(m.core.rec)}</td>
                                  <td className="text-right">{pts(m.nonCore.est)}</td>
                                  <td className="text-right">{pts(m.nonCore.rec)}</td>
                                  <td className="text-right">
                                    <span className={g != null && Math.abs(g) >= 2 ? "font-semibold text-neg" : "text-ink-3"}>{g == null ? "—" : `${g > 0 ? "+" : ""}${g.toFixed(2)} pts`}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
                <p className="px-3.5 pt-2.5 text-[12.5px] text-ink-3">
                  {data.range.base} close to {data.range.end} close · {data.range.days} trading day{data.range.days === 1 ? "" : "s"}
                  {sleeve !== "all" && (
                    <>
                      {" "}· {SLEEVE_LABEL[sleeve]} contributed an estimated <span className={`font-medium ${tone(view.total)}`}>{pts(view.total)}</span>
                    </>
                  )}
                  {!off && gap != null && <> · holdings add up to {pts(data.estimatedReturnPct)} vs {pts(data.reconciliation.book.recordedPct)} recorded</>}
                </p>
              </>
            );
          })()}

          <div className="flex flex-col gap-4 px-3.5 py-3 sm:flex-row sm:gap-8">
            <MoverList title="Top 5 contributors" rows={view.top} empty="Nothing added over this period." />
            <MoverList title="Top 5 detractors" rows={view.bottom} empty="Nothing detracted over this period." />
          </div>

          <div className="tbl-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Sleeve</th>
                  <th className="n">Recorded return</th>
                  <th className="n">Avg weight</th>
                  <th className="n">Est. contribution</th>
                  <th className="n">Est. return</th>
                  <th className="n">Est. vs recorded</th>
                </tr>
              </thead>
              <tbody>
                {data.sleeves.map((s) => {
                  const rec = data.reconciliation.sleeves.find((x) => x.sleeve === s.sleeve);
                  return (
                    <tr key={s.sleeve}>
                      <td className="pl-3.5">
                        <span className="font-medium">{s.label}</span>
                        <span className="text-[11.5px] text-ink-3"> · {s.holdings} holding{s.holdings === 1 ? "" : "s"}</span>
                      </td>
                      <td className={`n font-medium ${tone(rec?.recordedPct)}`}>{rec?.recordedPct == null ? <span className="text-[11.5px] font-normal text-ink-3">{s.sleeve === "core" ? "not recorded" : "within Total Alpha"}</span> : pts(rec.recordedPct)}</td>
                      <td className="n">{s.avgWeightPct.toFixed(1)}%</td>
                      <td className={`n ${tone(s.contributionPct)}`}>{pts(s.contributionPct)}</td>
                      <td className={`n ${tone(s.returnPct)}`}>{pts(s.returnPct)}</td>
                      <td className="n text-ink-3">{rec?.differencePts == null ? "—" : `${rec.differencePts > 0 ? "+" : ""}${rec.differencePts.toFixed(2)} pts`}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="pl-3.5">
                    <span className="font-medium">Total Alpha</span>
                    <span className="text-[11.5px] text-ink-3"> · Managed Alpha + Individual Stocks</span>
                  </td>
                  <td className={`n font-medium ${tone(data.reconciliation.nonCore.recordedPct)}`}>{pts(data.reconciliation.nonCore.recordedPct)}</td>
                  <td className="n">{data.nonCore.avgWeightPct.toFixed(1)}%</td>
                  <td className={`n ${tone(data.nonCore.contributionPct)}`}>{pts(data.nonCore.contributionPct)}</td>
                  <td className={`n ${tone(data.nonCore.returnPct)}`}>{pts(data.nonCore.returnPct)}</td>
                  <td className="n text-ink-3">{data.reconciliation.nonCore.differencePts == null ? "—" : `${data.reconciliation.nonCore.differencePts > 0 ? "+" : ""}${data.reconciliation.nonCore.differencePts.toFixed(2)} pts`}</td>
                </tr>
                <tr>
                  <td className="pl-3.5 font-medium">Equity book</td>
                  <td className={`n font-medium ${tone(data.reconciliation.book.recordedPct)}`}>{pts(data.reconciliation.book.recordedPct)}</td>
                  <td className="n">{data.avgWeightCoveredPct.toFixed(1)}%</td>
                  <td className={`n ${tone(data.estimatedReturnPct)}`}>{pts(data.estimatedReturnPct)}</td>
                  <td className={`n ${tone(data.estimatedReturnPct)}`}>{pts(data.estimatedReturnPct)}</td>
                  <td className="n text-ink-3">{data.reconciliation.book.differencePts == null ? "—" : `${data.reconciliation.book.differencePts > 0 ? "+" : ""}${data.reconciliation.book.differencePts.toFixed(2)} pts`}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="px-3.5 pt-1.5 text-[11.5px] text-ink-3">
            &quot;Recorded return&quot; is the dashboard&apos;s own performance record for the same days and is exact. The &quot;Est.&quot; columns are rebuilt from model weights and prices; the last column is how far that rebuild is from the record.
            {data.reconciliation.sleevesRecordedFrom && data.range.base < data.reconciliation.sleevesRecordedFrom && <> Managed Alpha and Individual Stocks have been recorded separately only since {data.reconciliation.sleevesRecordedFrom}; before that they were recorded together, so for this period compare them on the Total Alpha row.</>}

          </p>

          <div className="px-3.5 py-2.5">
            <button onClick={toggleAll} className="text-[12.5px] font-medium text-ink-2 underline decoration-line underline-offset-2">
              {showAll ? "Hide the full table" : `Show every holding (${view.rows.length})`}
            </button>
          </div>
          {showAll && (
            <div className="tbl-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Holding</th>
                    <th>Sleeve</th>
                    <th className="n">Contribution</th>
                    <th className="n">Return (C$)</th>
                    <th className="n">Avg weight</th>
                    <th>Held</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r) => (
                    <tr key={r.symbol}>
                      <td className="pl-3.5">
                        <span className="font-medium">{r.symbol}</span>
                        {r.name ? <span className="text-[11.5px] text-ink-3"> · {r.name}</span> : null}
                        {r.notes.length > 0 && <div className="text-[11px] text-warn">Assumption: {r.notes.join("; ")}</div>}
                      </td>
                      <td className="text-[12px]">{SLEEVE_LABEL[r.sleeve]}</td>
                      <td className={`n ${tone(r.contributionPct)}`}>{pts(r.contributionPct)}</td>
                      <td className={`n ${tone(r.returnPct)}`}>{pts(r.returnPct)}</td>
                      <td className="n">{r.avgWeightPct.toFixed(2)}%</td>
                      <td className="text-[12px] text-ink-3">
                        {r.status === "closed" ? `sold · held to ${r.heldTo}` : r.openedInRange ? `bought · from ${r.heldFrom}` : "whole period"}
                        {` · ${r.daysHeld}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="px-3.5 pb-3 pt-1">
            <button onClick={toggleNotes} className="text-[12.5px] font-medium text-ink-2 underline decoration-line underline-offset-2">
              {showNotes ? "Hide how this is calculated" : `How this is calculated (${data.caveats.length} notes)`}
            </button>
            {showNotes && (
              <ul className="mt-1.5 list-disc pl-4 text-[11.5px] leading-snug text-ink-3">
                {data.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ContributionPanel() {
  const [preset, setPreset] = useState<Preset>("mtd");
  const [custom, setCustom] = useState({ from: "", to: "" });
  // The last answer, tagged with the range it is for: "loading" is simply
  // "the answer on screen is for a different range than the one selected".
  const [res, setRes] = useState<{ key: string; data: RangeAttributionResponse } | null>(null);

  const range = rangeFor(preset, custom);
  const ready = preset !== "custom" || !custom.from || !custom.to || custom.from <= custom.to;
  const key = `${range.from}|${range.to}`;
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const q = new URLSearchParams();
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    const tag = `${range.from}|${range.to}`;
    fetch(`/api/attribution/range?${q.toString()}`)
      .then((r) => r.json())
      .then((j: RangeAttributionResponse) => {
        if (!stop) setRes({ key: tag, data: j });
      })
      .catch(() => {
        if (!stop) setRes({ key: tag, data: { ok: false, error: "Could not load the contribution data." } });
      });
    return () => {
      stop = true;
    };
  }, [range.from, range.to, ready]);
  const data = res?.data ?? null;
  const loading = ready && res?.key !== key;

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Contribution by holding</span>
        <span className="m">Model-level estimate · PIM equity book · weight × C$ total return, names sold in the period included</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.key} className={preset === p.key ? "on" : ""} onClick={() => setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
            From
            <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
            to
            <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
            <span className="text-ink-faint">(empty &quot;from&quot; = from the start; empty &quot;to&quot; = today)</span>
          </span>
        )}
      </div>
      <ContributionView data={data} loading={loading} />
    </section>
  );
}
