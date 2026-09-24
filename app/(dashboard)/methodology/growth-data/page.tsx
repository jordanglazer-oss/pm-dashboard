"use client";

/**
 * /methodology/growth-data — the growth score's audit trail.
 *
 * Shows, for every company in the calibration universe: where each number
 * comes from (the exact FactSet formula), the raw inputs, how the four
 * measures are derived, each one's percentile inside its peer group, the blend
 * and the base score — all recomputed server-side by the same function the
 * score route uses. Pick any row to see the arithmetic written out, or download
 * the whole table as CSV to check against a FactSet terminal.
 *
 * Read-only: /api/growth-bands/detail never writes.
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

type MetricKey = "fwdSales" | "fwdEps" | "ltg" | "delivered";
type Metric = { value: number; percentile: number; weight: number; groupMedian: number | null };
type Row = {
  ticker: string; sector: string | null; industry: string | null; group: string;
  rankedIn: string; groupSize: number; foldedFrom: string | null;
  raw: Record<string, number | null | undefined>;
  metrics: Partial<Record<MetricKey, Metric>>;
  excluded: { metric: MetricKey; reason: string }[];
  blended: number | null; baseScore: number | null;
  topMark: { inTopBand: boolean; noMetricBelowMedian: boolean; clearsFloor: boolean; primaryForwardGrowth: number | null } | null;
};
type Source = { key: string; formula: string; label: string; meaning: string; unit: string };
type Resp = {
  stored: boolean; calibratedAt?: string; inSync?: boolean; universeSize?: number; droppedNoSector?: string[];
  sources?: Source[]; derivations?: Record<MetricKey, string>; metricLabels?: Record<MetricKey, string>;
  method?: { weights: Record<MetricKey, number>; cuts: { one: number; two: number; three: number }; topMarkFloorPct: number; minGroupSize: number; minEpsBase: number; basisBreakSalesPct: number; revisionTriggerPct: number; groupRules: Record<string, { note: string }> };
  rows?: Row[];
};

const METRICS: MetricKey[] = ["fwdSales", "fwdEps", "ltg", "delivered"];
const SHORT: Record<MetricKey, string> = { fwdSales: "Forward sales", fwdEps: "Forward EPS", ltg: "3–5y estimate", delivered: "Delivered 3y" };
const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

function toCsv(rows: Row[], sources: Source[]): string {
  const rawKeys = sources.map((s) => s.key);
  const head = ["ticker", "sector", "industry", "peer_group", "ranked_in", "group_size", ...rawKeys, ...METRICS.map((m) => `${m}_pct`), ...METRICS.map((m) => `${m}_percentile`), "blended_percentile", "base_score", "not_used"];
  const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map((r) => [
    r.ticker, r.sector, r.industry, r.group, r.rankedIn, r.groupSize,
    ...rawKeys.map((k) => r.raw[k] ?? ""),
    ...METRICS.map((m) => (r.metrics[m] ? r.metrics[m]!.value.toFixed(2) : "")),
    ...METRICS.map((m) => (r.metrics[m] ? r.metrics[m]!.percentile.toFixed(1) : "")),
    r.blended ?? "", r.baseScore ?? "", r.excluded.map((e) => `${e.metric}: ${e.reason}`).join(" | "),
  ].map(cell).join(","));
  return [head.join(","), ...lines].join("\n");
}

/** The arithmetic for one company, written out line by line. */
function WorkedExample({ row, data }: { row: Row; data: Resp }) {
  const r = row.raw; const m = data.method!;
  const salesBase = typeof r.salesLtmA === "number" && r.salesLtmA > 0 ? r.salesLtmA : r.salesLtm;
  const usedAsReported = salesBase === r.salesLtm && !(typeof r.salesLtmA === "number" && r.salesLtmA > 0);
  const banky = !!m.groupRules[row.group] && /book value/i.test(m.groupRules[row.group].note);
  const lines: { label: string; text: string }[] = [];
  if (row.metrics.fwdSales) lines.push({ label: SHORT.fwdSales, text: `(${num(r.salesNtm)} − ${num(salesBase)}) ÷ ${num(salesBase)} = ${pct(row.metrics.fwdSales.value)}${usedAsReported ? "  (as-reported trailing sales used: the estimates-basis figure was missing)" : ""}` });
  if (row.metrics.fwdEps) lines.push({ label: SHORT.fwdEps, text: `(${num(r.epsNtm)} − ${num(r.epsLtmA)}) ÷ ${num(r.epsLtmA)} = ${pct(row.metrics.fwdEps.value)}` });
  if (row.metrics.ltg) lines.push({ label: SHORT.ltg, text: `${pct(row.metrics.ltg.value)} a year, taken directly from FactSet` });
  if (row.metrics.delivered) lines.push({ label: SHORT.delivered, text: banky ? `(${num(r.bpsAnn0)} ÷ ${num(r.bpsAnn3)}) ^ (1/3) − 1 = ${pct(row.metrics.delivered.value)} a year, on book value per share` : `(${num(r.salesAnn0)} ÷ ${num(r.salesAnn3)}) ^ (1/3) − 1 = ${pct(row.metrics.delivered.value)} a year, on sales` });
  const used = METRICS.filter((k) => row.metrics[k]);
  return (
    <div className="rounded border border-line bg-surface p-4 text-[13px] leading-relaxed text-ink-2">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <span className="text-[15px] font-semibold text-ink">{row.ticker}</span>
        <span>{row.industry ?? "—"} · {row.sector ?? "—"}</span>
        <Link href={`/stock/${encodeURIComponent(row.ticker)}`} className="text-accent hover:underline">open stock page</Link>
      </div>
      <p>Ranked in <b className="font-medium text-ink">{row.rankedIn}</b> ({row.groupSize} companies){row.foldedFrom ? `; its own group, ${row.foldedFrom}, has too few names to rank in` : ""}.{m.groupRules[row.group] ? ` ${m.groupRules[row.group].note}` : ""}</p>

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">1 · Raw FactSet inputs</h4>
      <div className="overflow-x-auto"><table className="text-[12px]"><tbody>
        {(data.sources ?? []).map((s) => (
          <tr key={s.key} className="border-b border-line"><td className="py-0.5 pr-4 text-ink">{s.label}</td><td className="pr-4 text-right tabular-nums">{num(r[s.key] as number | null)}</td><td className="font-mono text-[11px] text-ink-3">{s.formula}</td></tr>
        ))}
      </tbody></table></div>

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">2 · The four measures</h4>
      <ul className="flex flex-col gap-0.5">
        {lines.map((l) => <li key={l.label}><span className="text-ink">{l.label}:</span> <span className="tabular-nums">{l.text}</span></li>)}
        {row.excluded.map((e, i) => <li key={i} className="text-ink-3"><span className="text-ink-2">{SHORT[e.metric]}:</span> not used — {e.reason}</li>)}
      </ul>

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">3 · Rank within the group, then blend</h4>
      {used.length < 2 ? <p className="text-warn">Fewer than two usable measures, so no score is computed: growth is parked as a data gap.</p> : (
        <>
          <ul className="flex flex-col gap-0.5">
            {used.map((k) => { const x = row.metrics[k]!; return <li key={k} className="tabular-nums"><span className="text-ink">{SHORT[k]}:</span> {pct(x.value)} is the {x.percentile.toFixed(0)}th percentile (group median {pct(x.groupMedian)}) × weight {(x.weight * 100).toFixed(0)}% = {(x.percentile * x.weight).toFixed(1)}</li>; })}
          </ul>
          <p className="mt-1 tabular-nums">Blended percentile = {used.map((k) => (row.metrics[k]!.percentile * row.metrics[k]!.weight).toFixed(1)).join(" + ")} = <b className="font-medium text-ink">{row.blended}</b>{used.length < 4 ? " (weights re-scaled over the measures that apply)" : ""}</p>
          <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">4 · Base score</h4>
          <p>Below {m.cuts.one} scores 0, below {m.cuts.two} scores 1, below {m.cuts.three} scores 2. At {m.cuts.three} or above a 3 also needs: no measure below its group median ({row.topMark?.noMetricBelowMedian ? "passes" : "fails"}) and forward growth of at least {m.topMarkFloorPct}% ({row.topMark?.clearsFloor ? "passes" : "fails"}, at {pct(row.topMark?.primaryForwardGrowth)}). Negative forward growth scores 0.</p>
          <p className="mt-1">Base score for {row.ticker}: <b className="text-[15px] font-semibold text-ink">{row.baseScore} / 3</b>. At rescore time one more step applies: next year&apos;s consensus moving more than ±{m.revisionTriggerPct}% in three months moves this by one point. That figure is read live for each rescore and shown on the stock page, not here.</p>
        </>
      )}
    </div>
  );
}

