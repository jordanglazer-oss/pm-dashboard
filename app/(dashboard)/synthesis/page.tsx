"use client";

import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IdeasRail } from "@/app/components/IdeasRail";
import { ClampText } from "@/app/components/ClampText";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { PipelineStages, buildStages, usePipelineData } from "@/app/components/PipelineStages";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { MAX_SCORE, type Stock, type ScoreKey } from "@/app/lib/types";
import type { SuggestedDecision } from "@/app/lib/suggested-watchlist";
import TickerLink from "@/app/components/TickerLink";
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
 * manual (per-name or "refresh stale"); the Status column shows which
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

type Bucket = "Portfolio" | "Watchlist" | "Suggested";

/** A name advanced from Suggested starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const DECISION_TONE: Record<SuggestedDecision, string> = {
  advance: "text-pos",
  watch: "text-warn",
  pass: "text-ink-3",
};

type Row = {
  ticker: string;
  displayTicker?: string;
  name: string;
  bucket: Bucket;
  sector: string;
  currentPrice?: number;
  earningsDate?: string;
  entry: SynthesisEntry | null;
  stale: StaleReason[];
  evidence?: Evidence;
  previous?: SynthesisHistoryRow | null;
  /** Suggested rows only: the PM's remembered verdict (30-day memory). */
  decision?: { verdict: SuggestedDecision; decidedAt: string; expiresOn: string } | null;
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

