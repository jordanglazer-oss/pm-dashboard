"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { useTableSort } from "@/app/lib/useTableSort";
import { SUGGESTED_MIN_LISTS } from "@/app/lib/research-ranked";
import type { SuggestedRow, SuggestedDecision } from "@/app/lib/suggested-watchlist";
import type { SynthesisVerdict } from "@/app/lib/synthesis-screen-display";
import { VERDICT_LABEL } from "@/app/lib/synthesis-screen-display";
import type { Stock, ScoreKey } from "@/app/lib/types";
import type { SuggestedAiView, PositionTier } from "@/app/lib/suggested-ai";

/** AI tier → status dot + word. Colour by job: positioned / neutral / against. */
const TIER_DOT: Record<PositionTier, { dot: string; text: string; word: string }> = {
  positioned: { dot: "bg-pos", text: "text-pos", word: "Positioned" },
  neutral: { dot: "bg-ink-faint", text: "text-ink-3", word: "Neutral" },
  against: { dot: "bg-neg", text: "text-neg", word: "Against" },
};

/** Decision memory → status dot + word. */
const DECISION_DOT: Record<SuggestedDecision, { dot: string; text: string; word: string }> = {
  advance: { dot: "bg-pos", text: "text-pos", word: "Advance" },
  watch: { dot: "bg-warn", text: "text-warn", word: "Watch" },
  pass: { dot: "bg-ink-faint", text: "text-ink-3", word: "Pass" },
};

/** A promoted name starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

type Payload = {
  rows: SuggestedRow[];
  passed: SuggestedRow[];
  initialBuildAt: string | null;
  updatedAt: string | null;
};

type SynthesisMeta = { verdict: SynthesisVerdict; stale: boolean; generatedAt: string };

/* Control vocabulary: 28px toolbar controls; in-row buttons follow the Ideas
   canvas (22px, 11.5px) so they sit inside a 34px row. */
const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-50 transition-colors";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50 transition-colors";
const ROW_BTN = "inline-flex h-[22px] items-center gap-1 rounded border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-50 transition-colors";
const TH_SORT = "cursor-pointer select-none hover:text-ink";

function SortIcon({ col, sortKey, dir }: { col: string; sortKey: string; dir: "asc" | "desc" }) {
  if (col !== sortKey) return null;
  return <AppIcon name={dir === "asc" ? "sortAsc" : "sortDesc"} size={11} className="ml-1 inline-block align-[-1px]" />;
}

/**
 * Suggested Watchlist — stage 2 of the funnel: every ranked-research name on
 * 2+ bullish lists, derived live from the Research tab. From here a name goes
 * to Synthesis (Ideas › Synthesis › Suggested) and, on an "advance" verdict,
 * onto the real Watchlist.
 *
 * The confluence-score panel this replaced (Equate + SIA movers) lives on as
 * the "Movers" tab beside it.
 */