export default function GrowthDataPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"ticker" | "blended" | MetricKey>("ticker");
  const [picked, setPicked] = useState<string | null>(null); // row selection — deliberately transient
  const [sourcesOpen, toggleSources] = usePersistedOpen("methodology.growthData.sources", true);

  useEffect(() => { fetch("/api/growth-bands/detail").then((r) => r.json()).then(setData).catch(() => setData({ stored: false })); }, []);

  const groups = useMemo(() => { const c = new Map<string, number>(); for (const r of data?.rows ?? []) c.set(r.group, (c.get(r.group) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]); }, [data]);
  const rows = useMemo(() => {
    let rs = data?.rows ?? [];
    if (group !== "all") rs = rs.filter((r) => r.group === group);
    const needle = q.trim().toUpperCase();
    if (needle) rs = rs.filter((r) => r.ticker.toUpperCase().includes(needle));
    const key = (r: Row) => (sort === "ticker" ? 0 : sort === "blended" ? r.blended ?? -1 : r.metrics[sort]?.value ?? -1e9);
    return [...rs].sort((a, b) => (sort === "ticker" ? a.ticker.localeCompare(b.ticker) : key(b) - key(a)));
  }, [data, group, q, sort]);
  const pickedRow = useMemo(() => (data?.rows ?? []).find((r) => r.ticker === picked) ?? null, [data, picked]);

  function download() {
    if (!data?.rows || !data.sources) return;
    const blob = new Blob([toCsv(rows, data.sources)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `growth-score-data-${(data.calibratedAt ?? "").slice(0, 10)}${group === "all" ? "" : "-" + group.replace(/[^a-z0-9]+/gi, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!data) return <div className="mx-auto max-w-6xl px-4 py-8 text-ink-2">Loading the growth data…</div>;
  if (!data.stored) return (
    <div className="mx-auto max-w-3xl px-4 py-8 text-ink-2">
      <h1 className="text-2xl font-semibold text-ink">Growth score data</h1>
      <p className="mt-3 text-warn">The company-level data has not been stored yet. It is written when the growth calibration is run with confirmation; run it once and this page fills in.</p>
    </div>
  );
  const m = data.method!;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 text-ink">
      <p className="text-[12px]"><Link href="/methodology#growth-score" className="text-accent hover:underline">← Methodology</Link></p>
      <h1 className="mt-1 text-2xl font-semibold">Growth score data</h1>
      <p className="mt-2 max-w-[78ch] text-[14px] leading-relaxed text-ink-2">
        Every number behind the growth score: where it comes from, how it is turned into the four measures, and where each company ranks.
        Pulled from FactSet on <b className="font-medium text-ink">{data.calibratedAt?.slice(0, 10)}</b> for <b className="font-medium text-ink">{data.universeSize}</b> companies (S&amp;P 500 and TSX 60).
        The figures below are recomputed by the same code the scoring uses, so this page cannot drift from what a rescore does. Pick any company to see its arithmetic; download the table to check figures against your terminal.
      </p>
      {data.inSync === false && <p className="mt-2 text-warn">The stored bands and this company data come from different calibration runs. Re-run the calibration to bring them back in step.</p>}

      {/* Where it comes from */}
      <section className="mt-6 rounded border border-line bg-surface">
        <button type="button" onClick={toggleSources} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[14px] font-semibold hover:bg-surface-hover">
          <span>Where each number comes from, and how it is calculated</span><span className="font-mono text-[11px] text-ink-3">{sourcesOpen ? "hide" : "show"}</span>
        </button>
        {sourcesOpen && (
          <div className="flex flex-col gap-4 border-t border-line px-4 py-4 text-[13px] leading-relaxed text-ink-2">
            <div>
              <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-accent">Raw inputs — the exact FactSet formulas</h3>
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[12.5px]">
                <thead><tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-ink-3"><th className="py-1 pr-3">Input</th><th className="px-3">FactSet formula</th><th className="px-3">What it is</th><th className="pl-3">Unit</th></tr></thead>
                <tbody>{(data.sources ?? []).map((s) => (
                  <tr key={s.key} className="border-b border-line align-top"><td className="py-1.5 pr-3 text-ink">{s.label}</td><td className="px-3 font-mono text-[11.5px] text-ink">{s.formula}</td><td className="px-3">{s.meaning}</td><td className="pl-3 text-ink-3">{s.unit}</td></tr>
                ))}</tbody>
              </table></div>
              <p className="mt-1 text-ink-3">Type any of these formulas into FactSet against a ticker to reproduce a figure. Sector and industry come from <span className="font-mono">FG_GICS_SECTOR</span> and <span className="font-mono">FG_GICS_INDUSTRY</span> and decide the peer group.</p>
            </div>
            <div>
              <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-accent">The four measures</h3>
              <ul className="flex flex-col gap-1.5">{METRICS.map((k) => <li key={k}><b className="font-medium text-ink">{data.metricLabels?.[k] ?? SHORT[k]}</b> (weight {(m.weights[k] * 100).toFixed(0)}%). {data.derivations?.[k]}</li>)}</ul>
            </div>
            <div>
              <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-accent">From measures to a score</h3>
              <p>Each measure is ranked as a percentile among the companies in the same peer group (a group under {m.minGroupSize} names is ranked within its sector instead; values are capped at the group&apos;s 2nd and 98th percentiles so one outlier cannot stretch the scale). The percentiles are blended by the weights above; if a measure does not apply, the remaining weights are re-scaled to add to 100%. Blend below {m.cuts.one} = 0, below {m.cuts.two} = 1, below {m.cuts.three} = 2. A 3 needs a blend of {m.cuts.three} or more, no measure below its group median, and forward growth of at least {m.topMarkFloorPct}%. Then, at rescore time, a consensus revision of more than ±{m.revisionTriggerPct}% in three months moves the score one point (an upward revision can only produce a 3 when the last two tests pass), and the AI may move it one further point for a stated reason.</p>
            </div>
            {(data.droppedNoSector?.length ?? 0) > 0 && <p className="text-ink-3">Left out because FactSet no longer covers them (acquired or taken private): {data.droppedNoSector!.join(", ")}.</p>}
          </div>
        )}
      </section>

      {/* Controls */}
      <div className="mt-6 flex flex-wrap items-end gap-3 text-[13px]">
        <label className="flex flex-col gap-1"><span className="text-[11px] uppercase tracking-wide text-ink-3">Peer group</span>
          <select id="growth-data-group" value={group} onChange={(e) => setGroup(e.target.value)} className="rounded border border-line bg-surface px-2 py-1.5">
            <option value="all">All groups ({data.universeSize})</option>
            {groups.map(([g, n]) => <option key={g} value={g}>{g} ({n})</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] uppercase tracking-wide text-ink-3">Find a ticker</span>
          <input id="growth-data-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. NVDA" className="w-32 rounded border border-line bg-surface px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] uppercase tracking-wide text-ink-3">Sort by</span>
          <select id="growth-data-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded border border-line bg-surface px-2 py-1.5">
            <option value="ticker">Ticker</option><option value="blended">Blended percentile</option>
            {METRICS.map((k) => <option key={k} value={k}>{SHORT[k]}</option>)}
          </select></label>
        <button type="button" onClick={download} className="rounded border border-line bg-surface px-3 py-1.5 font-medium hover:bg-surface-hover">Download {rows.length} rows as CSV</button>
      </div>

      {pickedRow && <div className="mt-4"><WorkedExample row={pickedRow} data={data} /></div>}

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded border border-line bg-surface">
        <table className="w-full min-w-[860px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-2">Ticker</th><th className="px-2">Peer group</th>
              {METRICS.map((k) => <th key={k} className="px-2 text-right">{SHORT[k]}<div className="font-normal normal-case tracking-normal">value · percentile</div></th>)}
              <th className="px-2 text-right">Blended</th><th className="px-3 text-right">Base score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker} onClick={() => setPicked(picked === r.ticker ? null : r.ticker)} className={`cursor-pointer border-b border-line hover:bg-surface-hover ${picked === r.ticker ? "bg-accent-soft" : ""}`}>
                <td className="px-3 py-1.5 font-medium">{r.ticker}</td>
                <td className="px-2 text-ink-2">{r.group}{r.foldedFrom ? <span className="text-ink-3"> → ranked in {r.rankedIn}</span> : null}</td>
                {METRICS.map((k) => { const x = r.metrics[k]; return <td key={k} className="px-2 text-right tabular-nums">{x ? <>{pct(x.value)} <span className="text-ink-3">· {x.percentile.toFixed(0)}</span></> : <span className="text-ink-3" title={r.excluded.find((e) => e.metric === k)?.reason}>not used</span>}</td>; })}
                <td className="px-2 text-right tabular-nums">{r.blended ?? "—"}</td>
                <td className="px-3 text-right tabular-nums font-medium">{r.baseScore ?? <span className="font-normal text-ink-3">gap</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">Click a row to see that company&apos;s arithmetic. “Not used” shows its reason on hover and in the worked example. Base score is before the live estimate-revision step.</p>
    </div>
  );
}
