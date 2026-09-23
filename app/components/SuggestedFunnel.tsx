"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ZERO_SCORES as ALL_ZERO_SCORES } from "@/app/lib/types";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { computeScores } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { useTableSort } from "@/app/lib/useTableSort";
import { SUGGESTED_MIN_LISTS } from "@/app/lib/research-ranked";
import type { SuggestedRow, SuggestedDecision } from "@/app/lib/suggested-watchlist";
import type { SynthesisVerdict } from "@/app/lib/synthesis-screen-display";
import { skewWord, SKEW_TONE } from "@/app/lib/synthesis-screen-display";
import type { Stock, ScoreExplanations } from "@/app/lib/types";
import { LaneChip } from "@/app/components/LaneChecklist";
import type { LaneRead } from "@/app/lib/lanes";
import { computeSetup } from "@/app/lib/setup-grade";

const DECISION_DOT: Record<SuggestedDecision, { dot: string; text: string; word: string }> = {
  advance: { dot: "bg-pos", text: "text-pos", word: "Advance" },
  watch: { dot: "bg-warn", text: "text-warn", word: "Watch" },
  pass: { dot: "bg-ink-faint", text: "text-ink-3", word: "Pass" },
};

/** A promoted name starts unscored — the scoring flow fills it in. */
// Every category at 0 — one shared literal (types.ts) so a new category can't break this file.
const ZERO_SCORES = ALL_ZERO_SCORES;

type Payload = {
  rows: SuggestedRow[];
  passed: SuggestedRow[];
  initialBuildAt: string | null;
  updatedAt: string | null;
};

type SynthesisMeta = { verdict: SynthesisVerdict; skew: number; stale: boolean; generatedAt: string };

