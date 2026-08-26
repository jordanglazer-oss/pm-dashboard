"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { displayTicker } from "@/app/lib/ticker";
import {
  VERDICT_LABEL,
  STALE_LABEL,
  type SynthesisEntry,
  type SynthesisBullet,
  type StaleReason,
  type SynthesisHistoryRow,
  type SynthesisVerdict,
} from "@/app/lib/synthesis-screen-display";
import type { SectorLeadership, LeadershipRow } from "@/app/lib/sector-leadership";

/**
 * Synthesis screen — per-name AI base/bull/bear evidence synthesis.
 * The front-door triage view: watchlist names get Advance/Watch/Pass,
 * portfolio names get Thesis intact/Review/Exit watch. Generation is
 * manual (per-name or "refresh stale"); staleness badges show which
 * names have new inputs, a big price move, or earnings since last run.
 */

type Evidence = {
  rbcReport: boolean;
  jpmReport: boolean;
  morningstarReport: boolean;
  streetConsensus: boolean;
  takeaways: number;
  mentions: number;
  marketEdge?: boolean;
  boosted?: boolean;
  sia?: boolean;
};

type Row = {
  ticker: string;
  displayTicker?: string;
  name: string;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  currentPrice?: number;
  earningsDate?: string;
  entry: SynthesisEntry | null;
  stale: StaleReason[];
  evidence?: Evidence;
  previous?: SynthesisHistoryRow | null;
};

const hasReports = (r: Row) => !!(r.evidence?.rbcReport || r.evidence?.jpmReport);

type SortMode = "priority" | "symbol" | "name";

const SORT_LABELS: { mode: SortMode; label: string; title: string }[] = [
  { mode: "priority", label: "Priority", title: "Ungenerated first, then verdict, then skew" },
  { mode: "symbol", label: "Symbol", title: "Alphabetical by ticker" },
  { mode: "name", label: "Company", title: "Alphabetical by company name" },
];

type FilterMode = "generated" | "stale" | "ungenerated";

/** Mutually exclusive states — a row is exactly one of these. */
function rowState(r: Row): FilterMode {
  if (!r.entry) return "ungenerated";
  return r.stale.length > 0 ? "stale" : "generated";
}

const FILTER_LABELS: { mode: FilterMode; label: string; title: string }[] = [
  { mode: "generated", label: "Current", title: "Synthesis generated and up to date" },
  { mode: "stale", label: "Stale", title: "Generated, but inputs/price/earnings have moved since" },
  { mode: "ungenerated", label: "Not generated", title: "No synthesis yet" },
];

type ScreenData = { rows: Row[]; leadership: SectorLeadership };

const VERDICT_STYLE: Record<string, string> = {
  advance: "bg-pos-soft text-pos border-pos-border",
  watch: "bg-warn-soft text-warn border-warn-border",
  pass: "bg-surface-2 text-ink-3 border-line",
  "thesis-intact": "bg-pos-soft text-pos border-pos-border",
  review: "bg-warn-soft text-warn border-warn-border",
  "exit-watch": "bg-neg-soft text-neg border-neg-border",
};

/** Sort weight: most actionable verdicts first within a section. */
const VERDICT_ORDER: Record<string, number> = {
  advance: 0,
  watch: 1,
  pass: 2,
  "exit-watch": 0,
  review: 1,
  "thesis-intact": 2,
};

