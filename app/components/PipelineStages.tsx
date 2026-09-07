"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppIcon } from "./AppIcon";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { rankResearch, SUGGESTED_MIN_LISTS, type RankedRow } from "@/app/lib/research-ranked";
import type { ResearchState } from "@/app/lib/defaults";
import type { SuggestedRow } from "@/app/lib/suggested-watchlist";
import type { SynthesisVerdict } from "@/app/lib/synthesis-screen-display";
import type { ThesisHealth } from "@/app/lib/thesis-health";

/**
 * The idea pipeline as ONE strip — six equal cells, Research → Suggested →
 * Synthesis → Watchlist → Portfolio → Underwritten — shared by /synthesis and
 * /funnel so the two pages can never disagree about a stage count.
 *
 * `usePipelineData` is the funnel page's data layer lifted out of the page:
 * the same read-only GETs of the surfaces that own each stage, the same
 * derivations (review queue, ready-to-buy, ready-to-advance, awaiting
 * synthesis, thesis owed). It writes nothing.
 */

export type SynthRow = {
  ticker: string;
  displayTicker?: string;
  name: string;
  bucket: "Portfolio" | "Watchlist" | "Suggested";
  entry: { generatedAt: string; result: { verdict: SynthesisVerdict; verdictReason?: string } } | null;
  stale: string[];
  decision?: { verdict: "advance" | "watch" | "pass"; expiresOn: string } | null;
};

export type KillRow = {
  ticker: string;
  tripped: number;
  auto: number;
  underwrittenAt?: string;
  reUnderwriteBy?: string;
  checks: Array<{ status: string; reading: string; condition: { kind: string; theme?: string; note?: string } }>;
};
export type Coverage = { portfolioCount: number; underwritten: number; missing: Array<{ ticker: string; name?: string; hasProse: boolean }> };
export type Health = { counts: { broken: number; eroding: number; intact: number }; holdings: Array<ThesisHealth & { name?: string }> };
export type EntryRowLite = {
  ticker: string;
  name: string;
  sector: string;
  bucket: "Watchlist" | "Suggested";
  met: number;
  known: number;
  ready: boolean;
  strength: string;
  readySince?: string;
  why?: string;
  signals: Array<{ key: string; label: string; status: string; reading: string }>;
};
export type EntryScanLite = { builtAt: string; rows: EntryRowLite[]; newlyReady: string[] };

export type ReviewRow = { ticker: string; name?: string; reasons: string[]; tone: "neg" | "warn" };

export type PipelineData = {
  loading: boolean;
  research: Partial<ResearchState> | null;
  suggested: { rows: SuggestedRow[]; passed: SuggestedRow[] } | null;
  synth: SynthRow[] | null;
  kill: { holdings: KillRow[]; coverage: Coverage } | null;
  health: Health | null;
  entry: EntryScanLite | null;
  aiPositioned: number | null;
  ranked: RankedRow[];
  portfolioCount: number;
  watchlistCount: number;
  suggestedRows: SuggestedRow[];
  synthByTicker: Map<string, SynthRow>;
  suggestedSynth: SynthRow[];
  generatedSuggested: SynthRow[];
  verdictCounts: Record<string, number>;
  awaitingSynthesis: SuggestedRow[];
  readyToAdvance: SynthRow[];
  thesisMissing: Coverage["missing"];
  review: ReviewRow[];
  readyRows: EntryRowLite[];
  buildingRows: EntryRowLite[];
  watching: SuggestedRow[];
  underwritten: number;
  coveragePortfolioCount: number;
  trippedCount: number;
};

/**
 * Read every stage from the surface that owns it. Pass `synthOverride` when
 * the caller already holds the synthesis rows (the Synthesis page) so the
 * endpoint is not fetched twice and the strip follows the page's own state.
 */