export function SuggestedFunnel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { stocks, addStock } = useStocks();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [ccy, setCcy] = useState<"All" | "CAD" | "USD">("All");
  const [synthesis, setSynthesis] = useState<Map<string, SynthesisMeta>>(new Map());
  // AI-positioned view (pm:suggested-ai): tier + reason per name, sector backdrops.
  const [ai, setAi] = useState<{ view: SuggestedAiView | null; stale: boolean; regimeLabel: string | null } | null>(null);
  const [positioning, setPositioning] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<"all" | "positioned" | "not-against">("all");
  // The "AI adds & sector backdrops" fold persists (site rule) — closed by default.
  const [showAdds, toggleAdds] = usePersistedOpen("holdings.suggested.aiAdds.open", false);
  const loadAi = useCallback(async () => {
    try {
      const r = await fetch("/api/suggested-ai", { cache: "no-store" });
      if (r.ok) setAi(await r.json());
    } catch { /* leave as is */ }
  }, []);
  useEffect(() => { void loadAi(); }, [loadAi]);
  const positionWithAi = async () => {
    setPositioning(true);
    setAiErr(null);
    try {
      const r = await fetch("/api/suggested-ai", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setAiErr(j.error ?? "positioning failed");
      else if (j.view?.error) setAiErr(j.view.error);
      await loadAi();
    } finally {
      setPositioning(false);
    }
  };

  // Entry scorecard (met/known + ready) per name, read-only from the cached scan.
  const [setup, setSetup] = useState<Map<string, { met: number; known: number; ready: boolean; signals: string[] }>>(new Map());
  useEffect(() => {
    let alive = true;
    fetch("/api/entry-scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.rows)) return;
        const m = new Map<string, { met: number; known: number; ready: boolean; signals: string[] }>();
        for (const row of d.rows) m.set(String(row.ticker).toUpperCase(), { met: row.met, known: row.known, ready: row.ready, signals: (row.signals ?? []).filter((x: { status: string }) => x.status === "met").map((x: { label: string }) => x.label) });
        setSetup(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/suggested-watchlist", { cache: "no-store" });
      if (r.ok) {
        const d: Payload = await r.json();
        setData(d);
        onCountChange?.(d.rows.length);
      }
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  // Refresh on mount (cheap: Redis reads + at most a few outbox enqueues), then
  // read. The refresh is what stamps first-seen dates and sends coverage
  // requests for names that entered since last time.
  useEffect(() => {
    let alive = true;
    (async () => {
      try { await fetch("/api/suggested-watchlist", { method: "POST" }); } catch { /* read anyway */ }
      if (alive) await load();
    })();
    return () => { alive = false; };
  }, [load]);

  // Synthesis verdicts for the Suggested section (read-only, same endpoint the
  // Synthesis page renders from).
  useEffect(() => {
    let alive = true;
    fetch("/api/synthesis-screen")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.rows)) return;
        const m = new Map<string, SynthesisMeta>();
        for (const row of d.rows) {
          const v = row?.entry?.result?.verdict;
          if (row?.ticker && v) m.set(String(row.ticker).toUpperCase(), { verdict: v, stale: Array.isArray(row.stale) && row.stale.length > 0, generatedAt: row.entry.generatedAt });
        }
        setSynthesis(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setStatus(null);
    try {
      const r = await fetch("/api/suggested-watchlist", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setStatus(
          j.isInitialBuild
            ? `Initial build: ${j.qualifying} names. Coverage emails are NOT sent on the first build — use "Request" per row.`
            : `${j.qualifying} names · ${j.newTickers?.length ?? 0} new · ${j.coverageRequested?.length ?? 0} coverage request${(j.coverageRequested?.length ?? 0) === 1 ? "" : "s"} queued`,
        );
      } else setStatus(j.error ?? "Refresh failed");
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const held = useCallback(
    (row: SuggestedRow) => row.held ?? (stocks.find((s) => s.ticker.toUpperCase().replace(/-T$/, ".TO") === row.ticker.toUpperCase()) ? "Watchlist" : undefined),
    [stocks],
  );

  const promote = async (row: SuggestedRow) => {
    setAdding(row.ticker);
    let name = row.name || row.ticker;
    let sector = row.sector || "Technology";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(row.ticker)}`);
      if (res.ok) {
        const d = await res.json();
        if (d.names?.[row.ticker]) name = d.names[row.ticker];
        if (d.sectors?.[row.ticker]) sector = d.sectors[row.ticker];
      }
    } catch { /* keep the list's values */ }
    const stock: Stock = { ticker: row.ticker, name, bucket: "Watchlist", sector, beta: 1.0, weights: { portfolio: 0 }, scores: { ...ZERO_SCORES }, notes: "" };
    addStock(stock);
    // Remember the choice so the Synthesis Suggested tab shows it as advanced.
    void fetch("/api/kv/synthesis-decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: row.ticker, verdict: "advance" }) }).catch(() => {});
    setAdding(null);
  };

  const requestCov = async (row: SuggestedRow) => {
    setRequesting(row.ticker);
    try {
      await fetch("/api/watchlist-notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: row.ticker, reason: "suggested" }) });
      await load();
    } finally {
      setRequesting(null);
    }
  };

  const restore = async (row: SuggestedRow) => {
    await fetch("/api/kv/synthesis-decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: row.ticker, verdict: "clear" }) });
    await load();
  };

  const base = data ? (showPassed ? data.passed : data.rows) : [];
  const tierOf = (r: SuggestedRow): PositionTier | undefined => ai?.view?.names[r.ticker.toUpperCase()]?.tier ?? ai?.view?.names[`${r.key.toUpperCase()}.TO`]?.tier ?? ai?.view?.names[r.key.toUpperCase()]?.tier;
  const byTier = tierFilter === "all" ? base : base.filter((r) => { const t = tierOf(r); return tierFilter === "positioned" ? t === "positioned" : t !== "against"; });
  const all = ccy === "All" ? byTier : byTier.filter((r) => r.currency === ccy);
  // "AI adds": names the model calls positioned that sit on only ONE list —
  // the widening move the pure count can't make. Shown below the table.
  const suggestedSet = new Set(base.map((r) => r.ticker.toUpperCase()));
  const aiAdds = ai?.view ? Object.entries(ai.view.names).filter(([t, v]) => v.tier === "positioned" && !suggestedSet.has(t)).sort((x, y) => y[1].listCount - x[1].listCount) : [];
  const { sorted, toggle, key: sortKey, dir: sortDir } = useTableSort(
    all,
    {
      ticker: (r) => r.ticker,
      name: (r) => r.name || null,
      sector: (r) => r.sector || null,
      lists: (r) => r.listCount,
      seen: (r) => r.firstSeenAt ?? null,
    },
    "lists",
  );

  const cadCount = base.filter((r) => r.currency === "CAD").length;
  const usdCount = base.length - cadCount;
  const positionedCount = ai?.view ? Object.values(ai.view.names).filter((n) => n.tier === "positioned").length : 0;

  return (
    <section className="panel">
      {/* Header: title · meta · controls (28px, .seg for every switcher). */}
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Suggested</span>
        <span className="m">
          Names on {SUGGESTED_MIN_LISTS}+ research lists
          {data?.updatedAt ? ` · updated ${new Date(data.updatedAt).toLocaleDateString()}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="seg" title="Currency, from the ticker suffix">
            {(["All", "CAD", "USD"] as const).map((c) => (
              <button key={c} type="button" onClick={() => setCcy(c)} className={ccy === c ? "on" : ""}>
                {c}
                {c !== "All" && <span className="c">{c === "CAD" ? cadCount : usdCount}</span>}
              </button>
            ))}
          </div>
          <div className="seg" title="Names you passed on in the last 30 days are hidden from the live list until the memory expires">
            <button type="button" onClick={() => setShowPassed(false)} className={!showPassed ? "on" : ""}>
              Live <span className="c">{data?.rows.length ?? 0}</span>
            </button>
            <button type="button" onClick={() => setShowPassed(true)} className={showPassed ? "on" : ""}>
              Passed <span className="c">{data?.passed.length ?? 0}</span>
            </button>
          </div>
          <div className="seg" title="Filter by the AI positioning tier">
            {([["all", "All"], ["not-against", "Not against"], ["positioned", "Positioned"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTierFilter(k)} disabled={!ai?.view} className={`${tierFilter === k ? "on" : ""} disabled:cursor-default disabled:opacity-40`}>
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={positionWithAi}
            disabled={positioning}
            className={BTN}
            title="Tier every ranked research name (positioned / neutral / against) given the regime, the brief, sector & industry leadership and each name's own reads. About one model call per sector."
          >
            <AppIcon name="spark" size={13} />
            {positioning ? "Positioning…" : "Position with AI"}
          </button>
          <button type="button" onClick={refresh} disabled={refreshing} className={BTN_PRI}>
            <AppIcon name="refresh" size={13} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Meta strip: where the list comes from, the AI view's vintage, the last refresh's result. */}
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
        <span>
          From the <Link href="/research" className="!text-accent hover:underline">ranked Research table</Link>
          {" "}· next: <Link href="/synthesis" className="!text-accent hover:underline">Synthesis › Suggested</Link>
        </span>
        {ai?.view ? (
          <span className="inline-flex items-center gap-1.5">
            AI view {ai.view.generatedAt.slice(0, 10)}{ai.view.regimeLabel ? ` · regime ${ai.view.regimeLabel}` : ""}{ai.view.briefDate ? ` · brief ${ai.view.briefDate}` : ""} ·{" "}
            <span className="text-pos">{positionedCount} positioned</span> of {ai.view.namesConsidered}
            {ai.stale && (
              <span className="inline-flex items-center gap-1.5 text-warn"><span className="dot bg-warn" />Stale</span>
            )}
          </span>
        ) : (
          <span>No AI positioning yet — &ldquo;Position with AI&rdquo; tiers every ranked name against today&apos;s backdrop (≈ one call per sector).</span>
        )}
        {status && <span className="text-ink-2">{status}</span>}
        {aiErr && <span className="text-neg">{aiErr}</span>}
      </div>

      {loading ? (
        <p className="px-3.5 py-6 text-center text-[12.5px] text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <EmptyState
          glyph={<AppIcon name="list" size={16} />}
          title={showPassed ? "Nothing passed in the last 30 days" : "No suggested names yet"}
          body={showPassed ? undefined : `Names on ${SUGGESTED_MIN_LISTS}+ lists appear here. Ingest a few research lists on the Research tab first.`}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[900px]">
            <thead>
              <tr>
                <th className={`!pl-3.5 ${TH_SORT}`} onClick={() => toggle("ticker")}>Ticker<SortIcon col="ticker" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("name")}>Name<SortIcon col="name" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("sector")}>Sector<SortIcon col="sector" sortKey={sortKey} dir={sortDir} /></th>
                <th className={`n ${TH_SORT}`} onClick={() => toggle("lists")}>Lists<SortIcon col="lists" sortKey={sortKey} dir={sortDir} /></th>
                <th title="AI positioning vs today's backdrop">AI view</th>
                <th>Sources</th>
                <th title="Entry setup (signals met / known) and improving reads">Setup</th>
                <th>Synthesis</th>
                <th title="Analyst reports on file (arrivals) and when coverage was requested">Coverage</th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const h = held(r);
                const syn = synthesis.get(r.ticker.toUpperCase()) ?? synthesis.get(r.key.toUpperCase());
                const tier = ai?.view?.names[r.ticker.toUpperCase()] ?? ai?.view?.names[r.key.toUpperCase()];
                const st = setup.get(r.ticker.toUpperCase()) ?? setup.get(r.key.toUpperCase());
                return (
                  <tr key={r.key}>
                    <td className="!pl-3.5">
                      <TickerLink ticker={r.heldTicker ?? r.ticker} className="font-mono font-medium text-ink hover:underline">{displayTicker(r.ticker)}</TickerLink>
                      {r.isNew && <span className="ml-2 text-[11px] text-pos">New</span>}
                      {r.bearish.length > 0 && (
                        <span className="ml-2 text-[11px] text-neg" title={`Bearish view: ${r.bearish.map((b) => b.label).join(", ")}`}>Bearish</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate" title={r.name}><span className="text-ink-2">{r.name || "—"}</span></td>
                    <td><span className="text-ink-2">{r.sector || "—"}</span></td>
                    <td className="n">
                      {r.listCount}
                      {r.listDelta !== 0 && <span className={`ml-1 text-[11px] ${r.listDelta > 0 ? "text-pos" : "text-neg"}`}>{r.listDelta > 0 ? "+" : ""}{r.listDelta}</span>}
                    </td>
                    <td>
                      {tier ? (
                        <span className="inline-flex items-center gap-1.5" title={tier.reason}>
                          <span className={`dot ${TIER_DOT[tier.tier].dot}`} />
                          <span className={`text-[12px] ${TIER_DOT[tier.tier].text}`}>{TIER_DOT[tier.tier].word}</span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px]">
                        {r.lists.map((l, i) => (
                          <React.Fragment key={l.key}>
                            {i > 0 && <span className="text-ink-faint">·</span>}
                            <Link href={`/research/sources#${l.railKey}`} className="!text-accent hover:underline" title={l.label}>{l.short}</Link>
                          </React.Fragment>
                        ))}
                      </span>
                    </td>
                    <td>
                      {st && (
                        <span
                          className="font-mono text-[12px] text-ink"
                          title={`Entry setup: ${st.met} of ${st.known} signals met${st.signals.length ? ` — ${st.signals.join(", ")}` : ""}${st.ready ? " · READY" : ""}`}
                        >
                          {st.met}<span className="text-ink-faint">/{st.known}</span>
                          {st.ready && <span className="ml-1.5 font-sans text-[11px] text-pos">Ready</span>}
                        </span>
                      )}
                      {r.improving.length > 0 && (
                        <span className={`text-[11px] text-pos ${st ? "ml-1.5" : ""}`} title={r.improving.join(" · ")}>Improving</span>
                      )}
                      {!st && r.improving.length === 0 && <span className="text-ink-faint">—</span>}
                    </td>
                    <td>
                      {r.decision ? (
                        <span className="inline-flex items-center gap-1.5" title={`Decided ${r.decision.decidedAt.slice(0, 10)} · memory until ${r.decision.expiresOn}`}>
                          <span className={`dot ${DECISION_DOT[r.decision.verdict].dot}`} />
                          <span className={`text-[12px] ${DECISION_DOT[r.decision.verdict].text}`}>{DECISION_DOT[r.decision.verdict].word}</span>
                        </span>
                      ) : syn ? (
                        <Link href={`/synthesis#syn-${r.ticker.toUpperCase()}`} className="text-[12px] !text-accent hover:underline" title={`${VERDICT_LABEL[syn.verdict]} · ${syn.generatedAt.slice(0, 10)}${syn.stale ? " · stale" : ""}`}>
                          {VERDICT_LABEL[syn.verdict]}{syn.stale ? <span className="text-warn"> · stale</span> : null}
                        </Link>
                      ) : r.reports ? (
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="inline-flex items-center gap-1 text-[12px] !text-accent hover:underline" title="Reports on file, no synthesis yet — generate one on the Synthesis page">
                          Needs synthesis<AppIcon name="arrowR" size={11} />
                        </Link>
                      ) : (
                        <span className="text-[12px] text-ink-faint" title="No analyst report on file yet — a synthesis would run on thin evidence. Request coverage first.">Awaiting reports</span>
                      )}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-2 text-[11px]">
                        {/* Arrivals first: the reply-to-feed loop's visible end. */}
                        {(["rbc", "jpm", "morningstar"] as const).map((src) => {
                          const on = r.reports?.[src];
                          const label = src === "rbc" ? "RBC" : src === "jpm" ? "JPM" : "MS";
                          return (
                            <span
                              key={src}
                              className={on ? "inline-flex items-center gap-0.5 text-pos" : "text-ink-faint"}
                              title={on ? `${label} report on file (${on})` : `${label} report not received`}
                            >
                              {label}{on && <AppIcon name="check" size={11} strokeWidth={2.25} />}
                            </span>
                          );
                        })}
                        {r.coverageRequestedAt ? (
                          <span className="text-ink-3" title={`Coverage requested ${r.coverageRequestedAt.slice(0, 10)}`}>req {r.coverageRequestedAt.slice(5, 10)}</span>
                        ) : h ? null : (
                          <button type="button" onClick={() => requestCov(r)} disabled={requesting === r.ticker} className={ROW_BTN} title="Queue the RBC/JPM coverage-request email to the desk">
                            {requesting === r.ticker ? "…" : "Request"}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="!text-right">
                      {showPassed ? (
                        <button type="button" onClick={() => restore(r)} className={ROW_BTN}>Restore</button>
                      ) : h ? (
                        <span className="text-[11.5px] text-ink-3">{h}</span>
                      ) : (
                        <button type="button" onClick={() => promote(r)} disabled={adding === r.ticker} className={ROW_BTN}>
                          <AppIcon name="plus" size={11} strokeWidth={2.25} />
                          {adding === r.ticker ? "…" : "Watchlist"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* AI adds & sector backdrops — folded one click away, persisted. */}
      {ai?.view && (aiAdds.length > 0 || Object.keys(ai.view.sectorBackdrops).length > 0) && (
        <div className="border-t border-line-soft">
          <button type="button" onClick={toggleAdds} aria-expanded={showAdds} className="flex h-8 w-full items-center gap-1.5 px-3.5 text-[12px] text-ink-2 hover:text-ink">
            <AppIcon name={showAdds ? "chevD" : "chevR"} size={12} strokeWidth={2} className="text-ink-3" />
            AI adds <span className="font-mono text-[11px] text-ink-3">{aiAdds.length}</span>
            <span className="text-ink-3">· sector backdrops</span>
          </button>
          {showAdds && (
            <div className="flex flex-col gap-2 px-3.5 pb-3">
              {aiAdds.length > 0 && (
                <div>
                  <p className="text-[11px] text-ink-3">Positioned names on fewer than {SUGGESTED_MIN_LISTS} lists — the model widening the funnel. Not on the Suggested list unless you add them.</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    {aiAdds.map(([t, v]) => (
                      <span key={t} className="inline-flex items-center gap-1.5 text-[12px]" title={v.reason}>
                        <span className="dot bg-pos" />
                        <TickerLink ticker={t} className="font-mono font-medium text-ink hover:underline">{displayTicker(t)}</TickerLink>
                        <span className="text-ink-3">{v.listCount} list · {v.sector || "—"}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {Object.entries(ai.view.sectorBackdrops).map(([sector, text]) => (
                <p key={sector} className="text-[12px] leading-5 text-ink-2"><span className="font-medium text-ink">{sector}:</span> {text}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer strip — same as the Holdings table. */}
      {!loading && sorted.length > 0 && (
        <div className="flex h-8 items-center justify-between border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          <span>{sorted.length} of {base.length} · sorted by {sortKey}</span>
          <span className="hidden sm:inline">{cadCount} CAD · {usdCount} USD</span>
        </div>
      )}
    </section>
  );
}
