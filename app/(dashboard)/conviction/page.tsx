"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { computeConviction, type ConvictionSignal, type ConvictionEntry } from "@/app/lib/conviction";
import { NewThisWeek } from "@/app/components/NewThisWeek";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
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

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover";
const BTN22 = "inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-40";

/** One signal as text: label + mono points. Negative points read neg; the
 *  KIND (list / quant / setup / rating …) is carried in the title so the
 *  source of the agreement is still one hover away. */
function SignalText({ sig }: { sig: ConvictionSignal }) {
  const neg = sig.points < 0;
  return (
    <span className={`inline-flex items-baseline gap-1 text-[11.5px] ${neg ? "text-neg" : "text-ink-2"}`} title={`${sig.kind} · ${sig.points >= 0 ? "+" : ""}${sig.points}`}>
      {sig.label}
      <span className={`font-mono text-[11px] ${neg ? "text-neg" : "text-ink-3"}`}>{sig.points >= 0 ? `+${sig.points}` : sig.points}</span>
    </span>
  );
}

/** Regime fit from the AI synthesis (how the name fits the current market regime) — dot + word. */
function RegimeFit({ fit }: { fit: string }) {
  const map: Record<string, { dot: string; cls: string; label: string }> = {
    high: { dot: "bg-pos", cls: "text-pos", label: "Fits regime" },
    medium: { dot: "bg-ink-faint", cls: "text-ink-3", label: "Regime neutral" },
    low: { dot: "bg-warn", cls: "text-warn", label: "Against regime" },
    contrary: { dot: "bg-neg", cls: "text-neg", label: "Contrarian" },
  };
  const m = map[fit];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${m.cls}`} title={`Regime fit: ${fit}`}>
      <span className={`dot ${m.dot}`} />{m.label}
    </span>
  );
}

/** Conviction total — mono text, coloured by magnitude. */
function Total({ total }: { total: number }) {
  const cls = total >= 3 ? "text-pos" : total <= -2 ? "text-neg" : total >= 1 ? "text-ink" : "text-ink-3";
  return <span className={`font-mono font-medium ${cls}`}>{total > 0 ? `+${total}` : total}</span>;
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
  const [howOpen, toggleHow] = usePersistedOpen("conviction.howScored.open", false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Synthesis narrative keyed by normalized ticker (AI thesis + regime fit) —
  // enriches the quantitative board with the "why" and regime context.
  const [synthesisByKey, setSynthesisByKey] = useState<Map<string, { thesis?: string; regimeFit?: string; regimeFitRationale?: string }>>(new Map());
  const [pipeline, setPipeline] = useState<IdeaPipelineStore>({});
  // EQUATE ranks and setup readings — both optional inputs to the board, so a
  // failed fetch degrades the signal rather than the page.
  const [equateRanks, setEquateRanks] = useState<{ symbol: string; compositeRank: number; decile: number }[]>([]);
  const [setups, setSetups] = useState<{ ticker: string; base: { score: number; label: string } | null }[]>([]);
  useEffect(() => {
    fetch("/api/equate-ranks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.rows)) setEquateRanks(d.rows); })
      .catch(() => {});
    fetch("/api/setup-scan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.rows)) setSetups(d.rows); })
      .catch(() => {});
  }, []);

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
    () => computeConviction({ stocks: scoredStocks, research, snapshots: analystSnapshots, prices, equateRanks, setups }),
    // equateRanks and setups load asynchronously — without them here the board
    // computes once from empty arrays and never picks the readings up.
    [scoredStocks, research, analystSnapshots, prices, equateRanks, setups]
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

  // Ticker sets for the nomination lane: exclude what's held, and mark what
  // the desk already knows about via a list or the watchlist.
  const laneTickers = useMemo(() => {
    const portfolio = new Set<string>();
    const watchlist = new Set<string>();
    const lists = new Set<string>();
    for (const e of entries) {
      const tk = e.ticker.toUpperCase();
      if (e.bucket === "Portfolio") portfolio.add(tk);
      else if (e.bucket === "Watchlist") watchlist.add(tk);
      if (e.listCount >= 1) lists.add(tk);
    }
    return { portfolio, watchlist, lists };
  }, [entries]);

  const counts = useMemo(() => {
    const c = { ideas: 0, all: entries.length, Portfolio: 0, Watchlist: 0, Research: 0 };
    for (const e of entries) {
      c[e.bucket] += 1;
      if (e.listCount >= 1) c.ideas += 1;
    }
    return c;
  }, [entries]);

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg" role="group" aria-label="Bucket">
          {FILTERS.map((b) => (
            <button
              key={b}
              onClick={() => selectFilter(b)}
              className={filter === b ? "on" : ""}
              title={b === "ideas" ? "Names on at least one research list — the idea universe that feeds the Watchlist" : undefined}
            >
              {b === "ideas" ? "Ideas" : b === "all" ? "All" : b} <span className="c">{counts[b]}</span>
            </button>
          ))}
        </div>
        <label className="relative">
          <AppIcon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by ticker or name"
            className="h-7 w-56 rounded-control border border-line bg-surface pl-7 pr-2.5 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-accent-border"
          />
        </label>
        <button
          onClick={toggleImproving}
          aria-pressed={improvingOnly}
          title="Only names with a positive momentum signal — rising FY+1 estimate revisions and/or breaking out near their 52-week high. Narrows the funnel to what's getting better."
          className={`${BTN} ${improvingOnly ? "!border-accent-border !bg-accent-soft !text-accent" : ""}`}
        >
          <AppIcon name="chevU" size={13} strokeWidth={2.25} />
          Improving only
        </button>
        <button onClick={toggleHow} aria-expanded={howOpen} className={BTN}>
          <AppIcon name="help" size={13} strokeWidth={2} />
          How the score is computed
          <AppIcon name={howOpen ? "chevU" : "chevD"} size={12} strokeWidth={2} className="text-ink-3" />
        </button>
        <span className="ml-auto text-[11.5px] text-ink-3">
          {filtered.length} names · sorted by conviction
        </span>
      </div>

      {howOpen && (
        <section className="panel">
          <div className="panel-h">
            <span className="t">How the conviction score is computed</span>
            <span className="m">a level, not a trend — the Improving flag is the separate forward view</span>
          </div>
          <div className="flex flex-col gap-1.5 px-3.5 py-3 text-[12.5px] leading-[1.5] text-ink-2">
            <p>
              Research-list names (the idea universe that feeds the Watchlist) ranked by how many independent signals
              align — composite rating, upside to the FactSet mean analyst target, SIA / BoostedAI / MarketEdge,
              estimate revisions, and each research list. Rows with a <AppIcon name="spark" size={12} className="inline align-[-2px] text-ink-3" /> carry the AI synthesis thesis + regime fit —
              click to expand. Individual stocks only. Higher = more sources agree.
            </p>
            <p>It&apos;s the <span className="font-medium text-ink">sum of points</span> from independent signals — the more that agree (and the stronger), the higher the score:</p>
            <ul className="ml-1 flex flex-col gap-0.5">
              <li>· <span className="font-medium text-ink">Composite rating:</span> Strong Buy +3 · Buy +2 · Hold 0 · Underweight −1 · Sell −2</li>
              <li>· <span className="font-medium text-ink">Analyst upside</span> (to FactSet mean target): ≥ +25% → +2 · ≥ +10% → +1 · ≤ −10% → −1</li>
              <li>· <span className="font-medium text-ink">SIA · BoostedAI · MarketEdge:</span> bullish +1 / bearish −1 (each)</li>
              <li>· <span className="font-medium text-ink">Estimate revisions</span> (FactSet FY+1): net ≥ +2 up → +1 · net ≤ −2 down → −1</li>
              <li>· <span className="font-medium text-ink">Each research list</span> it appears on: bullish list +1 · bearish list −1</li>
            </ul>
            <p className="text-ink-3">Total = sum of all of the above. It measures how good a name looks <em>right now</em> (a level) — the &ldquo;Improving&rdquo; flag is the separate momentum/forward view.</p>
          </div>
        </section>
      )}

      {/* Nomination lane — the only path into the funnel that does NOT
          require a research list to have named the stock first. */}
      <NewThisWeek
        portfolioTickers={laneTickers.portfolio}
        watchlistTickers={laneTickers.watchlist}
        listTickers={laneTickers.lists}
      />

      <section className="panel">
        <div className="panel-h">
          <span className="t">Conviction</span>
          <span className="m">{filter === "ideas" ? "research-list candidates you don't own" : filter === "all" ? "every tracked name" : filter} · sorted by conviction</span>
        </div>
        {loaded && filtered.length === 0 ? (
          <EmptyState className="!py-8" glyph={<AppIcon name="branch" size={18} />} title="No names match" body="Try another bucket, clear the search, or turn off Improving only." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1000px]">
              <thead>
                <tr>
                  <th className="n pl-3.5 w-10">#</th>
                  <th>Name</th>
                  <th>Bucket</th>
                  <th className="n">Conviction</th>
                  <th>Signals</th>
                  <th className="n" title="Upside to the FactSet mean analyst price target — (mean target − current price) / current price. Only shown once a name has been rescored (that's when the target is pulled).">Analyst upside</th>
                  <th className="pr-3.5 text-right">Watchlist</th>
                </tr>
              </thead>
              <tbody>
                {!loaded && (
                  <tr><td colSpan={7} className="py-6 text-center text-ink-3">Loading…</td></tr>
                )}
                {filtered.map((e, i) => {
                  const syn = synthesisByKey.get(e.key);
                  const hasThesis = !!syn?.thesis;
                  const isOpen = expanded === e.key;
                  const imp = improvingFor(e.ticker);
                  return (
                  <Fragment key={e.key}>
                  <tr className={isOpen ? "sel" : ""}>
                    <td className="n pl-3.5 text-ink-3">{i + 1}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Link href={`/stock/${e.ticker.toLowerCase()}`} className="font-mono font-medium text-ink hover:text-accent hover:underline">
                          {displayTicker(e.ticker)}
                        </Link>
                        <span className="max-w-[200px] truncate text-[12px] text-ink-3" title={e.name || e.ticker}>{e.name || ""}</span>
                        {hasThesis && (
                          <button
                            onClick={() => setExpanded(isOpen ? null : e.key)}
                            className="grid h-[22px] w-[22px] place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink"
                            title="Show the AI synthesis thesis + regime fit"
                            aria-expanded={isOpen}
                          >
                            <AppIcon name="spark" size={13} strokeWidth={2} />
                          </button>
                        )}
                        {syn?.regimeFit && <RegimeFit fit={syn.regimeFit} />}
                        {imp.strength && (
                          <span
                            className={`inline-flex items-center gap-0.5 text-[11px] ${imp.strength === "strong" ? "text-pos" : "text-pos/80"}`}
                            title={`Improving — ${imp.signals.join(" · ")}`}
                          >
                            <AppIcon name="chevU" size={11} strokeWidth={2.25} />{imp.strength}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-ink-2">{e.bucket}</td>
                    <td className="n"><Total total={e.total} /></td>
                    <td className="whitespace-normal py-1.5">
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {e.signals.length === 0 ? <span className="text-ink-faint">—</span> : e.signals.map((sig, k) => <SignalText key={k} sig={sig} />)}
                      </div>
                    </td>
                    <td className="n">
                      {typeof e.upsidePct === "number" ? (
                        <span className={e.upsidePct >= 0 ? "text-pos" : "text-neg"}>
                          {e.upsidePct >= 0 ? "+" : ""}{e.upsidePct.toFixed(0)}%
                        </span>
                      ) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="pr-3.5 text-right">
                      {e.bucket === "Research" ? (
                        <button
                          onClick={() => addToWatchlist(e.ticker, e.name)}
                          className={BTN22}
                          title={`Add ${e.ticker} to the Watchlist`}
                        >
                          <AppIcon name="plus" size={11} strokeWidth={2.25} /> Watchlist
                        </button>
                      ) : e.bucket === "Watchlist" ? (
                        <span className="text-[11.5px] text-ink-3">On watchlist</span>
                      ) : (
                        <span className="text-[11.5px] text-ink-faint">Held</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && hasThesis && (
                    <tr>
                      <td></td>
                      <td colSpan={6} className="whitespace-normal pb-3 pt-1 pr-3.5">
                        <div className="text-[11px] text-ink-3">Synthesis thesis</div>
                        <p className="mt-0.5 text-[12.5px] leading-[1.5] text-ink-2">{syn!.thesis}</p>
                        {syn!.regimeFitRationale && (
                          <p className="mt-1 text-[11.5px] text-ink-3"><span className="text-ink-2">Regime fit:</span> {syn!.regimeFitRationale}</p>
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
        <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          {filtered.length} of {entries.length} · sorted by conviction
        </div>
      </section>
    </div>
  );
}
