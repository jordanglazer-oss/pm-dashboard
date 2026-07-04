"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { computeConviction, type ConvictionSignal } from "@/app/lib/conviction";
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
  rating: "bg-indigo-50 text-indigo-700 border-indigo-200",
  upside: "bg-emerald-50 text-emerald-700 border-emerald-200",
  external: "bg-blue-50 text-blue-700 border-blue-200",
  list: "bg-amber-50 text-amber-700 border-amber-200",
};

function SignalBadge({ sig }: { sig: ConvictionSignal }) {
  const neg = sig.points < 0;
  const cls = neg ? "bg-red-50 text-red-600 border-red-200" : KIND_STYLE[sig.kind];
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
    high: { cls: "bg-emerald-100 text-emerald-700 border-emerald-300", label: "Regime ✓" },
    medium: { cls: "bg-slate-100 text-slate-600 border-slate-300", label: "Regime ~" },
    low: { cls: "bg-amber-100 text-amber-700 border-amber-300", label: "Regime ✕" },
    contrary: { cls: "bg-red-100 text-red-700 border-red-300", label: "Contrarian" },
  };
  const m = map[fit];
  if (!m) return null;
  return <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${m.cls}`} title={`Regime fit: ${fit}`}>{m.label}</span>;
}

/** Conviction total pill — colored by magnitude. */
function TotalPill({ total }: { total: number }) {
  const cls =
    total >= 6 ? "bg-emerald-600 text-white"
    : total >= 3 ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
    : total >= 1 ? "bg-slate-100 text-slate-700 border border-slate-300"
    : total <= -2 ? "bg-red-600 text-white"
    : "bg-slate-100 text-slate-400 border border-slate-200";
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

  // Load the research blob (all source lists).
  useEffect(() => {
    fetch("/api/kv/research", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: ResearchState) => setResearch(data))
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
        <h1 className="text-2xl font-bold text-slate-800">Conviction Board</h1>
        <p className="text-sm text-slate-500">
          Research-list names (the idea universe that feeds the Watchlist) ranked by how many independent signals
          align — composite rating, upside to the FactSet mean analyst target, SIA / BoostedAI / MarketEdge,
          estimate revisions, and each research list. Rows with a 💡 carry the AI synthesis thesis + regime fit —
          click to expand. Individual stocks only. Higher = more sources agree.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
          {(["ideas", "all", "Portfolio", "Watchlist", "Research"] as BucketFilter[]).map((b) => (
            <button
              key={b}
              onClick={() => setFilter(b)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                filter === b ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-100"
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
          className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-400"
        />
        <span className="ml-auto text-xs text-slate-400">
          {filtered.length} names · sorted by conviction
        </span>
      </div>

      <div className="overflow-x-auto rounded-[20px] border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Ticker</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-center w-20">Bucket</th>
              <th className="px-3 py-2 text-center w-24">Conviction</th>
              <th className="px-3 py-2 text-left">Signals</th>
              <th className="px-3 py-2 text-right w-24" title="Upside to the FactSet mean analyst price target — (mean target − current price) / current price. Only shown once a name has been rescored (that's when the target is pulled).">Analyst upside</th>
              <th className="px-3 py-2 text-right w-24"></th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Loading…</td></tr>
            )}
            {loaded && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400 italic">No names match.</td></tr>
            )}
            {filtered.map((e, i) => {
              const syn = synthesisByKey.get(e.key);
              const hasThesis = !!syn?.thesis;
              const isOpen = expanded === e.key;
              return (
              <Fragment key={e.key}>
              <tr className={`border-t border-slate-100 ${i % 2 ? "bg-slate-50/40" : "bg-white"} hover:bg-slate-50`}>
                <td className="px-3 py-2 text-slate-400 tabular-nums">{i + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {hasThesis && (
                      <button
                        onClick={() => setExpanded(isOpen ? null : e.key)}
                        className="text-xs leading-none"
                        title="Show the AI synthesis thesis + regime fit"
                      >💡</button>
                    )}
                    <Link href={`/stock/${e.ticker.toLowerCase()}`} className="font-mono font-bold text-slate-800 hover:underline">
                      {displayTicker(e.ticker)}
                    </Link>
                    {syn?.regimeFit && <RegimeBadge fit={syn.regimeFit} />}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-600 truncate max-w-[200px]" title={e.name || e.ticker}>{e.name || <span className="text-slate-300">—</span>}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    e.bucket === "Portfolio" ? "bg-blue-50 text-blue-700 border border-blue-200"
                    : e.bucket === "Watchlist" ? "bg-slate-100 text-slate-600 border border-slate-200"
                    : "bg-amber-50 text-amber-700 border border-amber-200"
                  }`}>{e.bucket}</span>
                </td>
                <td className="px-3 py-2 text-center"><TotalPill total={e.total} /></td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {e.signals.length === 0 ? <span className="text-slate-300 text-xs">—</span> : e.signals.map((sig, k) => <SignalBadge key={k} sig={sig} />)}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                  {typeof e.upsidePct === "number" ? (
                    <span className={e.upsidePct >= 0 ? "text-emerald-600" : "text-red-500"}>
                      {e.upsidePct >= 0 ? "+" : ""}{e.upsidePct.toFixed(0)}%
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {e.bucket === "Research" && (
                    <button
                      onClick={() => addToWatchlist(e.ticker, e.name)}
                      className="text-[10px] font-semibold text-blue-500 hover:text-blue-700"
                      title="Add to Watchlist"
                    >
                      + Watch
                    </button>
                  )}
                </td>
              </tr>
              {isOpen && hasThesis && (
                <tr className="bg-indigo-50/40">
                  <td></td>
                  <td colSpan={7} className="px-3 pb-3 pt-1">
                    <div className="rounded-lg border border-indigo-100 bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Synthesis thesis</div>
                      <p className="mt-0.5 text-sm text-slate-700 leading-relaxed">{syn!.thesis}</p>
                      {syn!.regimeFitRationale && (
                        <p className="mt-1 text-xs text-slate-500"><span className="font-semibold">Regime fit:</span> {syn!.regimeFitRationale}</p>
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
