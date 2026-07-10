"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { computeConviction, type ConvictionSignal, type ConvictionEntry } from "@/app/lib/conviction";
import { IDEA_STATUS_LABELS, type IdeaPipelineStore, type IdeaPipelineEntry, type IdeaStatus } from "@/app/lib/idea-pipeline";
import type { ResearchState } from "@/app/lib/defaults";
import type { Stock, ScoreKey } from "@/app/lib/types";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const KIND_STYLE: Record<ConvictionSignal["kind"], string> = {
  rating: "bg-accent-soft text-accent border-accent-border",
  upside: "bg-pos-soft text-pos border-pos-border",
  external: "bg-accent-soft text-accent border-accent-border",
  list: "bg-warn-soft text-warn border-warn-border",
};

function SignalBadge({ sig }: { sig: ConvictionSignal }) {
  const neg = sig.points < 0;
  const cls = neg ? "bg-neg-soft text-neg border-neg-border" : KIND_STYLE[sig.kind];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`} title={`${sig.points >= 0 ? "+" : ""}${sig.points}`}>
      {sig.label}
      <span className="font-mono opacity-70">{sig.points >= 0 ? `+${sig.points}` : sig.points}</span>
    </span>
  );
}

/** Regime-fit badge from the AI synthesis (how the name fits the current market regime). */
function RegimeBadge({ fit }: { fit: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    high: { cls: "bg-pos-soft text-pos border-pos-border", label: "Regime ✓" },
    medium: { cls: "bg-surface-2 text-ink-2 border-line", label: "Regime ~" },
    low: { cls: "bg-warn-soft text-warn border-warn-border", label: "Regime ✕" },
    contrary: { cls: "bg-neg-soft text-neg border-neg-border", label: "Contrarian" },
  };
  const m = map[fit];
  if (!m) return null;
  return <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${m.cls}`} title={`Regime fit: ${fit}`}>{m.label}</span>;
}

/** Conviction total pill — colored by magnitude. */
function TotalPill({ total }: { total: number }) {
  const cls =
    total >= 6 ? "bg-pos text-white"
    : total >= 3 ? "bg-pos-soft text-pos border border-pos-border"
    : total >= 1 ? "bg-surface-2 text-ink border border-line"
    : total <= -2 ? "bg-neg text-white"
    : "bg-surface-2 text-ink-3 border border-line";
  return <span className={`inline-block rounded-lg px-2.5 py-1 text-sm font-bold tabular-nums ${cls}`}>{total > 0 ? `+${total}` : total}</span>;
}

type BucketFilter = "ideas" | "all" | "Portfolio" | "Watchlist" | "Research";