function VerdictChip({ entry }: { entry: SynthesisEntry }) {
  const v = entry.result.verdict;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${VERDICT_STYLE[v] ?? "bg-surface-2 text-ink-2 border-line"}`}>
      {VERDICT_LABEL[v] ?? v}
    </span>
  );
}

function SkewPill({ skew }: { skew: number }) {
  const cls = skew > 0 ? "text-pos" : skew < 0 ? "text-neg" : "text-ink-3";
  const label = skew > 0 ? `Bull +${skew}` : skew < 0 ? `Bear ${skew}` : "Balanced";
  return <span className={`font-mono text-[10px] font-semibold ${cls}`} title="Risk/reward skew (−2 bear-heavy … +2 bull-heavy)">{label}</span>;
}

/** Higher = better outcome, per bucket. Drives the change-marker arrow. */
const VERDICT_GOODNESS: Record<string, number> = {
  pass: 0,
  watch: 1,
  advance: 2,
  "exit-watch": 0,
  review: 1,
  "thesis-intact": 2,
};

function VerdictChangeMarker({ current, previous }: { current: SynthesisVerdict; previous: SynthesisHistoryRow }) {
  if (previous.verdict === current) return null;
  const improved = (VERDICT_GOODNESS[current] ?? 1) > (VERDICT_GOODNESS[previous.verdict] ?? 1);
  return (
    <span
      className={`font-mono text-[10px] font-bold ${improved ? "text-pos" : "text-neg"}`}
      title={`Was ${VERDICT_LABEL[previous.verdict] ?? previous.verdict} on ${previous.date}`}
    >
      {improved ? "▲" : "▼"} was {VERDICT_LABEL[previous.verdict] ?? previous.verdict}
    </span>
  );
}

function EvidenceIcons({ evidence }: { evidence: Evidence }) {
  const chip = (label: string, on: boolean, title: string) => (
    <span
      key={label}
      title={title}
      className={`inline-flex items-center rounded border px-1 py-px font-mono text-[8px] font-semibold ${
        on ? "border-line bg-surface text-ink-2" : "border-line bg-surface-2 text-ink-3 opacity-40"
      }`}
    >
      {label}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      {chip("RBC", evidence.rbcReport, evidence.rbcReport ? "RBC report uploaded" : "No RBC report")}
      {chip("JPM", evidence.jpmReport, evidence.jpmReport ? "JPM report uploaded" : "No JPM report")}
      {chip("MS", evidence.morningstarReport, evidence.morningstarReport ? "Morningstar report uploaded" : "No Morningstar report")}
      {chip("ST", evidence.streetConsensus, evidence.streetConsensus ? "FactSet street consensus present" : "No street consensus")}
      {chip(`TA ${evidence.takeaways}`, evidence.takeaways > 0, `${evidence.takeaways} street-takeaway entries`)}
      {chip(`L ${evidence.mentions}`, evidence.mentions > 0, `${evidence.mentions} research-list mentions`)}
      {chip("ME", !!evidence.marketEdge, evidence.marketEdge ? "MarketEdge opinion on file" : "No MarketEdge opinion")}
      {chip("AI", !!evidence.boosted, evidence.boosted ? "BoostedAI rating on file" : "No BoostedAI rating")}
      {chip("SIA", !!evidence.sia, evidence.sia ? "SIA SMAX on file" : "No SIA SMAX")}
    </span>
  );
}

function StaleBadges({ stale }: { stale: StaleReason[] }) {
  if (stale.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {stale.map((r) => (
        <span key={r} className="inline-flex items-center rounded-full border border-warn-border bg-warn-soft px-1.5 py-0.5 text-[9px] font-medium text-warn">
          {STALE_LABEL[r]}
        </span>
      ))}
    </span>
  );
}

function Bullets({ title, bullets, tone, plain }: { title: string; bullets: SynthesisBullet[]; tone: string; plain?: string }) {
  return (
    <div>
      <div className={`mb-1 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{title}</div>
      <ul className="space-y-1">
        {bullets.length === 0 && <li className="text-xs text-ink-3">—</li>}
        {bullets.map((b, i) => (
          <li key={i} className="text-xs leading-snug text-ink-2">
            {b.text} <span className="text-[9px] text-ink-3">[{b.source}]</span>
          </li>
        ))}
      </ul>
      {plain && (
        <div className="mt-2 border-t border-line pt-1.5 text-xs italic leading-snug text-ink">
          {plain}
        </div>
      )}
    </div>
  );
}

const fmtPct = (v: number | null) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

