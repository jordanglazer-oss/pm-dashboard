"use client";

/**
 * /methodology/scoring-shadow — the scoring-bias fixes shown BESIDE the live
 * score, for every individual stock in the book.
 *
 * Read-only: /api/scoring-shadow writes nothing and calls no model. No score,
 * rating or history entry changes because this page was opened. Row selection
 * and sort order are deliberately transient (not saved).
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ShiftRow = { label: string; names: number; avgCurrent: number; avgShadow: number; avgShift: number; up: number; down: number };
type Component = { metric: string; label: string; value: number; percentile: number; weight: number; groupMedian: number | null };
type Working = {
  rankedIn: string; groupSize: number; foldedFrom: string | null; groupNote: string | null; returnsBasis: string;
  components: Component[]; excluded: { metric: string; reason: string }[]; blendedPercentile: number | null; computedScore: number | null; gapReason: string | null;
  topMark: { inTopBand: boolean; returnsAtOrAboveMedian: boolean; clearsFloor: boolean } | null;
};
type Row = {
  ticker: string; name: string; bucket: string; sector: string; country: string; size: string; marketCapM: number | null;
  current: number; shadow: number; shift: number; matchesLive: boolean;
  byFix: { revisions: number; noData: number; mentions: number; quality: number };
  analystConsensus: { stored: number; shadow: number | null; level: { onFile: string[]; missing: string[]; earned: number; outOf: number; rescaled: number } | null; revisions: { up: number; down: number; net: number; analysts: number | null; share: number | null; contribution: number; currentRuleContribution: number; basis: string } | null; morningstar: number };
  researchMentions: { stored: number; shadow: number; on: string[]; eligibleBullish: number; referenceBullish: number; multiplier: number; bearishOn: number };
  returnsMargins: { stored: number; shadow: number | null; status: string; working: Working | null };
};
type Resp = {
  error?: string; mode?: string; names?: number; liveNote?: string | null; compositeCheck?: string;
  qualityBands?: { calibratedAt: string; universeSize: number; inSync: boolean } | null;
  summary?: { byCountry: ShiftRow[]; bySize: ShiftRow[]; byCountryAndSize: ShiftRow[]; note: string };
  notComputed?: { thinCoverage: string };
  rows?: Row[];
};

type SortKey = "ticker" | "country" | "size" | "current" | "shadow" | "shift";
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number) => (n > 0.05 ? "text-pos" : n < -0.05 ? "text-neg" : "text-ink-3");

function SummaryTable({ title, rows }: { title: string; rows: ShiftRow[] }) {
  return (
    <div className="rounded border border-line bg-surface p-3">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-accent">{title}</h3>
      <table className="mt-1.5 w-full text-[12.5px] tabular-nums">
        <thead><tr className="text-left text-ink-3"><th className="font-normal">Group</th><th className="text-right font-normal">Names</th><th className="text-right font-normal">Today</th><th className="text-right font-normal">Shadow</th><th className="text-right font-normal">Shift</th><th className="text-right font-normal">Up / down</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-line">
              <td className="py-0.5 pr-3 text-ink">{r.label}</td><td className="text-right">{r.names}</td><td className="text-right">{r.avgCurrent.toFixed(1)}</td><td className="text-right">{r.avgShadow.toFixed(1)}</td>
              <td className="text-right"><span className={tone(r.avgShift)}>{signed(r.avgShift)}</span></td><td className="text-right text-ink-2">{r.up} / {r.down}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ r }: { r: Row }) {
  const ac = r.analystConsensus, rm = r.researchMentions, q = r.returnsMargins;
  return (
    <div className="rounded border border-line bg-surface p-4 text-[13px] leading-relaxed text-ink-2">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <span className="text-[15px] font-semibold text-ink">{r.ticker}</span><span>{r.name}</span>
        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="text-accent hover:underline">open stock page</Link>
      </div>
      <p>Today <b className="font-medium text-ink">{r.current.toFixed(1)}</b> of 33 · with every fix <b className="font-medium text-ink">{r.shadow.toFixed(1)}</b> (<span className={tone(r.shift)}>{signed(r.shift)}</span>). Each fix on its own: revisions {signed(r.byFix.revisions)}, missing report as no data {signed(r.byFix.noData)}, research lists {signed(r.byFix.mentions)}, peer-ranked quality {signed(r.byFix.quality)}.</p>
      {!r.matchesLive && <p className="text-warn">This row&apos;s &quot;today&quot; figure does not match the app&apos;s own calculation — treat it with caution.</p>}

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">Analyst consensus — stored {ac.stored} · shadow {ac.shadow == null ? "no data" : ac.shadow}</h4>
      {ac.level ? <p>On file: {ac.level.onFile.join(", ")}{ac.level.missing.length ? `; not on file: ${ac.level.missing.join(", ")}` : ""}. Earned {ac.level.earned} of {ac.level.outOf}, rescaled to {ac.level.rescaled} of 2.25.</p> : <p>No rating and no street target on file, so the category leaves the composite instead of counting as zero.</p>}
      {ac.revisions ? <p>Revisions: {ac.revisions.up} up, {ac.revisions.down} down{ac.revisions.analysts != null ? ` of ${ac.revisions.analysts} analysts (${Math.round((ac.revisions.share ?? 0) * 100)}% of the panel)` : " — no analyst count on file, today's rule used"}. Today&apos;s rule gives {signed(ac.revisions.currentRuleContribution)}; as a share of the panel {signed(ac.revisions.contribution)}.</p> : <p>No revision data on file.</p>}

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">Research mentions — stored {rm.stored} · shadow {rm.shadow}</h4>
      <p>On {rm.on.length ? rm.on.join(", ") : "no lists"}. It could be on {rm.eligibleBullish} bullish lists; the best-covered market has {rm.referenceBullish}, so each mention counts ×{rm.multiplier}{rm.bearishOn ? `, less ${rm.bearishOn} bearish` : ""}.</p>

      <h4 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-accent">Returns &amp; margins — stored {q.stored} · shadow {q.shadow == null ? "—" : q.shadow}</h4>
      <p>{q.status}.</p>
      {q.working && (
        <>
          <p>Ranked in <b className="font-medium text-ink">{q.working.rankedIn}</b> ({q.working.groupSize} companies){q.working.foldedFrom ? `; its own group, ${q.working.foldedFrom}, is too small to rank in` : ""}. Returns measure: {q.working.returnsBasis}.{q.working.groupNote ? ` ${q.working.groupNote}` : ""}</p>
          <ul className="mt-1 flex flex-col gap-0.5 tabular-nums">
            {q.working.components.map((c) => <li key={c.metric}><span className="text-ink">{c.label}:</span> {c.value.toFixed(1)} is the {c.percentile.toFixed(0)}th percentile (group median {c.groupMedian == null ? "—" : c.groupMedian.toFixed(1)}), weight {(c.weight * 100).toFixed(0)}%</li>)}
            {q.working.excluded.map((e, i) => <li key={i} className="text-ink-3">{e.metric}: not used — {e.reason}</li>)}
          </ul>
          {q.working.blendedPercentile != null && <p className="mt-1">Blended percentile {q.working.blendedPercentile.toFixed(1)} → <b className="font-medium text-ink">{q.working.computedScore} / 2</b>{q.working.topMark ? ` (top band ${q.working.topMark.inTopBand ? "yes" : "no"}, returns at or above the group median ${q.working.topMark.returnsAtOrAboveMedian ? "yes" : "no"}, clears the floor ${q.working.topMark.clearsFloor ? "yes" : "no"})` : ""}.</p>}
        </>
      )}
    </div>
  );
}

export default function ScoringShadowPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "shift", dir: -1 });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scoring-shadow").then((r) => r.json()).then(setData).catch((e) => setData({ error: String(e) }));
  }, []);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const { key, dir } = sort;
    return list.sort((a, b) => (typeof a[key] === "number" ? ((a[key] as number) - (b[key] as number)) * dir : String(a[key]).localeCompare(String(b[key])) * dir) || a.ticker.localeCompare(b.ticker));
  }, [data, sort]);

  if (!data) return <div className="mx-auto max-w-6xl px-4 py-8 text-ink-2">Loading the shadow scores…</div>;
  if (data.error) return <div className="mx-auto max-w-3xl px-4 py-8 text-warn">Could not load the shadow scores: {data.error}</div>;
  const head = (key: SortKey, label: string, right = false) => (
    <th className={`cursor-pointer select-none py-1 font-normal ${right ? "text-right" : "text-left"}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "ticker" || key === "country" || key === "size" ? 1 : -1 }))}>
      <span>{label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</span>
    </th>
  );
  const selected = rows.find((r) => r.ticker === open) ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 text-ink">
      <p className="text-[12px]"><Link href="/methodology" className="text-accent hover:underline">← Methodology</Link></p>
      <h1 className="mt-1 text-2xl font-semibold">Scoring shadow</h1>
      <p className="mt-2 max-w-[80ch] text-[14px] leading-relaxed text-ink-2">
        The proposed fixes for the large-cap and US bias, worked out beside today&apos;s score for {data.names} stocks. <b className="font-medium text-ink">Nothing here changes a live score.</b> Scores are the 33-point conviction score before the regime adjustment, which is the same in both columns.
      </p>
      <p className="mt-2 max-w-[80ch] text-[13px] text-ink-2">
        {data.qualityBands
          ? <>Peer-ranked quality uses bands calibrated {data.qualityBands.calibratedAt.slice(0, 10)} on {data.qualityBands.universeSize} companies (S&amp;P 500 and TSX 60 — large caps only, so a smaller company is ranked against larger peers).</>
          : <span className="text-warn">Peer-ranked quality is not included yet: the quality bands have not been calibrated. The other three fixes are shown.</span>}
        {" "}{data.compositeCheck}.{data.liveNote ? ` ${data.liveNote}` : ""}
      </p>

      {data.summary && (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <SummaryTable title="By market" rows={data.summary.byCountry} />
            <SummaryTable title="By size" rows={data.summary.bySize} />
          </div>
          <div className="mt-3"><SummaryTable title="By market and size" rows={data.summary.byCountryAndSize} /></div>
          <p className="mt-1.5 text-[12px] text-ink-3">{data.summary.note}</p>
        </>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-[12.5px] tabular-nums">
          <thead>
            <tr className="border-b border-line text-ink-3">
              {head("ticker", "Stock")}{head("country", "Market")}{head("size", "Size")}{head("current", "Today", true)}{head("shadow", "Shadow", true)}{head("shift", "Shift", true)}
              <th className="py-1 text-right font-normal">Revisions</th><th className="py-1 text-right font-normal">No data</th><th className="py-1 text-right font-normal">Lists</th><th className="py-1 text-right font-normal">Quality</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker} className={`cursor-pointer border-b border-line hover:bg-surface ${open === r.ticker ? "bg-surface" : ""}`} onClick={() => setOpen(open === r.ticker ? null : r.ticker)}>
                <td className="py-1 pr-3"><span className="font-medium text-ink">{r.ticker}</span> <span className="text-ink-3">{r.bucket === "Watchlist" ? "· watchlist" : ""}</span></td>
                <td className="pr-3 text-ink-2">{r.country}</td><td className="pr-3 text-ink-2">{r.size}</td>
                <td className="text-right">{r.current.toFixed(1)}</td><td className="text-right">{r.shadow.toFixed(1)}</td>
                <td className="text-right"><span className={tone(r.shift)}>{signed(r.shift)}</span></td>
                <td className="text-right"><span className={tone(r.byFix.revisions)}>{signed(r.byFix.revisions)}</span></td>
                <td className="text-right"><span className={tone(r.byFix.noData)}>{signed(r.byFix.noData)}</span></td>
                <td className="text-right"><span className={tone(r.byFix.mentions)}>{signed(r.byFix.mentions)}</span></td>
                <td className="text-right">{r.returnsMargins.working ? <span className={tone(r.byFix.quality)}>{signed(r.byFix.quality)}</span> : <span className="text-ink-3">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-3">Click a row for the working. The four right-hand columns show what each fix does on its own.</p>
      {selected && <div className="mt-3"><Detail r={selected} /></div>}

      {data.notComputed && (
        <p className="mt-5 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-2"><b className="font-medium text-ink">Not included — thin coverage.</b> {data.notComputed.thinCoverage}</p>
      )}
    </div>
  );
}