export default function ConvictionPage() {
  const { scoredStocks, analystSnapshots, addStock } = useStocks();

  // Add a research-only name to the Watchlist (mirrors the Research page).
  const addToWatchlist = async (ticker: string, fallbackName?: string) => {
    if (scoredStocks.some((s) => s.ticker === ticker)) return;
    let name = fallbackName || ticker;
    let sector = "Technology";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[ticker]) name = data.names[ticker];
        if (data.sectors?.[ticker]) sector = data.sectors[ticker];
      }
    } catch { /* fallback */ }
    const stock: Stock = {
      ticker, name, bucket: "Watchlist", sector, beta: 1.0,
      weights: { portfolio: 0 }, scores: { ...ZERO_SCORES }, notes: "",
    };
    addStock(stock);
  };
  const [research, setResearch] = useState<ResearchState | null>(null);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [filter, setFilter] = useState<BucketFilter>("ideas");
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Synthesis narrative keyed by normalized ticker (AI thesis + regime fit) —
  // enriches the quantitative board with the "why" and regime context.
  const [synthesisByKey, setSynthesisByKey] = useState<Map<string, { thesis?: string; regimeFit?: string; regimeFitRationale?: string }>>(new Map());
  const [pipeline, setPipeline] = useState<IdeaPipelineStore>({});

  // Load the idea-pipeline tracking store.
  useEffect(() => {
    fetch("/api/kv/idea-pipeline", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: IdeaPipelineStore) => setPipeline(data || {}))
      .catch(() => {});
  }, []);

  // Persist a status change (or a fresh surfacing) for one idea, merging server-side.
  const savePipeline = (patch: Record<string, IdeaPipelineEntry>) => {
    setPipeline((prev) => ({ ...prev, ...patch }));
    fetch("/api/kv/idea-pipeline", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: patch }),
    }).catch(() => {});
  };

  // Load the research blob (all source lists).
  useEffect(() => {
    fetch("/api/kv/research", { cache: "no-store" })
      .then((r) => r.json())
      // The KV route wraps the blob as { research: ... } — unwrap it (fall back
      // to the raw payload for safety). Without this the lists are all undefined
      // and the Ideas tab comes up empty.
      .then((data) => setResearch((data?.research ?? data) as ResearchState))
      .catch(() => setResearch(null))
      .finally(() => setLoaded(true));
  }, []);

  // Load the persisted cross-source synthesis and index its picks by ticker so
  // each board row can show the AI thesis + regime fit (zero Anthropic spend —
  // read-only GET of the already-generated blob).
  useEffect(() => {
    fetch("/api/research-synthesis", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const result = data?.result;
        if (!result) return;
        const m = new Map<string, { thesis?: string; regimeFit?: string; regimeFitRationale?: string }>();
        const groups = [result.topPicks, result.regimeAlignedHighlights, result.honorableMentions];
        for (const g of groups) {
          for (const p of (g || []) as Array<{ ticker?: string; thesis?: string; regimeFit?: string; regimeFitRationale?: string }>) {
            const key = String(p?.ticker || "").replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
            if (key && !m.has(key)) m.set(key, { thesis: p.thesis, regimeFit: p.regimeFit, regimeFitRationale: p.regimeFitRationale });
          }
        }
        setSynthesisByKey(m);
      })
      .catch(() => {});
  }, []);

  // Fetch live prices for the whole universe (scored + research names) so the
  // FactSet upside signal works even for names not yet in a bucket.
  useEffect(() => {
    const tickers = new Set<string>();
    for (const s of scoredStocks) tickers.add(s.ticker);
    if (research) {
      const lists: (keyof ResearchState)[] = [
        "jpmUsAnalystFocus", "rbcUsFocus", "rbcCanadianFocus", "fundstratTop",
        "fundstratSmidTop", "fundstratBottom", "fundstratSmidBottom", "alphaPicks",
        "newtonUpticks", "rbccmFew",
      ];
      for (const f of lists) {
        const arr = research[f] as Array<{ ticker?: string }> | undefined;
        for (const e of arr || []) if (e?.ticker) tickers.add(e.ticker);
      }
    }
    const list = [...tickers];
    if (list.length === 0) return;
    fetch("/api/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers: list }),
    })
      .then((r) => r.json())
      .then((data) => setPrices(data.prices || {}))
      .catch(() => {});
  }, [scoredStocks, research]);

  const entries = useMemo(
    () => computeConviction({ stocks: scoredStocks, research, snapshots: analystSnapshots, prices }),
    [scoredStocks, research, analystSnapshots, prices]
  );

  // Auto-surface: any research-list name (an idea) not yet tracked gets added to
  // the pipeline as "new" with today's date + the current price as its basis.
  // Only PUTs the delta, so it converges (already-tracked names are skipped).
  useEffect(() => {
    if (!loaded) return;
    const today = new Date().toISOString().slice(0, 10);
    const toAdd: Record<string, IdeaPipelineEntry> = {};
    for (const e of entries) {
      if (e.listCount < 1) continue; // ideas = on a research list
      if (pipeline[e.key]) continue; // already tracked
      toAdd[e.key] = {
        ticker: e.ticker,
        firstSurfaced: today,
        priceAtSurface: typeof prices[e.ticker] === "number" ? (prices[e.ticker] as number) : undefined,
        status: e.bucket === "Portfolio" ? "bought" : "new",
        sources: e.signals.filter((s) => s.kind === "list" && s.points > 0).map((s) => s.label),
        updatedAt: new Date().toISOString(),
      };
    }
    if (Object.keys(toAdd).length > 0) savePipeline(toAdd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, entries, prices, pipeline]);

  const setStatus = (e: ConvictionEntry, status: IdeaStatus) => {
    const prev = pipeline[e.key];
    savePipeline({
      [e.key]: {
        ticker: e.ticker,
        firstSurfaced: prev?.firstSurfaced ?? new Date().toISOString().slice(0, 10),
        priceAtSurface: prev?.priceAtSurface ?? (typeof prices[e.ticker] === "number" ? (prices[e.ticker] as number) : undefined),
        status,
        sources: prev?.sources ?? [],
        updatedAt: new Date().toISOString(),
      },
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return entries.filter((e) => {
      // "Ideas" = names carried by at least one bullish research list — the
      // research lists are the primary driver of what counts as an idea.
      if (filter === "ideas") { if (e.listCount < 1) return false; }
      else if (filter !== "all" && e.bucket !== filter) return false;
      if (q && !e.ticker.toUpperCase().includes(q) && !(e.name || "").toUpperCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, query]);

  const counts = useMemo(() => {
    const c = { ideas: 0, all: entries.length, Portfolio: 0, Watchlist: 0, Research: 0 };
    for (const e of entries) {
      c[e.bucket] += 1;
      if (e.listCount >= 1) c.ideas += 1;
    }
    return c;
  }, [entries]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-ink">Conviction Board</h1>
        <p className="text-sm text-ink-3">
          Research-list names (the idea universe that feeds the Watchlist) ranked by how many independent signals
          align — composite rating, upside to the FactSet mean analyst target, SIA / BoostedAI / MarketEdge,
          estimate revisions, and each research list. Rows with a 💡 carry the AI synthesis thesis + regime fit —
          click to expand. Individual stocks only. Higher = more sources agree.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
          {(["ideas", "all", "Portfolio", "Watchlist", "Research"] as BucketFilter[]).map((b) => (
            <button
              key={b}
              onClick={() => setFilter(b)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                filter === b ? "bg-ink text-white" : "text-ink-3 hover:bg-surface-2"
              }`}
              title={b === "ideas" ? "Names on at least one research list — the idea universe that feeds the Watchlist" : undefined}
            >
              {b === "ideas" ? "💡 Ideas" : b === "all" ? "All" : b} <span className="opacity-60">{counts[b]}</span>
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by ticker or name…"
          className="w-56 rounded-lg border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-line"
        />
        <span className="ml-auto text-xs text-ink-3">
          {filtered.length} names · sorted by conviction
        </span>
      </div>

      <div className="overflow-x-auto rounded-card border border-line bg-white shadow-sm">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-surface-2 text-xs uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Ticker</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-center w-20">Bucket</th>
              <th className="px-3 py-2 text-center w-24">Conviction</th>
              <th className="px-3 py-2 text-left">Signals</th>
              <th className="px-3 py-2 text-right w-24" title="Upside to the FactSet mean analyst price target — (mean target − current price) / current price. Only shown once a name has been rescored (that's when the target is pulled).">Analyst upside</th>
              <th className="px-3 py-2 text-left w-40" title="Idea pipeline — status + performance since the name was first surfaced by a research list.">Pipeline</th>
              <th className="px-3 py-2 text-right w-24"></th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-3">Loading…</td></tr>
            )}
            {loaded && filtered.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-3 italic">No names match.</td></tr>
            )}
            {filtered.map((e, i) => {
              const syn = synthesisByKey.get(e.key);
              const hasThesis = !!syn?.thesis;
              const isOpen = expanded === e.key;
              return (
              <Fragment key={e.key}>
              <tr className={`border-t border-line-soft ${i % 2 ? "bg-surface-hover" : "bg-white"} hover:bg-surface-2`}>
                <td className="px-3 py-2 text-ink-3 tabular-nums">{i + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {hasThesis && (
                      <button
                        onClick={() => setExpanded(isOpen ? null : e.key)}
                        className="text-xs leading-none"
                        title="Show the AI synthesis thesis + regime fit"
                      >💡</button>
                    )}
                    <Link href={`/stock/${e.ticker.toLowerCase()}`} className="font-mono font-bold text-ink hover:underline">
                      {displayTicker(e.ticker)}
                    </Link>
                    {syn?.regimeFit && <RegimeBadge fit={syn.regimeFit} />}
                  </div>
                </td>
                <td className="px-3 py-2 text-ink-2 truncate max-w-[200px]" title={e.name || e.ticker}>{e.name || <span className="text-ink-faint">—</span>}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    e.bucket === "Portfolio" ? "bg-accent-soft text-accent border border-accent-border"
                    : e.bucket === "Watchlist" ? "bg-surface-2 text-ink-2 border border-line"
                    : "bg-warn-soft text-warn border border-warn-border"
                  }`}>{e.bucket}</span>
                </td>
                <td className="px-3 py-2 text-center"><TotalPill total={e.total} /></td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {e.signals.length === 0 ? <span className="text-ink-faint text-xs">—</span> : e.signals.map((sig, k) => <SignalBadge key={k} sig={sig} />)}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                  {typeof e.upsidePct === "number" ? (
                    <span className={e.upsidePct >= 0 ? "text-pos" : "text-neg"}>
                      {e.upsidePct >= 0 ? "+" : ""}{e.upsidePct.toFixed(0)}%
                    </span>
                  ) : <span className="text-ink-faint">—</span>}
                </td>
                <td className="px-3 py-2">
                  {(() => {
                    const pi = pipeline[e.key];
                    if (!pi) return <span className="text-ink-faint text-xs">—</span>;
                    const now = prices[e.ticker];
                    const since = typeof now === "number" && typeof pi.priceAtSurface === "number" && pi.priceAtSurface > 0
                      ? ((now - pi.priceAtSurface) / pi.priceAtSurface) * 100 : null;
                    return (
                      <div className="flex flex-col gap-0.5">
                        <select
                          value={pi.status}
                          onChange={(ev) => setStatus(e, ev.target.value as IdeaStatus)}
                          className="rounded border border-line bg-white px-1 py-0.5 text-[11px] text-ink-2 outline-none focus:border-line"
                        >
                          {(["new", "watching", "bought", "passed"] as IdeaStatus[]).map((s) => (
                            <option key={s} value={s}>{IDEA_STATUS_LABELS[s]}</option>
                          ))}
                        </select>
                        <span className="text-[10px] text-ink-3 whitespace-nowrap">
                          since {pi.firstSurfaced}
                          {since != null && <span className={since >= 0 ? "text-pos font-medium" : "text-neg font-medium"}> · {since >= 0 ? "+" : ""}{since.toFixed(0)}%</span>}
                        </span>
                      </div>
                    );
                  })()}
                </td>
                <td className="px-3 py-2 text-right">
                  {e.bucket === "Research" && (
                    <button
                      onClick={() => addToWatchlist(e.ticker, e.name)}
                      className="text-[10px] font-semibold text-accent hover:text-accent"
                      title="Add to Watchlist"
                    >
                      + Watch
                    </button>
                  )}
                </td>
              </tr>
              {isOpen && hasThesis && (
                <tr className="bg-accent-soft/40">
                  <td></td>
                  <td colSpan={8} className="px-3 pb-3 pt-1">
                    <div className="rounded-lg border border-accent-border bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-accent">Synthesis thesis</div>
                      <p className="mt-0.5 text-sm text-ink leading-relaxed">{syn!.thesis}</p>
                      {syn!.regimeFitRationale && (
                        <p className="mt-1 text-xs text-ink-3"><span className="font-semibold">Regime fit:</span> {syn!.regimeFitRationale}</p>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