/** Verdict word pill — the one place a pill is still allowed. */
const VERDICT_PILL: Record<string, string> = {
  advance: "bg-pos-soft text-pos",
  watch: "bg-warn-soft text-warn",
  pass: "bg-surface-2 text-ink-2",
  "thesis-intact": "bg-pos-soft text-pos",
  review: "bg-warn-soft text-warn",
  "exit-watch": "bg-neg-soft text-neg",
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

const BTN22 = "inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-40";
const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-40";
const LABEL = "text-[11px] text-ink-3";

function VerdictChip({ entry }: { entry: SynthesisEntry }) {
  const v = entry.result.verdict;
  return (
    <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium ${VERDICT_PILL[v] ?? "bg-surface-2 text-ink-2"}`}>
      {VERDICT_LABEL[v] ?? v}
    </span>
  );
}

function SkewText({ skew }: { skew: number }) {
  const cls = skew > 0 ? "text-pos" : skew < 0 ? "text-neg" : "text-ink-3";
  const label = skew > 0 ? `Bull +${skew}` : skew < 0 ? `Bear ${skew}` : "Balanced";
  return <span className={`font-mono text-[11px] ${cls}`} title="Risk/reward skew (−2 bear-heavy … +2 bull-heavy)">{label}</span>;
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
      className={`inline-flex items-center gap-0.5 text-[11px] ${improved ? "text-pos" : "text-neg"}`}
      title={`Was ${VERDICT_LABEL[previous.verdict] ?? previous.verdict} on ${previous.date}`}
    >
      <AppIcon name={improved ? "chevU" : "chevD"} size={11} strokeWidth={2.25} />
      was {VERDICT_LABEL[previous.verdict] ?? previous.verdict}
    </span>
  );
}

function EvidenceIcons({ evidence }: { evidence: Evidence }) {
  const chip = (label: string, on: boolean, title: string) => (
    <span key={label} title={title} className={`font-mono text-[11px] ${on ? "text-ink-2" : "text-ink-faint"}`}>
      {label}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
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

function Bullets({ title, bullets, tone, plain }: { title: string; bullets: SynthesisBullet[]; tone: string; plain?: string }) {
  return (
    <div className="min-w-0">
      <div className={`mb-1 text-[11px] font-medium ${tone}`}>{title}</div>
      <ul className="space-y-1">
        {bullets.length === 0 && <li className="text-[12.5px] text-ink-3">—</li>}
        {bullets.map((b, i) => (
          <li key={i} className="min-w-0 break-words text-[12.5px] leading-[1.5] text-ink-2">
            {b.text} <span className="text-[11px] text-ink-3">[{b.source}]</span>
          </li>
        ))}
      </ul>
      {plain && (
        <div className="mt-2 min-w-0 break-words border-t border-line-soft pt-1.5 text-[12.5px] italic leading-[1.5] text-ink">
          {plain}
        </div>
      )}
    </div>
  );
}

/**
 * One labelled cell of the expanded detail grid. Label sits ABOVE its value
 * (never beside it) and the value wraps — the expander is a grid of these, so
 * nothing has to truncate and nothing scrolls sideways.
 */
function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className={`mb-0.5 ${LABEL}`}>{label}</div>
      <div className="min-w-0 break-words text-[12.5px] leading-[1.5] text-ink-2">{children}</div>
    </div>
  );
}

const fmtPct = (v: number | null) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

type SortKey = "label" | "r1w" | "r1m" | "r3m";

/** One sortable half of the leadership table (sectors on the left, industries on the right). */
function LeadershipTable({ title, rows }: { title: string; rows: LeadershipRow[] }) {
  // Default matches the previous render order: strongest 3M first.
  const [sortKey, setSortKey] = useState<SortKey>("r3m");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      if (sortKey === "label") return a.label.localeCompare(b.label) * (asc ? 1 : -1);
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls always sink to the bottom regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * (asc ? 1 : -1);
    });
    return out;
  }, [rows, sortKey, asc]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setAsc((v) => !v);
    else {
      setSortKey(key);
      setAsc(key === "label");
    }
  };

  const th = (key: SortKey, label: string, align: "left" | "right") => (
    <th className={`${align === "right" ? "n" : ""} ${key === "label" ? "pl-3.5" : ""}`}>
      <button type="button" onClick={() => toggle(key)} className={`inline-flex items-center gap-0.5 hover:text-ink ${key === sortKey ? "text-ink-2" : ""}`}>
        {label}
        {key === sortKey && <AppIcon name={asc ? "chevU" : "chevD"} size={11} strokeWidth={2} />}
      </button>
    </th>
  );

  const cell = (r: LeadershipRow, metric: "r1w" | "r1m" | "r3m") => {
    const v = r[metric];
    const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
    return <td key={metric} className={`n ${cls}`}>{fmtPct(v)}</td>;
  };

  return (
    <div className="min-w-0">
      <table className="data-table">
        <thead>
          <tr>
            {th("label", title, "left")}
            {th("r1w", "1W", "right")}
            {th("r1m", "1M", "right")}
            {th("r3m", "3M", "right")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol}>
              <td className="min-w-0 break-words pl-3.5 text-ink-2">
                {r.label} <span className="font-mono text-[11px] text-ink-3">{r.symbol}</span>
              </td>
              {cell(r, "r1w")}
              {cell(r, "r1m")}
              {cell(r, "r3m")}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Slim strip under the Synthesis header: leaders / laggards (3M), full table one click away. */
function LeadershipStrip({ data }: { data: SectorLeadership }) {
  const [open, toggleOpen] = usePersistedOpen("synthesis.leadership.open", false);
  const sectors = useMemo(
    () => [...data.rows.filter((r) => r.kind === "sector")].sort((a, b) => (b.r3m ?? -999) - (a.r3m ?? -999)),
    [data],
  );
  const industries = useMemo(
    () => [...data.rows.filter((r) => r.kind === "industry" && r.r3m != null)].sort((a, b) => (b.r3m ?? 0) - (a.r3m ?? 0)),
    [data],
  );
  const item = (r: LeadershipRow, tone: string) => (
    <span key={r.symbol} className="text-ink-2">
      {r.label} <span className={`font-mono ${tone}`}>{fmtPct(r.r3m)}</span>
    </span>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
        <span title={`3M, as of ${data.builtAt.slice(0, 10)}`}>Sector leadership 3M</span>
        {sectors.slice(0, 3).map((r) => item(r, "text-pos"))}
        {sectors.slice(-3).map((r) => item(r, "text-neg"))}
        {industries.length > 0 && <span className="text-ink-faint">·</span>}
        {industries.slice(0, 3).map((r) => item(r, "text-pos"))}
        {industries.slice(-2).map((r) => item(r, "text-neg"))}
        <button onClick={toggleOpen} className="ml-auto inline-flex items-center gap-1 text-accent-ink hover:underline">
          {open ? "Collapse" : "Full table"}
          <AppIcon name={open ? "chevU" : "chevD"} size={11} strokeWidth={2} />
        </button>
      </div>
      {open && (
        <div className="grid border-b border-line-soft md:grid-cols-2 md:divide-x md:divide-line-soft">
          <LeadershipTable title="Sectors" rows={sectors} />
          <LeadershipTable title="Industries" rows={industries} />
        </div>
      )}
    </>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Upside to the street average target (falls back to the first target with a reading). */
function upsideOf(entry: SynthesisEntry | null): number | null {
  const t = entry?.targets;
  if (!t || t.length === 0) return null;
  const street = t.find((x) => x.source === "Street avg" && x.upsidePct != null);
  if (street) return street.upsidePct;
  const any = t.find((x) => x.upsidePct != null);
  return any?.upsidePct ?? null;
}

const normTicker = (t: string) => t.toUpperCase().replace(/-T$/, ".TO");

export default function SynthesisPage() {
  const [data, setData] = useState<ScreenData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Row open state persists in pm:ui-prefs (site rule: every collapse
  // survives refreshes). Set-based APIs preserved so the render code below is
  // untouched.
  const { uiPrefs, setUiPref, addStock, scoredStocks } = useStocks();
  const [deciding, setDeciding] = useState<string | null>(null);
  const expanded = useMemo(() => {
    const out = new Set<string>();
    for (const k of Object.keys(uiPrefs)) if (k.startsWith("synthesis.row.") && uiPrefs[k] === "1") out.add(k.slice("synthesis.row.".length));
    return out;
  }, [uiPrefs]);
  const setExpanded = (fn: (prev: Set<string>) => Set<string>) => {
    const next = fn(expanded);
    for (const t of next) if (!expanded.has(t)) setUiPref(`synthesis.row.${t}`, "1");
    for (const t of expanded) if (!next.has(t)) setUiPref(`synthesis.row.${t}`, "0");
  };
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [filters, setFilters] = useState<Set<FilterMode>>(new Set());
  const [stage, setStage] = useState<Bucket | "all">("all");
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [genErrors, setGenErrors] = useState<Record<string, string>>({});
  /** Tickers the completeness gate refused to generate, -> the missing inputs.
   *  Distinct from genErrors: nothing failed technically, the evidence was
   *  incomplete and we chose not to produce a card. */
  const [blocked, setBlocked] = useState<Record<string, string[]>>({});

  // The stage strip + "Ready to act" read the same surfaces the Funnel does;
  // the synthesis rows come from this page's own state so a fresh generation
  // is reflected without a second fetch.
  const pipeline = usePipelineData(data?.rows ?? null);
  const stages = useMemo(() => buildStages(pipeline), [pipeline]);

  // Deep-link support: /synthesis?ticker=CSU.TO&from=stock — show a
  // "back to the stock page" button and scroll/open that name's row.
  const [focusTicker, setFocusTicker] = useState<string | null>(null);
  const focusedOnce = useRef(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("ticker");
    if (t) setFocusTicker(t);
  }, []);
  useEffect(() => {
    if (!focusTicker || !data || focusedOnce.current) return;
    focusedOnce.current = true;
    const t = focusTicker.toUpperCase();
    setExpanded((prev) => new Set([...prev, t]));
    setTimeout(() => document.getElementById(`syn-${t}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTicker, data]);

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

  /**
   * The ONE generation call on this page (per-row Generate, Refresh stale, and
   * the sequential "Run selected" runner all go through it). Returns the
   * per-name outcome so a caller running names one at a time can build a
   * failure list without reading back the error state it just set.
   */
  const generate = useCallback(
    async (
      tickers: string[],
      opts?: { force?: boolean; webFill?: boolean; allowIncomplete?: boolean },
    ): Promise<{ ok: string[]; failed: string[] }> => {
      const ok: string[] = [];
      const failed: string[] = [];
      setGenerating((prev) => new Set([...prev, ...tickers]));
      setGenErrors((prev) => {
        const next = { ...prev };
        for (const t of tickers) delete next[t];
        return next;
      });
      setBlocked((prev) => {
        const next = { ...prev };
        for (const t of tickers) delete next[t];
        return next;
      });
      try {
        for (const batch of chunk(tickers, 5)) {
          const res = await fetch("/api/synthesis-screen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tickers: batch,
              force: opts?.force ?? true,
              webFill: opts?.webFill ?? false,
              allowIncomplete: opts?.allowIncomplete ?? false,
            }),
          });
          const json = (await res.json()) as {
            results?: Array<{ ticker: string; status: string; entry?: SynthesisEntry; error?: string; missing?: string[] }>;
            error?: string;
          };
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          const byTicker = new Map((json.results ?? []).map((r) => [r.ticker, r]));
          // A name "succeeded" only if a card came back. Errors AND the
          // completeness gate's refusals both count as failures for the run
          // summary — neither produced a synthesis.
          for (const t of batch) (byTicker.get(t)?.entry ? ok : failed).push(t);
          setData((prev) => {
            if (!prev) return prev;
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
          // Rows the completeness gate blocked: nothing was generated or
          // cached, so surface WHY and offer a retry rather than leaving the
          // row looking merely un-generated.
          setBlocked((prev) => {
            const next = { ...prev };
            for (const r of json.results ?? []) {
              if (r.status === "incomplete") next[r.ticker] = r.missing ?? ["required inputs unavailable"];
              else delete next[r.ticker];
            }
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
        for (const t of tickers) if (!ok.includes(t) && !failed.includes(t)) failed.push(t);
      }
      return { ok, failed };
    },
    [],
  );

  /** ── Multi-select ───────────────────────────────────────────────────────
   *  Check names, then "Run selected" generates them STRICTLY one at a time
   *  (each awaited before the next starts) so an expensive call never fans
   *  out. Selection is transient by design — it is an action scope, exactly
   *  like Score selected on Holdings — and it is intersected with the rows
   *  actually on screen at click time, so a tick left behind by a filter
   *  change can never queue an off-screen name. No new endpoint, no new
   *  Redis key: it reuses `generate` one ticker per call. */
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState("");
  const [runFailures, setRunFailures] = useState<string[]>([]);
  // Ref drives the loop (it must be readable mid-await); the mirror state only
  // exists so the "stopping" note can render.
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const toggleSelected = (ticker: string) =>
    setSelectedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });

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

  const sections: Array<{ title: string; bucket: Bucket }> = [
    { title: "Suggested", bucket: "Suggested" },
    { title: "Watchlist", bucket: "Watchlist" },
    { title: "Portfolio", bucket: "Portfolio" },
  ];

  /** Funnel stage 3 → 4: the PM's call on a Suggested name after reading its
   *  synthesis. Advance adds the name to the real Watchlist (existing addStock
   *  path — nothing else touches pm:stocks); watch/pass only write the 30-day
   *  memory (pm:synthesis-decisions). The row is re-read afterwards so it
   *  moves to the Watchlist section or drops out (pass). */
  const decide = useCallback(
    async (row: Row, verdict: SuggestedDecision) => {
      setDeciding(row.ticker);
      try {
        if (verdict === "advance") {
          let name = row.name || row.ticker;
          let sector = row.sector || "Technology";
          try {
            const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(row.ticker)}`);
            if (res.ok) {
              const d = await res.json();
              if (d.names?.[row.ticker]) name = d.names[row.ticker];
              if (d.sectors?.[row.ticker]) sector = d.sectors[row.ticker];
            }
          } catch { /* keep what the list carried */ }
          const stock: Stock = { ticker: row.ticker, name, bucket: "Watchlist", sector, beta: 1.0, weights: { portfolio: 0 }, scores: { ...ZERO_SCORES }, notes: "" };
          addStock(stock);
          // "Why I'm watching" — pre-filled from the synthesis so the entry
          // case (and later the thesis draft) starts from the verdict's reason.
          const why = [row.entry?.result.verdictReason, row.entry?.result.nextStep].filter(Boolean).join(" ");
          if (why) {
            void fetch("/api/kv/entry-cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: row.ticker, why, source: "synthesis-advance" }) }).catch(() => {});
          }
        }
        await fetch("/api/kv/synthesis-decisions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: row.ticker, verdict }),
        });
        // Give the debounced pm:stocks persist a beat before re-reading so an
        // advanced name comes back under Watchlist rather than Suggested.
        await new Promise((r) => setTimeout(r, verdict === "advance" ? 700 : 0));
        await load();
      } finally {
        setDeciding(null);
      }
    },
    [addStock, load],
  );

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

  // 41-pt score beside each name (book names only; Suggested rows have none).
  const scoreByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scoredStocks) m.set(normTicker(s.ticker), s.adjusted);
    return m;
  }, [scoredStocks]);

  const allRows = data?.rows ?? [];

  // Row-state counts drive the filter chip labels. Every row is exactly one
  // of the three states, so the counts sum to the full universe.
  const stateCounts: Record<FilterMode, number> = { generated: 0, stale: 0, ungenerated: 0 };
  for (const r of allRows) stateCounts[rowState(r)] += 1;
  const stageCounts: Record<Bucket, number> = { Suggested: 0, Watchlist: 0, Portfolio: 0 };
  for (const r of allRows) stageCounts[r.bucket] += 1;

  // Bulk refresh only covers names with at least one uploaded RBC/JPM report —
  // thin-evidence names are generated deliberately, one at a time.
  const staleTickers = allRows.filter((r) => r.stale.length > 0 && hasReports(r)).map((r) => r.ticker);
  const staleNoReports = allRows.filter((r) => r.stale.length > 0 && !hasReports(r)).length;

  // Stage order preserved (Suggested → Watchlist → Portfolio), each sorted.
  const visibleRows = sections
    .filter((s) => stage === "all" || s.bucket === stage)
    .flatMap((s) => sortRows(allRows.filter((r) => r.bucket === s.bucket && (filters.size === 0 || filters.has(rowState(r))))));

  // Selection is scoped to what is on screen — the header checkbox selects
  // and clears exactly the visible rows.
  const visibleTickers = visibleRows.map((r) => r.ticker);
  const selectedInView = visibleTickers.filter((t) => selectedTickers.has(t));
  const allVisibleSelected = visibleTickers.length > 0 && selectedInView.length === visibleTickers.length;
  const toggleSelectAll = () => setSelectedTickers(allVisibleSelected ? new Set() : new Set(visibleTickers));

  /** Generate the checked names one after another, never in parallel. A
   *  failure is recorded and the run continues; Stop ends it after the name
   *  currently in flight. */
  const runSelected = async () => {
    if (running || generating.size > 0) return;
    // Snapshot the queue at click time — the action scope is what was on
    // screen and checked when the PM pressed the button.
    const queue = visibleRows
      .filter((r) => selectedTickers.has(r.ticker))
      .map((r) => ({ ticker: r.ticker, label: displayTicker(r.displayTicker ?? r.ticker) }));
    if (queue.length === 0) return;
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    setRunFailures([]);
    const failed: string[] = [];
    try {
      for (let i = 0; i < queue.length; i++) {
        if (stopRef.current) break;
        const { ticker, label } = queue[i];
        setRunProgress(`Generating ${i + 1} of ${queue.length} · ${label}`);
        const outcome = await generate([ticker]);
        if (outcome.failed.length > 0) failed.push(label);
      }
    } finally {
      setRunning(false);
      setStopping(false);
      setRunProgress("");
      setRunFailures(failed);
    }
  };

  const latestGenerated = allRows.reduce<string | null>((acc, r) => {
    const d = r.entry?.generatedAt.slice(0, 10);
    return d && (!acc || d > acc) ? d : acc;
  }, null);

  /** Status column: dot + word, one state per row, most actionable first. */
  const statusOf = (row: Row): { dot: string; word: string; title?: string; cls?: string } => {
    if (genErrors[row.ticker]) return { dot: "bg-neg", word: "Error", title: genErrors[row.ticker], cls: "text-neg" };
    if (generating.has(row.ticker)) return { dot: "bg-ink-faint", word: "Generating…", cls: "text-ink-3" };
    if (blocked[row.ticker]) return { dot: "bg-neg", word: "Blocked", title: blocked[row.ticker].join("; "), cls: "text-neg" };
    if (!row.entry) return { dot: "bg-ink-faint", word: "Not generated", cls: "text-ink-3" };
    if (row.stale.length > 0) return { dot: "bg-warn", word: "Stale", title: row.stale.map((s) => STALE_LABEL[s]).join(" · "), cls: "text-warn" };
    if (!hasReports(row)) return { dot: "bg-warn", word: "No reports", title: "No RBC/JPM report uploaded — the synthesis ran on thin evidence.", cls: "text-warn" };
    return { dot: "bg-pos", word: `Current ${row.entry.generatedAt.slice(5, 10)}`, title: `Generated ${row.entry.generatedAt.slice(0, 10)}${row.entry.webFillUsed ? " · web fill" : ""}`, cls: "text-ink-2" };
  };

  // Name · Stage · Status · Verdict · Next step · Upside · Score · Decision,
  // plus the select column.
  const COLS = 9;

  return (
    <div className="flex flex-col gap-3.5">
      <PipelineStages stages={stages} activeKey="synthesis" loading={pipeline.loading && !data} />

      {/* The rail only sits beside the table at 2xl. Below that the table takes
          the full content column, which is what keeps a 9-column row and its
          three-up expander from ever needing side-to-side scrolling. */}
      <div className="grid grid-cols-1 items-start gap-3.5 2xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section className="panel animate-panel-in flex min-w-0 flex-col">
          <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
            <span className="t-mark bg-hub-ideas" aria-hidden />
            <span className="t">Synthesis</span>
            <span className="m">
              Suggested, Watchlist and Portfolio · sorted by {SORT_LABELS.find((s) => s.mode === sortMode)?.label.toLowerCase()}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="seg" role="group" aria-label="Stage">
                <button onClick={() => setStage("all")} className={stage === "all" ? "on" : ""}>
                  All <span className="c">{allRows.length}</span>
                </button>
                {sections.map((s) => (
                  <button key={s.bucket} onClick={() => setStage(s.bucket)} className={stage === s.bucket ? "on" : ""}>
                    {s.title} <span className="c">{stageCounts[s.bucket]}</span>
                  </button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Show">
                {FILTER_LABELS.map(({ mode, label, title }) => (
                  <button key={mode} onClick={() => toggleFilter(mode)} title={title} aria-pressed={filters.has(mode)} className={filters.has(mode) ? "on" : ""}>
                    {label} <span className="c">{stateCounts[mode]}</span>
                  </button>
                ))}
              </div>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                aria-label="Sort rows"
                className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink-2"
              >
                {SORT_LABELS.map(({ mode, label, title }) => (
                  <option key={mode} value={mode} title={title}>{label}</option>
                ))}
              </select>
              <button
                onClick={() => void generate(staleTickers)}
                disabled={staleTickers.length === 0 || generating.size > 0 || running}
                className={BTN}
                title={staleNoReports > 0 ? `Skips ${staleNoReports} stale name(s) with no RBC/JPM report — generate those individually` : undefined}
              >
                <AppIcon name="refresh" size={13} strokeWidth={2} />
                Refresh stale <span className="font-mono text-[11px] text-ink-3">{staleTickers.length}</span>
              </button>
              {running ? (
                <button
                  onClick={() => { stopRef.current = true; setStopping(true); }}
                  className="inline-flex h-7 items-center gap-1.5 rounded-control border border-neg-border bg-surface px-2.5 text-[12.5px] text-neg hover:bg-neg-soft"
                  title="Stop after the name currently generating"
                >
                  <AppIcon name="stop" size={13} strokeWidth={2} />
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => void runSelected()}
                  disabled={selectedInView.length === 0 || generating.size > 0}
                  className="inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-40"
                  title={
                    selectedInView.length > 0
                      ? `Run the synthesis for ONLY the ${selectedInView.length} checked name${selectedInView.length === 1 ? "" : "s"}, one at a time`
                      : "Check names in the table to run their synthesis one at a time"
                  }
                >
                  <AppIcon name="play" size={13} strokeWidth={2} />
                  Run selected{selectedInView.length > 0 && <span className="font-mono opacity-70">{selectedInView.length}</span>}
                </button>
              )}
            </div>
          </div>

          {data && <LeadershipStrip data={data.leadership} />}

          {running && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line-soft bg-surface-2 px-3.5 py-1.5 text-[11.5px] text-ink-2">
              <AppIcon name="refresh" size={13} strokeWidth={2} className="animate-spin text-ink-3" />
              <span className="min-w-0 break-words">{runProgress || "Generating…"}</span>
              <span className="text-ink-3">· one at a time</span>
              {stopping && <span className="text-warn">· stopping after this name</span>}
            </div>
          )}
          {!running && runFailures.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-soft bg-neg-soft px-3.5 py-1.5 text-[11.5px] text-neg">
              <AppIcon name="warn" size={13} strokeWidth={2} />
              <span className="min-w-0 break-words">
                {runFailures.length} name{runFailures.length === 1 ? "" : "s"} did not generate:{" "}
                <span className="font-mono [overflow-wrap:anywhere]">{runFailures.join(", ")}</span>
              </span>
              <span className="text-ink-3">— open the row for the reason, or Generate it on its own</span>
              <button onClick={() => setRunFailures([])} className="ml-auto text-neg hover:text-ink" aria-label="Dismiss">
                <AppIcon name="x" size={13} strokeWidth={2} />
              </button>
            </div>
          )}

          {loadError ? (
            <div className="px-3.5 py-3 text-[12.5px] text-neg">Failed to load synthesis screen: {loadError}</div>
          ) : !data ? (
            <div className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading synthesis screen…</div>
          ) : visibleRows.length === 0 ? (
            <EmptyState
              className="!py-8"
              glyph={<AppIcon name="spark" size={18} />}
              title={allRows.length === 0 ? "Nothing to synthesise" : "No names match"}
              body={allRows.length === 0 ? "Suggested, Watchlist and Portfolio stocks appear here." : "No names match the current stage and state filters."}
            />
          ) : (
            /* Desktop (1280px+) fits without scrolling: text cells wrap, Stage
               and Next step drop at narrow breakpoints (both are still in the
               row expander), and the wrapper is only a phone-sized fallback so
               a narrow screen scrolls the table rather than the whole page. */
            <div className="min-w-0 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-8 pl-3.5 pr-0">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        disabled={visibleTickers.length === 0}
                        className="h-3.5 w-3.5 cursor-pointer accent-accent align-middle"
                        title="Select all / none — checked names scope the Run selected button"
                        aria-label="Select all rows"
                      />
                    </th>
                    <th>Name</th>
                    <th className="hidden md:table-cell">Stage</th>
                    <th>Status</th>
                    <th>Verdict</th>
                    <th className="hidden lg:table-cell">Next step</th>
                    <th className="n" title="Upside to the street average target at generation">Upside</th>
                    <th className="n" title="41-pt adjusted score (book names only)">Score</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isOpen = expanded.has(row.ticker);
                    const busy = generating.has(row.ticker);
                    const r = row.entry?.result;
                    const st = statusOf(row);
                    const upside = upsideOf(row.entry);
                    const score = scoreByTicker.get(normTicker(row.ticker));
                    return (
                      <Fragment key={row.ticker}>
                        <tr
                          id={`syn-${row.ticker.toUpperCase()}`}
                          className={`row-link scroll-mt-24 ${isOpen ? "sel" : ""}`}
                          onClick={(e) => {
                            // The row toggles the expander, but never when the
                            // click landed on a real control inside it.
                            if ((e.target as HTMLElement).closest("a, button, input, [role='button']")) return;
                            toggle(row.ticker);
                          }}
                        >
                          <td className="w-8 pl-3.5 pr-0">
                            <input
                              type="checkbox"
                              checked={selectedTickers.has(row.ticker)}
                              onChange={() => toggleSelected(row.ticker)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-3.5 w-3.5 cursor-pointer accent-accent align-middle"
                              title={`Include ${displayTicker(row.displayTicker ?? row.ticker)} in the next Run selected`}
                              aria-label={`Select ${displayTicker(row.displayTicker ?? row.ticker)}`}
                            />
                          </td>
                          <td className="min-w-0 break-words">
                            <TickerLink ticker={row.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">
                              {displayTicker(row.displayTicker ?? row.ticker)}
                            </TickerLink>
                            <div className="text-[12px] leading-[1.35] text-ink-3">{row.name}</div>
                            {/* Stage has its own column from md up; below that
                                it rides along here so nothing is lost. */}
                            <div className="text-[11px] text-ink-3 md:hidden">{row.bucket}</div>
                          </td>
                          <td className="hidden text-ink-2 md:table-cell">{row.bucket}</td>
                          <td className={`min-w-0 break-words ${st.cls ?? ""}`} title={st.title}>
                            <span className={`dot mr-1.5 ${st.dot}`} />
                            {st.word}
                          </td>
                          <td>
                            {row.entry && r ? (
                              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <VerdictChip entry={row.entry} />
                                <SkewText skew={r.skew} />
                                {row.previous && <VerdictChangeMarker current={r.verdict} previous={row.previous} />}
                              </span>
                            ) : (
                              <span className="text-ink-faint">—</span>
                            )}
                          </td>
                          <td className="hidden min-w-0 break-words text-[12px] leading-[1.4] text-ink-2 lg:table-cell" title={r ? [r.nextStep, r.verdictReason].filter(Boolean).join(" — ") : undefined}>
                            {r ? (r.nextStep ?? r.verdictReason) : <span className="text-ink-faint">—</span>}
                          </td>
                          <td className={`n ${upside == null ? "text-ink-faint" : upside >= 0 ? "text-pos" : "text-neg"}`}>
                            {upside == null ? "—" : `${upside >= 0 ? "+" : "−"}${Math.abs(upside).toFixed(0)}%`}
                          </td>
                          <td className="n">
                            {score == null ? (
                              <span className="text-ink-faint">—</span>
                            ) : (
                              <>
                                <span className="font-medium">{Math.round(score)}</span>
                                <span className="text-[11px] text-ink-faint">/{MAX_SCORE}</span>
                              </>
                            )}
                          </td>
                          <td className="min-w-0" onClick={(e) => e.stopPropagation()}>
                            <span className="inline-flex flex-wrap items-center gap-1 py-1">
                              {row.bucket === "Suggested" && row.decision && (
                                <span
                                  className={`mr-1 text-[11px] ${DECISION_TONE[row.decision.verdict]}`}
                                  title={`Decided ${row.decision.decidedAt.slice(0, 10)} · remembered until ${row.decision.expiresOn}`}
                                >
                                  {row.decision.verdict}
                                </span>
                              )}
                              {row.bucket === "Suggested" && row.entry && (
                                <>
                                  <button
                                    onClick={() => void decide(row, "advance")}
                                    disabled={deciding === row.ticker}
                                    className={BTN22}
                                    title="Add to the real Watchlist (funnel stage 4)"
                                  >
                                    Advance
                                  </button>
                                  <button
                                    onClick={() => void decide(row, "watch")}
                                    disabled={deciding === row.ticker || row.decision?.verdict === "watch"}
                                    className={BTN22}
                                    title="Keep on Suggested; don't flag it for a fresh synthesis for 30 days"
                                  >
                                    Watch
                                  </button>
                                  <button
                                    onClick={() => void decide(row, "pass")}
                                    disabled={deciding === row.ticker}
                                    className={BTN22}
                                    title="Hide from Suggested for 30 days (it resurfaces only if still on 2+ lists after that)"
                                  >
                                    Pass
                                  </button>
                                </>
                              )}
                              <button onClick={() => void generate([row.ticker])} disabled={busy} className={BTN22}>
                                {busy ? "Generating…" : row.entry ? "Regenerate" : "Generate"}
                              </button>
                            </span>
                          </td>
                        </tr>
                        {isOpen && r && (
                          <tr>
                            <td colSpan={COLS} className="!h-auto min-w-0 whitespace-normal bg-surface-2 px-4 py-3 align-top">
                              {/* The detail is a set of grids whose tracks are
                                  minmax(0,1fr), so a long paragraph or an
                                  unbroken mono string wraps instead of pushing
                                  its neighbour or widening the table. */}
                              <div className="flex min-w-0 flex-col gap-3.5">
                                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
                                  {row.evidence && <EvidenceIcons evidence={row.evidence} />}
                                  {row.stale.length > 0 && (
                                    <span className="text-warn">{row.stale.map((s) => STALE_LABEL[s]).join(" · ")}</span>
                                  )}
                                  {!hasReports(row) && (
                                    <span className="text-warn" title="No RBC/JPM report uploaded — the synthesis would run on thin evidence. Upload a report first, or generate anyway.">
                                      No reports
                                    </span>
                                  )}
                                  {row.entry && (
                                    <span>
                                      generated {row.entry.generatedAt.slice(0, 10)}
                                      {row.entry.webFillUsed ? " · web" : ""}
                                    </span>
                                  )}
                                  {genErrors[row.ticker] && <span className="min-w-0 break-words text-neg">Error: {genErrors[row.ticker]}</span>}
                                </div>
                                {r.verdictReason && (
                                  <div className="min-w-0 break-words text-[12.5px] leading-[1.5] text-ink">{r.verdictReason}</div>
                                )}
                                {row.entry?.incomplete && row.entry.incomplete.length > 0 && (
                                  <div className="min-w-0 rounded-control border border-neg-border bg-neg-soft px-3 py-2">
                                    <div className="text-[11px] font-medium text-neg">Incomplete — generated without required evidence</div>
                                    <ul className="mt-1 list-disc pl-4 text-[12.5px] text-ink-2">
                                      {row.entry.incomplete.map((m, i) => (
                                        <li key={i} className="break-words">{m}</li>
                                      ))}
                                    </ul>
                                    <div className="mt-1 text-[11px] text-ink-3">Do not rely on this as a clean read — regenerate once the source recovers.</div>
                                  </div>
                                )}
                                {r.nextStep && (
                                  <div className="min-w-0 rounded-control border border-accent-border bg-accent-soft px-2.5 py-1.5 text-accent-ink">
                                    <div className="text-[11px] opacity-80">Next step</div>
                                    <div className="min-w-0 break-words text-[12.5px] leading-[1.5]">{r.nextStep}</div>
                                  </div>
                                )}

                                {/* Base / Bull / Bear side by side from md up —
                                    three columns on a 1280px+ screen. */}
                                <div className="stagger grid min-w-0 gap-4 md:grid-cols-3">
                                  <div className="min-w-0" style={{ "--i": 0 } as CSSProperties}>
                                    <Bullets title="Base" bullets={r.base} tone="text-ink-2" plain={r.plain?.base} />
                                  </div>
                                  <div className="min-w-0" style={{ "--i": 1 } as CSSProperties}>
                                    <Bullets title="Bull" bullets={r.bull} tone="text-pos" plain={r.plain?.bull} />
                                  </div>
                                  <div className="min-w-0" style={{ "--i": 2 } as CSSProperties}>
                                    <Bullets title="Bear" bullets={r.bear} tone="text-neg" plain={r.plain?.bear} />
                                  </div>
                                </div>

                                {/* Everything else as one labelled grid: label
                                    above value, values wrap, nothing truncates. */}
                                <div className="grid min-w-0 gap-x-5 gap-y-3.5 border-t border-line-soft pt-3 sm:grid-cols-2 xl:grid-cols-3">
                                  {r.whatTheyDo && (
                                    <Field label="What they do" className="sm:col-span-2 xl:col-span-1">
                                      <ClampText text={r.whatTheyDo} textClassName="break-words text-[12.5px] leading-[1.5] text-ink-2" />
                                    </Field>
                                  )}
                                  {r.priceAction && (
                                    <Field label="Price action — name &amp; sector">
                                      <ClampText text={r.priceAction} textClassName="break-words text-[12.5px] leading-[1.5] text-ink-2" />
                                    </Field>
                                  )}
                                  <Field label="Key debate">{r.keyDebate || "—"}</Field>
                                  {row.entry?.targets && row.entry.targets.length > 0 && (
                                    <Field label="Targets">
                                      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2.5 gap-y-0.5">
                                        {row.entry.targets.map((t) => (
                                          <Fragment key={t.source}>
                                            <span className="min-w-0 break-words" title={t.asOf ? `as of ${t.asOf}` : undefined}>{t.source}</span>
                                            <span className="whitespace-nowrap text-right font-mono font-medium text-ink">{t.target.toFixed(2)}</span>
                                            <span className={`whitespace-nowrap text-right font-mono ${t.upsidePct == null ? "text-ink-faint" : t.upsidePct >= 0 ? "text-pos" : "text-neg"}`}>
                                              {t.upsidePct == null ? "—" : `${t.upsidePct >= 0 ? "+" : ""}${t.upsidePct.toFixed(0)}%`}
                                            </span>
                                          </Fragment>
                                        ))}
                                      </div>
                                    </Field>
                                  )}
                                  <Field label="Catalysts">
                                    {r.catalysts.length === 0 ? (
                                      <span className="text-ink-3">None identified in the data</span>
                                    ) : (
                                      <ul className="space-y-0.5">
                                        {r.catalysts.map((c, i) => (
                                          <li key={i} className="min-w-0 break-words">{c.date ? `${c.date}: ` : ""}{c.event}</li>
                                        ))}
                                      </ul>
                                    )}
                                  </Field>
                                  <Field label="Would change the call">
                                    <ul className="space-y-0.5">
                                      {r.wouldChangeCall.length === 0 && <li className="text-ink-3">—</li>}
                                      {r.wouldChangeCall.map((w, i) => (
                                        <li key={i} className="min-w-0 break-words">{w}</li>
                                      ))}
                                    </ul>
                                  </Field>
                                  <Field label="Data gaps">
                                    <ul className="space-y-0.5">
                                      {r.dataGaps.length === 0 && <li className="text-ink-3">None declared</li>}
                                      {r.dataGaps.map((g, i) => (
                                        <li key={i} className="min-w-0 break-words">{g}</li>
                                      ))}
                                    </ul>
                                  </Field>
                                </div>

                                <div className="flex justify-end">
                                  <button
                                    onClick={() => void generate([row.ticker], { force: true, webFill: true })}
                                    disabled={busy}
                                    className={BTN22}
                                    title="Regenerate with web search allowed to fill declared data gaps (reputable sources only)"
                                  >
                                    Regenerate with web fill
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        {isOpen && !r && (
                          <tr>
                            <td colSpan={COLS} className="h-auto whitespace-normal bg-surface-2 px-4 py-3 align-top text-[12.5px]">
                              {blocked[row.ticker] ? (
                                <div className="space-y-2">
                                  <div className="font-medium text-neg">Not generated — required evidence unavailable</div>
                                  <ul className="list-disc pl-4 text-ink-2">
                                    {blocked[row.ticker].map((m, i) => (
                                      <li key={i}>{m}</li>
                                    ))}
                                  </ul>
                                  <div className="text-ink-3">Nothing was cached or logged. Retry first — these are usually transient upstream timeouts.</div>
                                  <div className="flex gap-2">
                                    <button onClick={() => void generate([row.ticker], { force: true })} disabled={busy} className={BTN22}>
                                      Retry
                                    </button>
                                    <button
                                      onClick={() => void generate([row.ticker], { force: true, allowIncomplete: true })}
                                      disabled={busy}
                                      className={BTN22}
                                      title="Generate anyway from the evidence that IS available. The result is permanently marked incomplete — do not rely on it as a clean read."
                                    >
                                      Generate anyway (incomplete)
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center gap-2 text-ink-3">
                                  {row.evidence && <EvidenceIcons evidence={row.evidence} />}
                                  <span>No synthesis yet — hit Generate to build one from the current evidence.</span>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div className="mt-auto flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
              {visibleRows.length} of {allRows.length}
              {latestGenerated ? ` · verdicts as of ${latestGenerated}` : ""}
            </div>
          )}
        </section>

        <IdeasRail pipeline={pipeline} />
      </div>
    </div>
  );
}
