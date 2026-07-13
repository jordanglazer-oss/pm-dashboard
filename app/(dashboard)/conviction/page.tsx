"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
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
  const [high52, setHigh52] = useState<Record<string, number | null>>({});
  const [pipelineEstimates, setPipelineEstimates] = useState<Record<string, { revUp?: number; revDown?: number }>>({});
  // Tab (filter) + Improving toggle live in the URL (?filter=, ?improving=1) so
  // clicking a name and pressing Back restores the Pipeline view the PM was on
  // instead of snapping back to the default Ideas tab.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const FILTERS: BucketFilter[] = ["ideas", "all", "Portfolio", "Watchlist", "Research"];
  const urlFilter = (FILTERS as string[]).includes(searchParams.get("filter") ?? "")
    ? (searchParams.get("filter") as BucketFilter)
    : "ideas";
  const urlImproving = searchParams.get("improving") === "1";
  const [improvingOnly, setImprovingOnly] = useState(urlImproving);
  const [filter, setFilter] = useState<BucketFilter>(urlFilter);
  // Re-sync when the URL changes underneath us (Back/Forward navigation).
  useEffect(() => {
    setFilter(urlFilter);
  }, [urlFilter]);
  useEffect(() => {
    setImprovingOnly(urlImproving);
  }, [urlImproving]);
  const syncUrl = (nextFilter: BucketFilter, nextImproving: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("filter", nextFilter);
    if (nextImproving) params.set("improving", "1");
    else params.delete("improving");
    // replace (not push) so a tab change isn't its own Back step.
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const selectFilter = (b: BucketFilter) => {
    setFilter(b);
    syncUrl(b, improvingOnly);
  };
  const toggleImproving = () => {
    const v = !improvingOnly;
    setImprovingOnly(v);
    syncUrl(filter, v);
  };
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
      .then((data) => {
        setPrices(data.prices || {});
        setHigh52(data.fiftyTwoWeekHighs || {}); // lightweight technical (52wk-high proximity)
      })
      .catch(() => {});
    // Batched FactSet estimate revisions for the whole universe (Improving signal).
    fetch("/api/factset-estimates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers: list }),
    })
      .then((r) => r.json())
      .then((data) => setPipelineEstimates(data.estimates || {}))
      .catch(() => {});
  }, [scoredStocks, research]);

  // "Improving" = the forward/momentum lens for the funnel: rising FY+1 estimate
  // revisions and/or breaking out near the 52-week high. Kept SEPARATE from the
  // conviction score (which is a level). Lightweight by design — full technicals
  // arrive once a name graduates to the Watchlist.
  const improvingFor = (ticker: string): { strength: "strong" | "building" | null; signals: string[] } => {
    const signals: string[] = [];
    let strong = false;
    const est = pipelineEstimates[ticker.toUpperCase()] ?? pipelineEstimates[ticker];
    const net = est ? (est.revUp ?? 0) - (est.revDown ?? 0) : null;
    if (net != null && net > 0) {
      signals.push(`estimates ↑ (+${net} net)`);
      if (net >= 3) strong = true;
    }
    const px = prices[ticker] ?? null;
    const hi = high52[ticker] ?? null;
    if (px != null && hi != null && hi > 0 && px / hi - 1 >= -0.03) {
      signals.push("near 52wk high");
      if (net != null && net > 0) strong = true; // estimates up AND breaking out
    }
    return { strength: signals.length ? (strong || signals.length >= 2 ? "strong" : "building") : null, signals };
  };

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
      // "Ideas" = research-list CANDIDATES you don't already own — exclude
      // Portfolio holdings (they're not add candidates; their composite score
      // lives on the Rankings page). The "Portfolio"/"All" filters still show them.
      if (filter === "ideas") { if (e.listCount < 1 || e.bucket === "Portfolio") return false; }
      else if (filter !== "all" && e.bucket !== filter) return false;
      if (q && !e.ticker.toUpperCase().includes(q) && !(e.name || "").toUpperCase().includes(q)) return false;
      if (improvingOnly && !improvingFor(e.ticker).strength) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filter, query, improvingOnly, prices, high52, pipelineEstimates]);

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
        <h1 className="text-2xl font-bold text-ink">Pipeline</h1>
        <p className="text-sm text-ink-3">
          Research-list names (the idea universe that feeds the Watchlist) ranked by how many independent signals
          align — composite rating, upside to the FactSet mean analyst target, SIA / BoostedAI / MarketEdge,
          estimate revisions, and each research list. Rows with a 💡 carry the AI synthesis thesis + regime fit —
          click to expand. Individual stocks only. Higher = more sources agree.
        </p>
        <details className="mt-2 text-[12.5px] text-ink-3">
          <summary className="cursor-pointer font-semibold text-accent hover:text-accent-ink">How the conviction score is computed</summary>
          <div className="mt-2 flex flex-col gap-1 rounded-control bg-surface-2/50 px-3 py-2.5">
            <p className="text-ink-2">It&apos;s the <span className="font-semibold">sum of points</span> from independent signals — the more that agree (and the stronger), the higher the score:</p>
            <ul className="ml-1 flex flex-col gap-0.5">
              <li>• <span className="font-semibold">Composite rating:</span> Strong Buy +3 · Buy +2 · Hold 0 · Underweight −1 · Sell −2</li>
              <li>• <span className="font-semibold">Analyst upside</span> (to FactSet mean target): ≥ +25% → +2 · ≥ +10% → +1 · ≤ −10% → −1</li>
              <li>• <span className="font-semibold">SIA · BoostedAI · MarketEdge:</span> bullish +1 / bearish −1 (each)</li>
              <li>• <span className="font-semibold">Estimate revisions</span> (FactSet FY+1): net ≥ +2 up → +1 · net ≤ −2 down → −1</li>
              <li>• <span className="font-semibold">Each research list</span> it appears on: bullish list +1 · bearish list −1</li>
            </ul>
            <p className="text-ink-faint">Total = sum of all of the above. It measures how good a name looks <em>right now</em> (a level) — the &ldquo;Improving&rdquo; flag below is the separate momentum/forward view.</p>
          </div>
        </details>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
          {FILTERS.map((b) => (
            <button
              key={b}
              onClick={() => selectFilter(b)}
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
        <button
          onClick={toggleImproving}
          title="Only names with a positive momentum signal — rising FY+1 estimate revisions and/or breaking out near their 52-week high. Narrows the funnel to what's getting better."
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            improvingOnly ? "bg-pos text-white" : "border border-line text-ink-3 hover:bg-surface-2"
          }`}
        >
          ⬆ Improving only
        </button>
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
              <th className="px-3 py-2 text-right w-28">Watchlist</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-3">Loading…</td></tr>
            )}
            {loaded && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-3 italic">No names match.</td></tr>
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
                    {(() => {
                      const imp = improvingFor(e.ticker);
                      return imp.strength ? (
                        <span
                          className={`inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${imp.strength === "strong" ? "bg-pos text-white" : "bg-pos-soft text-pos"}`}
                          title={`Improving — ${imp.signals.join(" · ")}`}
                        >
                          ⬆ {imp.strength}
                        </span>
                      ) : null;
                    })()}
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
                <td className="px-3 py-2 text-right">
                  {e.bucket === "Research" ? (
                    <button
                      onClick={() => addToWatchlist(e.ticker, e.name)}
                      className="rounded-control border border-line px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft transition-colors"
                      title={`Add ${e.ticker} to the Watchlist`}
                    >
                      + Watchlist
                    </button>
                  ) : e.bucket === "Watchlist" ? (
                    <span className="text-[11px] text-ink-3">On watchlist</span>
                  ) : (
                    <span className="text-[11px] text-ink-faint">Held</span>
                  )}
                </td>
              </tr>
              {isOpen && hasThesis && (
                <tr className="bg-accent-soft/40">
                  <td></td>
                  <td colSpan={7} className="px-3 pb-3 pt-1">
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