export function usePipelineData(synthOverride?: SynthRow[] | null): PipelineData {
  const { stocks } = useStocks();
  const [research, setResearch] = useState<Partial<ResearchState> | null>(null);
  const [suggested, setSuggested] = useState<{ rows: SuggestedRow[]; passed: SuggestedRow[] } | null>(null);
  const [synthFetched, setSynthFetched] = useState<SynthRow[] | null>(null);
  const [kill, setKill] = useState<{ holdings: KillRow[]; coverage: Coverage } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [entry, setEntry] = useState<EntryScanLite | null>(null);
  const [aiPositioned, setAiPositioned] = useState<number | null>(null);
  const skipSynth = synthOverride !== undefined;

  useEffect(() => {
    let alive = true;
    const get = (url: string) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    get("/api/kv/research").then((j) => alive && setResearch((j?.research ?? {}) as Partial<ResearchState>));
    get("/api/suggested-watchlist").then((j) => alive && setSuggested({ rows: j?.rows ?? [], passed: j?.passed ?? [] }));
    if (!skipSynth) get("/api/synthesis-screen").then((j) => alive && setSynthFetched(Array.isArray(j?.rows) ? j.rows : []));
    get("/api/thesis-watch").then((j) => alive && setKill({ holdings: j?.holdings ?? [], coverage: j?.coverage ?? { portfolioCount: 0, underwritten: 0, missing: [] } }));
    get("/api/thesis-health").then((j) => alive && setHealth(j?.thesisHealth ?? null));
    get("/api/entry-scan").then((j) => alive && setEntry(Array.isArray(j?.rows) ? j : null));
    get("/api/suggested-ai").then((j) => alive && setAiPositioned(j?.view?.names ? Object.values(j.view.names as Record<string, { tier: string }>).filter((n) => n.tier === "positioned").length : null));
    return () => { alive = false; };
  }, [skipSynth]);

  const synth = skipSynth ? (synthOverride ?? null) : synthFetched;

  const ranked: RankedRow[] = useMemo(() => (research ? rankResearch(research, stocks) : []), [research, stocks]);
  const portfolioCount = stocks.filter((s) => s.bucket === "Portfolio" && isScoreable(s)).length;
  const watchlistCount = stocks.filter((s) => s.bucket === "Watchlist" && isScoreable(s)).length;

  const suggestedRows = useMemo(() => suggested?.rows ?? [], [suggested]);
  const synthByTicker = useMemo(() => new Map((synth ?? []).map((r) => [r.ticker.toUpperCase(), r])), [synth]);
  const suggestedSynth = useMemo(() => (synth ?? []).filter((r) => r.bucket === "Suggested"), [synth]);
  const generatedSuggested = useMemo(() => suggestedSynth.filter((r) => r.entry), [suggestedSynth]);
  const verdictCounts = useMemo(
    () =>
      generatedSuggested.reduce<Record<string, number>>((acc, r) => {
        const v = r.entry!.result.verdict;
        acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {}),
    [generatedSuggested],
  );

  const awaitingSynthesis = useMemo(
    () => suggestedRows.filter((r) => !synthByTicker.get(r.ticker.toUpperCase())?.entry && r.decision?.verdict !== "watch").slice(0, 12),
    [suggestedRows, synthByTicker],
  );
  const readyToAdvance = useMemo(() => suggestedSynth.filter((r) => r.entry?.result.verdict === "advance" && !r.decision), [suggestedSynth]);
  const thesisMissing = useMemo(() => kill?.coverage.missing ?? [], [kill]);

  const review = useMemo<ReviewRow[]>(() => {
    const rows: ReviewRow[] = [];
    const byTicker = new Map<string, { name?: string; reasons: string[]; tone: "neg" | "warn" }>();
    const add = (t: string, reason: string, tone: "neg" | "warn", name?: string) => {
      const k = t.toUpperCase();
      const e = byTicker.get(k) ?? { name, reasons: [], tone };
      e.reasons.push(reason);
      if (tone === "neg") e.tone = "neg";
      if (name && !e.name) e.name = name;
      byTicker.set(k, e);
    };
    for (const h of health?.holdings ?? []) {
      if (h.verdict === "broken") add(h.ticker, `Thesis health: BROKEN — ${h.summary}`, "neg", h.name);
      else if (h.verdict === "eroding") add(h.ticker, `Thesis health: eroding — ${h.summary}`, "warn", h.name);
    }
    for (const k of kill?.holdings ?? []) {
      if (k.tripped > 0) {
        const tripped = k.checks.filter((c) => c.status === "tripped").map((c) => `${c.condition.theme ?? c.condition.kind}: ${c.reading}`);
        add(k.ticker, `${k.tripped} of ${k.auto} kill condition${k.auto === 1 ? "" : "s"} tripped — ${tripped.join("; ")}`, "neg");
      }
      if (k.reUnderwriteBy && k.reUnderwriteBy < new Date().toISOString().slice(0, 10)) add(k.ticker, `Re-underwrite overdue (due ${k.reUnderwriteBy})`, "warn");
    }
    for (const s of synth ?? []) {
      if (s.bucket === "Portfolio" && s.entry?.result.verdict === "exit-watch") add(s.ticker, `Synthesis: Exit watch — ${s.entry.result.verdictReason ?? ""}`, "neg", s.name);
      else if (s.bucket === "Portfolio" && s.entry?.result.verdict === "review") add(s.ticker, `Synthesis: Review — ${s.entry.result.verdictReason ?? ""}`, "warn", s.name);
    }
    for (const [ticker, e] of byTicker) rows.push({ ticker, ...e });
    rows.sort((a, b) => (a.tone === b.tone ? b.reasons.length - a.reasons.length : a.tone === "neg" ? -1 : 1));
    return rows;
  }, [health, kill, synth]);

  const readyRows = useMemo(() => (entry?.rows ?? []).filter((r) => r.ready), [entry]);
  const buildingRows = useMemo(() => (entry?.rows ?? []).filter((r) => !r.ready && r.strength === "building").slice(0, 8), [entry]);
  const watching = useMemo(() => suggestedRows.filter((r) => r.decision?.verdict === "watch"), [suggestedRows]);
  const underwritten = kill?.coverage.underwritten ?? 0;
  const coveragePortfolioCount = kill?.coverage.portfolioCount ?? portfolioCount;
  const trippedCount = (kill?.holdings ?? []).filter((k) => k.tripped > 0).length;
  const loading = !research || !suggested || !synth || !kill;

  return {
    loading, research, suggested, synth, kill, health, entry, aiPositioned, ranked,
    portfolioCount, watchlistCount, suggestedRows, synthByTicker, suggestedSynth, generatedSuggested,
    verdictCounts, awaitingSynthesis, readyToAdvance, thesisMissing, review, readyRows, buildingRows,
    watching, underwritten, coveragePortfolioCount, trippedCount,
  };
}

export type StageCell = {
  key: string;
  label: string;
  count: React.ReactNode;
  sub?: React.ReactNode;
  title?: string;
  href?: string;
  tone?: "ink" | "pos" | "warn" | "neg";
};

/** Build the six cells from the pipeline read. */
export function buildStages(d: PipelineData): StageCell[] {
  const synthAll = d.synth ?? [];
  const stale = synthAll.filter((r) => r.entry && r.stale.length > 0).length;
  const ungenerated = synthAll.filter((r) => !r.entry).length;
  const newCount = d.suggestedRows.filter((r) => r.isNew).length;
  const withSynth = synthAll.filter((r) => r.bucket === "Watchlist" && r.entry).length;
  const owed = d.thesisMissing.length;
  return [
    {
      key: "research",
      label: "Research",
      count: d.ranked.length,
      sub: <>{d.ranked.filter((r) => r.currency === "CAD").length} CAD · {d.ranked.filter((r) => r.currency === "USD").length} USD</>,
      title: "Ranked research names, by list count",
      href: "/research",
    },
    {
      key: "suggested",
      label: "Suggested",
      count: d.suggestedRows.length,
      sub: <>on {SUGGESTED_MIN_LISTS}+ lists{newCount > 0 ? ` · ${newCount} new` : ""}</>,
      title: `${d.suggested?.passed.length ?? 0} passed (30d)${d.aiPositioned != null ? ` · ${d.aiPositioned} AI-positioned` : ""}`,
      href: "/?bucket=Suggested",
    },
    {
      key: "synthesis",
      label: "Synthesis",
      count: synthAll.length,
      sub: stale > 0 ? <>{stale} stale</> : ungenerated > 0 ? <>{ungenerated} not generated</> : <>{d.verdictCounts.advance ?? 0} advance</>,
      title: `Suggested: ${d.generatedSuggested.length}/${d.suggestedSynth.length} generated · ${d.verdictCounts.advance ?? 0} advance · ${d.verdictCounts.watch ?? 0} watch · ${d.verdictCounts.pass ?? 0} pass · ${stale} stale · ${ungenerated} not generated`,
      href: "/synthesis",
    },
    {
      key: "watchlist",
      label: "Watchlist",
      count: d.watchlistCount,
      sub: <span className={d.readyRows.length > 0 ? "text-pos" : undefined}>{d.readyRows.length} ready</span>,
      title: `${withSynth} with a synthesis · ${d.readyRows.length} ready to buy`,
      href: "/?bucket=Watchlist",
      tone: d.readyRows.length > 0 ? "pos" : "ink",
    },
    {
      key: "portfolio",
      label: "Portfolio",
      count: d.portfolioCount,
      title: "Scoreable stocks (ETFs / funds excluded)",
      href: "/",
    },
    {
      key: "underwritten",
      label: "Underwritten",
      count: d.underwritten,
      sub: owed > 0 ? <span className="text-warn">{owed} owed</span> : <>every position monitored</>,
      title: `${d.underwritten} of ${d.coveragePortfolioCount} positions underwritten`,
      href: "/thesis",
      tone: owed > 0 ? "warn" : "pos",
    },
  ];
}

const TONE_CLS: Record<NonNullable<StageCell["tone"]>, string> = {
  ink: "text-ink",
  pos: "text-pos",
  warn: "text-warn",
  neg: "text-neg",
};

/** One panel, six equal cells, chevron between them. `activeKey` tints a cell. */
export function PipelineStages({ stages, activeKey, loading }: { stages: StageCell[]; activeKey?: string; loading?: boolean }) {
  return (
    <div className="panel flex items-stretch overflow-x-auto">
      {stages.map((s, i) => {
        const last = i === stages.length - 1;
        const active = s.key === activeKey;
        const inner = (
          <>
            <div className="min-w-0">
              <div className="text-[11px] text-ink-3">{s.label}</div>
              <div className={`mt-0.5 font-mono text-[20px] font-semibold leading-none tabular-nums ${TONE_CLS[s.tone ?? "ink"]}`}>
                {loading ? <span className="text-ink-faint">–</span> : s.count}
              </div>
            </div>
            <div className="ml-auto truncate text-right text-[11.5px] text-ink-3">{loading ? "" : s.sub}</div>
            {!last && <AppIcon name="chevR" size={14} strokeWidth={2} className="text-ink-faint" />}
          </>
        );
        const cls = `flex min-w-[150px] flex-1 items-center gap-3 px-4 py-3 ${last ? "" : "border-r border-line-soft"} ${active ? "bg-accent-soft" : "hover:bg-surface-hover"} transition-colors`;
        return s.href ? (
          <Link key={s.key} href={s.href} className={cls} title={s.title}>
            {inner}
          </Link>
        ) : (
          <div key={s.key} className={cls} title={s.title}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