/* Control vocabulary: 28px toolbar controls; in-row buttons follow the Ideas
   canvas (22px, 11.5px) so they sit inside a 34px row. */
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
  const { stocks, addStock, marketData } = useStocks();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  // ── Staging records (pm:stocks-suggested) ─────────────────────────
  // Every qualifying name has a Stock-shaped record where its provider data
  // (MarketEdge / SIA / BoostedAI) lands and where an on-demand score is kept,
  // so a name arrives on the Watchlist already carrying what we gathered while
  // it sat here. Keyed by upper-cased ticker.
  const [records, setRecords] = useState<Map<string, Stock>>(new Map());
  const [scoringTicker, setScoringTicker] = useState<string | null>(null);
  const [scoreErr, setScoreErr] = useState<string | null>(null);
  const loadRecords = useCallback(async () => {
    try {
      const r = await fetch("/api/kv/stocks-suggested", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d?.stocks)) return;
      setRecords(new Map((d.stocks as Stock[]).map((s) => [s.ticker.toUpperCase(), s])));
    } catch { /* leave what we have */ }
  }, []);
  useEffect(() => { void loadRecords(); }, [loadRecords]);
  const recordFor = useCallback(
    (row: SuggestedRow) => records.get(row.ticker.toUpperCase()) ?? records.get(row.key.toUpperCase()),
    [records],
  );

  /**
   * Score one staging name on demand. Same /api/score call the book uses; the
   * result is merged into the staging record rather than into pm:stocks (the
   * KV route merges ONE record, so this can never clobber the sync or an
   * ingest that ran in between). Never automatic — a full score is the
   * expensive path and this list turns over weekly.
   */
  const scoreOne = async (row: SuggestedRow) => {
    const rec = recordFor(row);
    if (!rec || scoringTicker) return;
    setScoringTicker(row.ticker);
    setScoreErr(null);
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: rec.ticker }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setScoreErr(`${displayTicker(row.ticker)}: ${data?.error ?? `scoring failed (HTTP ${res.status})`}`);
        return;
      }
      const fields: Record<string, unknown> = {};
      if (data.name) fields.name = data.name;
      if (data.sector) fields.sector = data.sector;
      if (typeof data.beta === "number") fields.beta = data.beta;
      if (typeof data.price === "number") fields.price = data.price;
      if (data.companySummary) fields.companySummary = data.companySummary;
      if (data.investmentThesis) fields.investmentThesis = data.investmentThesis;
      if (data.bearCase) fields.bearCase = data.bearCase;
      if (data.healthData) fields.healthData = data.healthData;
      const merge = await fetch("/api/kv/stocks-suggested", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: rec.ticker,
          scores: data.scores ?? {},
          explanations: (data.explanations ?? {}) as ScoreExplanations,
          lastScored: new Date().toISOString(),
          fields,
        }),
      });
      if (!merge.ok) setScoreErr(`${displayTicker(row.ticker)}: scored, but saving failed`);
      await loadRecords();
    } catch (e) {
      setScoreErr(`${displayTicker(row.ticker)}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScoringTicker(null);
    }
  };
  const [requesting, setRequesting] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [ccy, setCcy] = useState<"All" | "CAD" | "USD">("All");
  const [synthesis, setSynthesis] = useState<Map<string, SynthesisMeta>>(new Map());
  // Thesis / Tactical lane per name, read-only from the cached entry scan.
  const [lanes, setLanes] = useState<Map<string, LaneRead>>(new Map());
  useEffect(() => {
    let alive = true;
    fetch("/api/entry-scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.rows)) return;
        const m = new Map<string, LaneRead>();
        for (const row of d.rows) if (row?.lane) m.set(String(row.ticker).toUpperCase(), row.lane as LaneRead);
        setLanes(m);
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
          if (row?.ticker && v) m.set(String(row.ticker).toUpperCase(), { verdict: v, skew: Number(row.entry.result.skew ?? 0), stale: Array.isArray(row.stale) && row.stale.length > 0, generatedAt: row.entry.generatedAt });
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
      if (j.staging) {
        const st = j.staging as { created?: string[]; pruned?: string[]; fellOff?: string[]; total?: number };
        setStatus((prev) => `${prev ?? ""} · staging ${st.total ?? 0} records (+${st.created?.length ?? 0} new${st.pruned?.length ? `, ${st.pruned.length} pruned` : ""})`);
      }
      await Promise.all([load(), loadRecords()]);
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
    // The staging record is the starting point when there is one: it carries
    // whatever landed while the name sat in the funnel — MarketEdge opinion,
    // SIA SMAX, BoostedAI rating, and an on-demand score with its
    // explanations. Promoting without it would throw all of that away and the
    // name would arrive on the Watchlist blank.
    const staged = recordFor(row);
    let name = staged?.name || row.name || row.ticker;
    let sector = staged?.sector || row.sector || "Technology";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(row.ticker)}`);
      if (res.ok) {
        const d = await res.json();
        if (d.names?.[row.ticker]) name = d.names[row.ticker];
        if (d.sectors?.[row.ticker]) sector = d.sectors[row.ticker];
      }
    } catch { /* keep the list's values */ }
    const base: Stock = staged
      ? { ...staged, suggestedSince: undefined, fallenOffAt: undefined } as Stock
      : { ticker: row.ticker, name, bucket: "Watchlist", sector, beta: 1.0, weights: { portfolio: 0 }, scores: { ...ZERO_SCORES }, notes: "" };
    const stock: Stock = { ...base, ticker: row.ticker, name, sector, bucket: "Watchlist" };
    addStock(stock);
    // The next Suggested refresh drops the staging copy (the book now tracks
    // the name); its data has just moved across.
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
  const all = ccy === "All" ? base : base.filter((r) => r.currency === ccy);
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
          <button type="button" onClick={refresh} disabled={refreshing} className={BTN_PRI}>
            <AppIcon name="refresh" size={13} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Meta strip: where the list comes from and the last refresh's result. */}
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
        <span>
          From the <Link href="/research" className="!text-accent hover:underline">ranked Research table</Link>
          {" "}· next: <Link href="/synthesis" className="!text-accent hover:underline">Synthesis › Suggested</Link>
        </span>
        {status && <span className="text-ink-2">{status}</span>}
        {scoreErr && <span className="text-neg">{scoreErr}</span>}
        {scoringTicker && <span className="text-ink-2">Scoring {displayTicker(scoringTicker)}…</span>}
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
          <table className="data-table min-w-[820px]">
            <thead>
              <tr>
                <th className={`!pl-3.5 ${TH_SORT}`} onClick={() => toggle("ticker")}>Name<SortIcon col="ticker" sortKey={sortKey} dir={sortDir} /></th>
                <th className={`n ${TH_SORT}`} onClick={() => toggle("lists")} title="How many research lists carry the name (sources on hover)">Lists<SortIcon col="lists" sortKey={sortKey} dir={sortDir} /></th>
                <th className="n" title="Conviction composite, scored on demand — nothing is scored automatically">Score</th>
                <th title="Analyst reports (RBC / JPM / Morningstar) and FactSet alert emails on file — the evidence a synthesis and a thesis are built from">Reports &amp; FactSet</th>
                <th title="Latest synthesis: Bull / Neutral / Bear, when it was generated, and whether a newer report has made it stale">Synthesis</th>
                <th title="Thesis or Tactical readiness — hover for the checklist">Lane</th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const h = held(r);
                const syn = synthesis.get(r.ticker.toUpperCase()) ?? synthesis.get(r.key.toUpperCase());
                const lane = lanes.get(r.ticker.toUpperCase()) ?? lanes.get(r.key.toUpperCase());
                const rec = recordFor(r);
                const scored = rec?.lastScored ? computeScores(rec, marketData) : null;
                const setupGrade = rec ? computeSetup(rec).grade : null;
                const word = syn ? skewWord(syn.skew) : null;
                const reportsOn = (["rbc", "jpm", "morningstar"] as const).filter((src) => r.reports?.[src]);
                return (
                  <tr key={r.key}>
                    <td className="!pl-3.5">
                      <TickerLink ticker={r.heldTicker ?? r.ticker} className="font-mono font-medium text-ink hover:underline">{displayTicker(r.ticker)}</TickerLink>
                      <span className="ml-2 hidden max-w-[180px] truncate text-[11.5px] text-ink-3 md:inline" title={r.name}>{r.name}</span>
                      {r.isNew && <span className="ml-2 text-[11px] text-pos">New</span>}
                      {r.bearish.length > 0 && (
                        <span className="ml-2 text-[11px] text-neg" title={`Bearish view: ${r.bearish.map((b) => b.label).join(", ")}`}>Bearish</span>
                      )}
                    </td>
                    <td className="n" title={r.lists.map((l) => l.label).join(" · ")}>
                      {r.listCount}
                      {r.listDelta !== 0 && <span className={`ml-1 text-[11px] ${r.listDelta > 0 ? "text-pos" : "text-neg"}`}>{r.listDelta > 0 ? "+" : ""}{r.listDelta}</span>}
                    </td>
                    <td className="n">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {scored ? (
                          <span className="font-mono text-ink" title={`${scored.ratingLabel} · scored ${rec?.lastScored?.slice(0, 10)}${setupGrade ? ` · setup ${setupGrade}` : ""}`}>{scored.adjusted.toFixed(1)}</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                        {!h && rec && (
                          <button type="button" onClick={() => scoreOne(r)} disabled={scoringTicker != null} className={ROW_BTN} title={rec.lastScored ? "Re-score this name (full composite pass)" : "Score this name now (full composite pass)"}>
                            {scoringTicker === r.ticker ? "…" : rec.lastScored ? "Re-score" : "Score"}
                          </button>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-2 text-[11px]">
                        {(["rbc", "jpm", "morningstar"] as const).map((src) => {
                          const on = r.reports?.[src];
                          const label = src === "rbc" ? "RBC" : src === "jpm" ? "JPM" : "MS";
                          return (
                            <span key={src} className={on ? "inline-flex items-center gap-0.5 text-pos" : "text-ink-faint"} title={on ? `${label} report on file (${on})` : `${label} report not received`}>
                              {label}{on && <AppIcon name="check" size={11} strokeWidth={2.25} />}
                            </span>
                          );
                        })}
                        <span className={r.factset ? "text-ink-2" : "text-ink-faint"} title="FactSet alert emails on file (Street Takeaways / Metrics Recap / news)">FS {r.factset ?? 0}</span>
                        {reportsOn.length === 0 && !r.coverageRequestedAt && !h && (
                          <button type="button" onClick={() => requestCov(r)} disabled={requesting === r.ticker} className={ROW_BTN} title="Queue the RBC/JPM coverage-request email to the desk">
                            {requesting === r.ticker ? "…" : "Request"}
                          </button>
                        )}
                        {r.coverageRequestedAt && reportsOn.length === 0 && <span className="text-ink-3" title={`Coverage requested ${r.coverageRequestedAt.slice(0, 10)}`}>req {r.coverageRequestedAt.slice(5, 10)}</span>}
                      </span>
                    </td>
                    <td>
                      {r.decision ? (
                        <span className="inline-flex items-center gap-1.5" title={`Decided ${r.decision.decidedAt.slice(0, 10)} · memory until ${r.decision.expiresOn}`}>
                          <span className={`dot ${DECISION_DOT[r.decision.verdict].dot}`} />
                          <span className={`text-[12px] ${DECISION_DOT[r.decision.verdict].text}`}>{DECISION_DOT[r.decision.verdict].word}</span>
                        </span>
                      ) : syn && word ? (
                        <Link href={`/synthesis#syn-${r.ticker.toUpperCase()}`} className="inline-flex items-center gap-1.5" title={`Generated ${syn.generatedAt.slice(0, 10)}${syn.stale ? " — stale: regenerate" : ""}`}>
                          <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium ${SKEW_TONE[word]}`}>{word}</span>
                          <span className="text-[11px] text-ink-3">{syn.generatedAt.slice(0, 10)}{syn.stale ? <span className="text-warn"> · stale</span> : null}</span>
                        </Link>
                      ) : reportsOn.length > 0 ? (
                        <Link href={`/synthesis?ticker=${encodeURIComponent(r.ticker)}`} className="inline-flex items-center gap-1 text-[12px] !text-accent hover:underline" title="Reports on file, no synthesis yet — generate one on the Synthesis page">
                          Needs synthesis<AppIcon name="arrowR" size={11} />
                        </Link>
                      ) : (
                        <span className="text-[12px] text-ink-faint" title="No analyst report on file yet — a synthesis would run on thin evidence. Request coverage first.">Awaiting reports</span>
                      )}
                    </td>
                    <td>{lane ? <LaneChip lane={lane} /> : <span className="text-ink-faint">—</span>}</td>
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
