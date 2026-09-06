"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { useTableSort } from "@/app/lib/useTableSort";
import { SUGGESTED_MIN_LISTS } from "@/app/lib/research-ranked";
import type { SuggestedRow, SuggestedDecision } from "@/app/lib/suggested-watchlist";
import type { SynthesisVerdict } from "@/app/lib/synthesis-screen-display";
import { VERDICT_LABEL } from "@/app/lib/synthesis-screen-display";
import type { Stock, ScoreKey } from "@/app/lib/types";
import type { SuggestedAiView, PositionTier } from "@/app/lib/suggested-ai";

const TIER_STYLE: Record<PositionTier, string> = {
  positioned: "bg-pos text-white ring-pos",
  neutral: "bg-surface-2 text-ink-2 ring-line",
  against: "bg-neg-soft text-neg ring-neg-border",
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

const DECISION_STYLE: Record<SuggestedDecision, string> = {
  advance: "bg-pos-soft text-pos ring-pos-border",
  watch: "bg-warn-soft text-warn ring-warn-border",
  pass: "bg-surface-2 text-ink-3 ring-line",
};

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
  const [showAdds, setShowAdds] = useState(false);
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
  const { sorted, toggle, arrow } = useTableSort(
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
  const th = "pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";
  const thSort = `${th} cursor-pointer select-none hover:text-ink`;

  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Suggested Watchlist</h2>
          <p className="text-xs text-ink-3">
            Names on {SUGGESTED_MIN_LISTS}+ research lists, straight from the{" "}
            <Link href="/research" className="font-semibold !text-accent hover:underline">ranked Research table</Link>.
            {data?.updatedAt ? ` Updated ${new Date(data.updatedAt).toLocaleDateString()}.` : ""}
            {" "}Next: <Link href="/synthesis" className="font-semibold !text-accent hover:underline">Synthesis › Suggested</Link>.
          </p>
          {status && <p className="mt-1 text-[11px] text-ink-2">{status}</p>}
          {ai?.view ? (
            <p className="mt-1 text-[11px] text-ink-3">
              AI view {ai.view.generatedAt.slice(0, 10)}{ai.view.regimeLabel ? ` · regime ${ai.view.regimeLabel}` : ""}{ai.view.briefDate ? ` · brief ${ai.view.briefDate}` : ""} ·{" "}
              <span className="font-semibold text-pos">{Object.values(ai.view.names).filter((n) => n.tier === "positioned").length} positioned</span> of {ai.view.namesConsidered}
              {ai.stale && <span className="ml-1 rounded bg-warn-soft px-1 py-px text-[9px] font-bold uppercase text-warn ring-1 ring-warn-border">stale</span>}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-ink-3">No AI positioning yet — &ldquo;Position with AI&rdquo; tiers every ranked name against today&apos;s backdrop (≈ one call per sector).</p>
          )}
          {aiErr && <p className="mt-1 text-[11px] text-neg">{aiErr}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5">
            {(["All", "CAD", "USD"] as const).map((c) => (
              <button key={c} onClick={() => setCcy(c)} className={`rounded-[6px] px-2.5 py-1 font-semibold transition-colors ${ccy === c ? "bg-accent text-white" : "text-ink-2 hover:text-ink"}`}>
                {c}
                {c !== "All" && <span className={`ml-1 font-normal ${ccy === c ? "text-white/70" : "text-ink-3"}`}>{c === "CAD" ? cadCount : usdCount}</span>}
              </button>
            ))}
          </span>
          <button
            onClick={() => setShowPassed((v) => !v)}
            className={`rounded-control border px-3 py-1.5 font-semibold ${showPassed ? "border-neg-border bg-neg-soft text-neg" : "border-line text-ink-2 hover:text-ink"}`}
            title="Names you passed on in the last 30 days (hidden from the list until the memory expires)"
          >
            {showPassed ? `Showing passed (${data?.passed.length ?? 0})` : `Passed (${data?.passed.length ?? 0})`}
          </button>
          <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5" title="Filter by the AI positioning tier">
            {([["all", "All"], ["not-against", "Not against"], ["positioned", "Positioned"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTierFilter(k)} disabled={!ai?.view} className={`rounded-[6px] px-2.5 py-1 font-semibold transition-colors disabled:opacity-40 ${tierFilter === k ? "bg-pos text-white" : "text-ink-2 hover:text-ink"}`}>
                {label}
              </button>
            ))}
          </span>
          <button
            onClick={positionWithAi}
            disabled={positioning}
            className="rounded-control border border-pos-border bg-pos-soft px-3 py-1.5 font-semibold text-pos hover:bg-pos hover:text-white transition-colors disabled:opacity-50"
            title="Tier every ranked research name (positioned / neutral / against) given the regime, the brief, sector & industry leadership and each name's own reads. About one model call per sector."
          >
            {positioning ? "Positioning…" : "✦ Position with AI"}
          </button>
          <button onClick={refresh} disabled={refreshing} className="rounded-control bg-accent px-3 py-1.5 font-semibold !text-white disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-xs text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-8 text-center text-xs text-ink-3">
          {showPassed ? "Nothing passed in the last 30 days." : `No names on ${SUGGESTED_MIN_LISTS}+ lists yet. Ingest a few research lists on the Research tab first.`}
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={thSort} onClick={() => toggle("ticker")}>Ticker{arrow("ticker")}</th>
                <th className={thSort} onClick={() => toggle("name")}>Name{arrow("name")}</th>
                <th className={thSort} onClick={() => toggle("sector")}>Sector{arrow("sector")}</th>
                <th className={`${thSort} text-right`} onClick={() => toggle("lists")}>Lists{arrow("lists")}</th>
                <th className={th} title="AI positioning vs today's backdrop">AI view</th>
                <th className={th}>Sources</th>
                <th className={th} title="Entry setup (signals met / known) and improving reads">Setup</th>
                <th className={th}>Synthesis</th>
                <th className={th} title="Analyst reports on file (arrivals) and when coverage was requested">Coverage</th>
                <th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const h = held(r);
                const syn = synthesis.get(r.ticker.toUpperCase()) ?? synthesis.get(r.key.toUpperCase());
                return (
                  <tr key={r.key} className="border-b border-line-soft hover:bg-surface-hover">
                    <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-ink whitespace-nowrap">
                      <TickerLink ticker={r.heldTicker ?? r.ticker}>{displayTicker(r.ticker)}</TickerLink>
                      {r.isNew && <span className="ml-1.5 rounded-full bg-pos-soft px-1.5 py-px text-[9px] font-bold uppercase text-pos ring-1 ring-pos-border">New</span>}
                      {r.bearish.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-neg-soft px-1.5 py-px text-[9px] font-bold uppercase text-neg ring-1 ring-neg-border" title={`Bearish view: ${r.bearish.map((b) => b.label).join(", ")}`}>Bearish</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate py-2.5 pr-3 text-ink" title={r.name}>{r.name || "—"}</td>
                    <td className="py-2.5 pr-3 text-xs text-ink-2">{r.sector || "—"}</td>
                    <td className="py-2.5 pr-3 text-right font-mono font-semibold tabular-nums text-ink">
                      {r.listCount}
                      {r.listDelta !== 0 && <span className={`ml-1 text-[10px] ${r.listDelta > 0 ? "text-pos" : "text-neg"}`}>{r.listDelta > 0 ? "+" : ""}{r.listDelta}</span>}
                    </td>
                    <td className="py-2.5 pr-3">
                      {(() => {
                        const n = ai?.view?.names[r.ticker.toUpperCase()] ?? ai?.view?.names[r.key.toUpperCase()];
                        if (!n) return <span className="text-[11px] text-ink-faint">—</span>;
                        return (
                          <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-bold uppercase ring-1 ${TIER_STYLE[n.tier]}`} title={n.reason}>
                            {n.tier}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap gap-1">
                        {r.lists.map((l) => (
                          <Link key={l.key} href={`/research/sources#${l.railKey}`} className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-medium !text-accent hover:bg-accent hover:!text-white transition-colors" title={l.label}>
                            {l.short}
                          </Link>
                        ))}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap items-center gap-1">
                        {(() => {
                          const st = setup.get(r.ticker.toUpperCase()) ?? setup.get(r.key.toUpperCase());
                          if (!st) return null;
                          return (
                            <span
                              className={`inline-flex items-center rounded-md px-1.5 py-px font-mono text-[10px] font-bold ${st.ready ? "bg-pos text-white" : "bg-surface-2 text-ink-2"}`}
                              title={`Entry setup: ${st.met} of ${st.known} signals met${st.signals.length ? ` — ${st.signals.join(", ")}` : ""}${st.ready ? " · READY" : ""}`}
                            >
                              {st.ready ? "READY " : ""}{st.met}/{st.known}
                            </span>
                          );
                        })()}
                        {r.improving.length > 0 && (
                          <span className="inline-flex items-center rounded-full bg-pos-soft px-1.5 py-px text-[10px] font-semibold text-pos ring-1 ring-pos-border" title={r.improving.join(" · ")}>
                            ▲ Improving
                          </span>
                        )}
                        {r.improving.length === 0 && !setup.size && <span className="text-[11px] text-ink-faint">—</span>}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {r.decision ? (
                        <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-bold uppercase ring-1 ${DECISION_STYLE[r.decision.verdict]}`} title={`Decided ${r.decision.decidedAt.slice(0, 10)} · memory until ${r.decision.expiresOn}`}>
                          {r.decision.verdict}
                        </span>
                      ) : syn ? (
                        <Link href={`/synthesis#syn-${r.ticker.toUpperCase()}`} className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold !text-accent ring-1 ring-accent-border hover:underline" title={`${VERDICT_LABEL[syn.verdict]} · ${syn.generatedAt.slice(0, 10)}${syn.stale ? " · stale" : ""}`}>
                          {VERDICT_LABEL[syn.verdict]}{syn.stale ? " ·stale" : ""}
                        </Link>
                      ) : r.reports ? (
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="text-[11px] font-semibold !text-accent hover:underline" title="Reports on file, no synthesis yet — generate one on the Synthesis page">
                          Needs synthesis →
                        </Link>
                      ) : (
                        <span className="text-[11px] text-ink-faint" title="No analyst report on file yet — a synthesis would run on thin evidence. Request coverage first.">Awaiting reports</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        {/* Arrivals first: the reply-to-feed loop's visible end. */}
                        {(["rbc", "jpm", "morningstar"] as const).map((src) => {
                          const on = r.reports?.[src];
                          const label = src === "rbc" ? "RBC" : src === "jpm" ? "JPM" : "MS";
                          return (
                            <span
                              key={src}
                              className={`rounded px-1 py-px text-[9px] font-bold ${on ? "bg-pos-soft text-pos ring-1 ring-pos-border" : "bg-surface-2 text-ink-faint"}`}
                              title={on ? `${label} report on file (${on})` : `${label} report not received`}
                            >
                              {label}{on ? " ✓" : ""}
                            </span>
                          );
                        })}
                        {r.coverageRequestedAt ? (
                          <span className="text-[10px] text-ink-3" title={`Coverage requested ${r.coverageRequestedAt.slice(0, 10)}`}>req {r.coverageRequestedAt.slice(5, 10)}</span>
                        ) : h ? null : (
                          <button onClick={() => requestCov(r)} disabled={requesting === r.ticker} className="rounded border border-line px-2 py-0.5 text-[11px] font-semibold text-ink-2 hover:text-ink disabled:opacity-50" title="Queue the RBC/JPM coverage-request email to the desk">
                            {requesting === r.ticker ? "…" : "Request"}
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {showPassed ? (
                        <button onClick={() => restore(r)} className="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:text-ink">Restore</button>
                      ) : h ? (
                        <span className="text-[11px] font-semibold text-ink-faint">{h}</span>
                      ) : (
                        <button onClick={() => promote(r)} disabled={adding === r.ticker} className="rounded bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent hover:bg-accent hover:text-white transition-colors disabled:opacity-50">
                          {adding === r.ticker ? "…" : "+ Watchlist"}
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

      {ai?.view && (aiAdds.length > 0 || Object.keys(ai.view.sectorBackdrops).length > 0) && (
        <div className="mt-3 border-t border-line pt-3">
          <button onClick={() => setShowAdds((v) => !v)} className="text-[11px] font-semibold text-ink-2 hover:text-ink">
            {showAdds ? "▾" : "▸"} AI adds ({aiAdds.length}) &amp; sector backdrops
          </button>
          {showAdds && (
            <div className="mt-2 space-y-2">
              {aiAdds.length > 0 && (
                <div>
                  <p className="text-[11px] text-ink-3">Positioned names on fewer than {SUGGESTED_MIN_LISTS} lists — the model widening the funnel. Not on the Suggested list unless you add them.</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {aiAdds.map(([t, v]) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-md border border-pos-border bg-pos-soft px-1.5 py-0.5 text-[11px]" title={v.reason}>
                        <TickerLink ticker={t} className="font-mono font-bold text-pos">{displayTicker(t)}</TickerLink>
                        <span className="text-ink-3">{v.listCount} list · {v.sector || "—"}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {Object.entries(ai.view.sectorBackdrops).map(([sector, text]) => (
                <p key={sector} className="text-[11px] text-ink-2"><span className="font-semibold text-ink">{sector}:</span> {text}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