function LeadershipStrip({ data }: { data: SectorLeadership }) {
  const [open, setOpen] = useState(false);
  const sectors = useMemo(
    () => [...data.rows.filter((r) => r.kind === "sector")].sort((a, b) => (b.r3m ?? -999) - (a.r3m ?? -999)),
    [data],
  );
  const industries = useMemo(
    () => [...data.rows.filter((r) => r.kind === "industry" && r.r3m != null)].sort((a, b) => (b.r3m ?? 0) - (a.r3m ?? 0)),
    [data],
  );
  const cell = (r: LeadershipRow, metric: "r1w" | "r1m" | "r3m") => {
    const v = r[metric];
    const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
    return <td key={metric} className={`px-2 py-1 text-right font-mono text-[11px] ${cls}`}>{fmtPct(v)}</td>;
  };
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-ink">
          Sector leadership <span className="font-normal text-ink-3">(3M, as of {data.builtAt.slice(0, 10)})</span>
        </div>
        <button onClick={() => setOpen(!open)} className="text-[11px] text-accent hover:underline">
          {open ? "Collapse" : "Full table"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sectors.slice(0, 3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-pos-border bg-pos-soft px-2 py-0.5 text-[10px] text-pos">
            {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {sectors.slice(-3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-neg-border bg-neg-soft px-2 py-0.5 text-[10px] text-neg">
            {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {industries.slice(0, 3).map((r) => (
          <span key={r.symbol} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2">
            ▲ {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
        {industries.slice(-2).map((r) => (
          <span key={r.symbol} className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2">
            ▼ {r.label} {fmtPct(r.r3m)}
          </span>
        ))}
      </div>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[420px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-2 py-1 text-left">Group</th>
                <th className="px-2 py-1 text-right">1W</th>
                <th className="px-2 py-1 text-right">1M</th>
                <th className="px-2 py-1 text-right">3M</th>
              </tr>
            </thead>
            <tbody>
              {[...sectors, ...industries].map((r) => (
                <tr key={r.symbol} className="border-t border-line">
                  <td className="px-2 py-1 text-xs text-ink-2">
                    {r.label} <span className="font-mono text-[10px] text-ink-3">{r.symbol}</span>
                    {r.kind === "industry" && <span className="ml-1 text-[9px] text-ink-3">(industry)</span>}
                  </td>
                  {cell(r, "r1w")}
                  {cell(r, "r1m")}
                  {cell(r, "r3m")}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function SynthesisPage() {
  const [data, setData] = useState<ScreenData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [filters, setFilters] = useState<Set<FilterMode>>(new Set());
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [genErrors, setGenErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/synthesis-screen");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ScreenData);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(
    async (tickers: string[], opts?: { force?: boolean; webFill?: boolean }) => {
      setGenerating((prev) => new Set([...prev, ...tickers]));
      setGenErrors((prev) => {
        const next = { ...prev };
        for (const t of tickers) delete next[t];
        return next;
      });
      try {
        for (const batch of chunk(tickers, 5)) {
          const res = await fetch("/api/synthesis-screen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tickers: batch, force: opts?.force ?? true, webFill: opts?.webFill ?? false }),
          });
          const json = (await res.json()) as {
            results?: Array<{ ticker: string; status: string; entry?: SynthesisEntry; error?: string }>;
            error?: string;
          };
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          setData((prev) => {
            if (!prev) return prev;
            const byTicker = new Map((json.results ?? []).map((r) => [r.ticker, r]));
            return {
              ...prev,
              rows: prev.rows.map((row) => {
                const r = byTicker.get(row.ticker);
                if (!r?.entry) return row;
                return { ...row, entry: r.entry, stale: [] };
              }),
            };
          });
          setGenErrors((prev) => {
            const next = { ...prev };
            for (const r of json.results ?? []) if (r.status === "error" && r.error) next[r.ticker] = r.error;
            return next;
          });
          setGenerating((prev) => {
            const next = new Set(prev);
            for (const t of batch) next.delete(t);
            return next;
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "generation failed";
        setGenErrors((prev) => {
          const next = { ...prev };
          for (const t of tickers) if (!(t in next)) next[t] = msg;
          return next;
        });
        setGenerating((prev) => {
          const next = new Set(prev);
          for (const t of tickers) next.delete(t);
          return next;
        });
      }
    },
    [],
  );

  const toggle = (ticker: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });

  const toggleFilter = (mode: FilterMode) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });

  const sections: Array<{ title: string; bucket: "Portfolio" | "Watchlist" }> = [
    { title: "Watchlist", bucket: "Watchlist" },
    { title: "Portfolio", bucket: "Portfolio" },
  ];

  const sortRows = (rows: Row[]) =>
    [...rows].sort((a, b) => {
      if (sortMode === "symbol") {
        return displayTicker(a.displayTicker ?? a.ticker).localeCompare(displayTicker(b.displayTicker ?? b.ticker));
      }
      if (sortMode === "name") {
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) return byName;
        return a.ticker.localeCompare(b.ticker);
      }
      const av = a.entry ? (VERDICT_ORDER[a.entry.result.verdict] ?? 9) : -1;
      const bv = b.entry ? (VERDICT_ORDER[b.entry.result.verdict] ?? 9) : -1;
      // Never-generated first (they need attention), then verdict order, then skew desc.
      if (av !== bv) return av - bv;
      const as = a.entry?.result.skew ?? 0;
      const bs = b.entry?.result.skew ?? 0;
      if (as !== bs) return bs - as;
      return a.ticker.localeCompare(b.ticker);
    });

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="rounded-lg border border-neg-border bg-neg-soft p-4 text-sm text-neg">
          Failed to load synthesis screen: {loadError}
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-ink-3">Loading synthesis screen…</div>;
  }

  // Row-state counts drive the filter chip labels. Every row is exactly one
  // of the three states, so the counts sum to the full universe.
  const stateCounts: Record<FilterMode, number> = { generated: 0, stale: 0, ungenerated: 0 };
  for (const r of data.rows) stateCounts[rowState(r)] += 1;

  // Bulk refresh only covers names with at least one uploaded RBC/JPM report —
  // thin-evidence names are generated deliberately, one at a time.
  const staleTickers = data.rows.filter((r) => r.stale.length > 0 && hasReports(r)).map((r) => r.ticker);
  const staleNoReports = data.rows.filter((r) => r.stale.length > 0 && !hasReports(r)).length;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink">Synthesis</h1>
          <p className="text-xs text-ink-3">
            Evidence-bound base / bull / bear per name — FactSet, analyst reports, revisions, street takeaways,
            research lists, technicals. Score and factors deliberately excluded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-line" role="group" aria-label="Sort rows">
            {SORT_LABELS.map(({ mode, label, title }) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                title={title}
                aria-pressed={sortMode === mode}
                className={`px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  sortMode === mode ? "bg-surface-2 text-ink" : "bg-surface text-ink-3 hover:text-ink-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void generate(staleTickers)}
            disabled={staleTickers.length === 0 || generating.size > 0}
            className="rounded-md border border-accent-border bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-40"
            title={staleNoReports > 0 ? `Skips ${staleNoReports} stale name(s) with no RBC/JPM report — generate those individually` : undefined}
          >
            Refresh stale ({staleTickers.length})
          </button>
        </div>
      </div>

      <LeadershipStrip data={data.leadership} />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Show</span>
        {FILTER_LABELS.map(({ mode, label, title }) => {
          const active = filters.has(mode);
          return (
            <button
              key={mode}
              onClick={() => toggleFilter(mode)}
              title={title}
              aria-pressed={active}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                active
                  ? "border-accent-border bg-accent-soft text-accent"
                  : "border-line bg-surface text-ink-3 hover:text-ink-2"
              }`}
            >
              {label} ({stateCounts[mode]})
            </button>
          );
        })}
        {filters.size > 0 && (
          <button
            onClick={() => setFilters(new Set())}
            className="text-[10px] text-ink-3 underline hover:text-ink-2"
          >
            Clear
          </button>
        )}
      </div>

      {sections.map(({ title, bucket }) => {
        const bucketRows = data.rows.filter((r) => r.bucket === bucket);
        if (bucketRows.length === 0) return null;
        const rows = sortRows(bucketRows.filter((r) => filters.size === 0 || filters.has(rowState(r))));
        const collapsed = collapsedSections.has(bucket);
        return (
          <div key={bucket} className="rounded-lg border border-line bg-surface">
            <button
              onClick={() =>
                setCollapsedSections((prev) => {
                  const next = new Set(prev);
                  if (next.has(bucket)) next.delete(bucket);
                  else next.add(bucket);
                  return next;
                })
              }
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-ink-2 hover:bg-surface-2 ${collapsed ? "" : "border-b border-line"}`}
            >
              <span>
                {title}{" "}
                <span className="font-normal text-ink-3">
                  ({rows.length}
                  {rows.length !== bucketRows.length ? ` of ${bucketRows.length}` : ""})
                </span>
              </span>
              <span className="font-mono text-ink-3">{collapsed ? "▸" : "▾"}</span>
            </button>
            {collapsed ? null : rows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-ink-3">No names match the current filter.</div>
            ) : (
            <div className="divide-y divide-line">
              {rows.map((row) => {
                const isOpen = expanded.has(row.ticker);
                const busy = generating.has(row.ticker);
                const r = row.entry?.result;
                return (
                  <Fragment key={row.ticker}>
                    <div
                      className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-surface-2"
                      onClick={() => toggle(row.ticker)}
                    >
                      <div className="w-40 shrink-0">
                        <div className="font-mono text-xs font-bold text-ink">
                          {displayTicker(row.displayTicker ?? row.ticker)}
                        </div>
                        <div className="truncate text-[10px] text-ink-3" title={row.name}>
                          {row.name}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {row.entry && r ? (
                            <>
                              <VerdictChip entry={row.entry} />
                              {row.previous && <VerdictChangeMarker current={r.verdict} previous={row.previous} />}
                              <SkewPill skew={r.skew} />
                              <span className="truncate text-xs text-ink-2">{r.verdictReason}</span>
                            </>
                          ) : (
                            <span className="text-xs italic text-ink-3">Not yet generated</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          {row.evidence && <EvidenceIcons evidence={row.evidence} />}
                          {!hasReports(row) && (
                            <span
                              className="inline-flex items-center rounded-full border border-warn-border bg-warn-soft px-1.5 py-0.5 text-[9px] font-medium text-warn"
                              title="No RBC/JPM report uploaded — the synthesis would run on thin evidence. Upload a report first, or generate anyway."
                            >
                              No reports
                            </span>
                          )}
                          <StaleBadges stale={row.stale} />
                          {row.entry && (
                            <span className="text-[9px] text-ink-3">
                              {row.entry.generatedAt.slice(0, 10)}
                              {row.entry.webFillUsed ? " · web" : ""}
                            </span>
                          )}
                          {genErrors[row.ticker] && (
                            <span className="text-[9px] text-neg">Error: {genErrors[row.ticker]}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void generate([row.ticker]);
                        }}
                        disabled={busy}
                        className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[10px] font-medium text-ink-2 hover:text-ink disabled:opacity-40"
                      >
                        {busy ? "Generating…" : row.entry ? "Regenerate" : "Generate"}
                      </button>
                    </div>
                    {isOpen && r && (
                      <div className="space-y-3 bg-surface-2/50 px-4 py-3">
                        {row.entry?.targets && row.entry.targets.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Targets</span>
                            {row.entry.targets.map((t) => (
                              <span
                                key={t.source}
                                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-ink-2"
                                title={t.asOf ? `as of ${t.asOf}` : undefined}
                              >
                                {t.source} <span className="font-mono font-semibold text-ink">{t.target}</span>
                                {t.upsidePct != null && (
                                  <span className={`font-mono ${t.upsidePct >= 0 ? "text-pos" : "text-neg"}`}>
                                    {t.upsidePct >= 0 ? "+" : ""}
                                    {t.upsidePct.toFixed(0)}%
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {r.nextStep && (
                          <div className="rounded-md border border-accent-border bg-accent-soft px-2.5 py-1.5 text-xs text-accent">
                            <span className="font-bold uppercase tracking-wide text-[10px]">Next step</span>{" "}
                            {r.nextStep}
                          </div>
                        )}
                        <div className="grid gap-4 sm:grid-cols-3">
                          <Bullets title="Base" bullets={r.base} tone="text-ink-2" plain={r.plain?.base} />
                          <Bullets title="Bull" bullets={r.bull} tone="text-pos" plain={r.plain?.bull} />
                          <Bullets title="Bear" bullets={r.bear} tone="text-neg" plain={r.plain?.bear} />
                        </div>
                        {r.priceAction && (
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Price action — name &amp; sector</div>
                            <div className="text-xs text-ink-2">{r.priceAction}</div>
                          </div>
                        )}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Key debate</div>
                            <div className="text-xs text-ink-2">{r.keyDebate || "—"}</div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Catalysts</div>
                            {r.catalysts.length === 0 ? (
                              <div className="text-xs text-ink-3">None identified in the data</div>
                            ) : (
                              <ul className="text-xs text-ink-2">
                                {r.catalysts.map((c, i) => (
                                  <li key={i}>{c.date ? `${c.date}: ` : ""}{c.event}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Would change the call</div>
                            <ul className="text-xs text-ink-2">
                              {r.wouldChangeCall.length === 0 && <li className="text-ink-3">—</li>}
                              {r.wouldChangeCall.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">Data gaps</div>
                            <ul className="text-xs text-ink-2">
                              {r.dataGaps.length === 0 && <li className="text-ink-3">None declared</li>}
                              {r.dataGaps.map((g, i) => (
                                <li key={i}>{g}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <button
                            onClick={() => void generate([row.ticker], { force: true, webFill: true })}
                            disabled={busy}
                            className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] text-ink-3 hover:text-ink disabled:opacity-40"
                            title="Regenerate with web search allowed to fill declared data gaps (reputable sources only)"
                          >
                            Regenerate with web fill
                          </button>
                        </div>
                      </div>
                    )}
                    {isOpen && !r && (
                      <div className="bg-surface-2/50 px-4 py-3 text-xs text-ink-3">
                        No synthesis yet — hit Generate to build one from the current evidence.
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
