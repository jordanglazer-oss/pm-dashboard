"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock } from "@/app/lib/types";
import { MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import { isScoreable, normalizeSector } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import { AppIcon } from "./AppIcon";
import { useStocks } from "@/app/lib/StockContext";

type SortKey = "ticker" | "bucket" | "sector" | "raw" | "adjusted" | "rating" | "risk" | "effect" | "price" | "pnl";
type SortDir = "asc" | "desc";
type InstrumentFilter = "all" | "stocks" | "etf-usd" | "etf-cad" | "mutual-fund";

type LivePrices = Record<string, number | null>;

type Props = {
  stocks: ScoredStock[];
  onScoreStock?: (ticker: string) => Promise<void>;
  onUpdateCostBasis?: (ticker: string, costBasis: number) => void;
  onRefreshData?: (ticker: string, data: { name?: string; sector?: string; price?: number; beta?: number; technicals?: unknown; healthData?: unknown; riskAlert?: unknown }) => void;
  onUpdateFundData?: (ticker: string, fundData: import("@/app/lib/types").FundData) => void;
  onUpdateMarketData?: (data: Partial<import("@/app/lib/types").MarketData>) => void;
};

// Shared control classes (28px, 6px radius — the workspace control ladder).
const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover transition-colors disabled:opacity-50";
const BTN_PRIMARY = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 transition-colors disabled:opacity-50";
const BTN_DANGER = "inline-flex h-7 items-center gap-1.5 rounded-control border border-neg-border bg-surface px-2.5 text-[12.5px] text-neg hover:bg-neg-soft transition-colors";

/** Rating reads as coloured TEXT, not a pill (numbers and verdict words in
 *  tables are text in this design vocabulary). */
function ratingCls(rating: string): string {
  return rating === "Buy" ? "text-pos" : rating === "Sell" ? "text-neg" : "text-ink-2";
}
/** Risk reads as a status dot + the word, in one column. */
function riskDot(risk: string): string {
  return risk === "High" ? "bg-neg" : risk === "Medium" ? "bg-warn" : "bg-pos";
}

const RATING_ORDER: Record<string, number> = { Buy: 3, Hold: 2, Sell: 1 };
const RISK_ORDER: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

/** Check if a ticker is Canadian (.TO suffix or FUNDSERV code pattern) */
function isCanadianTicker(ticker: string): boolean {
  // .U suffix = USD-denominated Canadian-listed ETF (e.g., XUS.U, XUU.U) — NOT Canadian
  if (ticker.endsWith(".U")) return false;
  return ticker.endsWith(".TO") || /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

const FILTER_LABELS: Record<InstrumentFilter, string> = {
  all: "All",
  stocks: "Stocks",
  "etf-usd": "ETFs (USD)",
  "etf-cad": "ETFs (CAD)",
  "mutual-fund": "Mutual Funds",
};

function matchesFilter(s: ScoredStock, filter: InstrumentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "stocks") return !s.instrumentType || s.instrumentType === "stock";
  if (filter === "etf-usd") return s.instrumentType === "etf" && !isCanadianTicker(s.ticker);
  if (filter === "etf-cad") return s.instrumentType === "etf" && isCanadianTicker(s.ticker);
  if (filter === "mutual-fund") return s.instrumentType === "mutual-fund";
  return true;
}

export function StockScoring({ stocks, onScoreStock, onUpdateCostBasis, onRefreshData, onUpdateFundData, onUpdateMarketData }: Props) {
  const router = useRouter();
  const { uiPrefs, setUiPref, updatePrice, updateStockFields, updateScore } = useStocks();
  const [query, setQuery] = useState("");

  // Persist sort state across refreshes and devices via Redis KV
  const sortKey = (uiPrefs["scoringSort"] as SortKey) || "adjusted";
  const sortDir = (uiPrefs["scoringSortDir"] as SortDir) || "desc";
  const setSortKey = (k: SortKey) => setUiPref("scoringSort", k);
  const setSortDir = (d: SortDir | ((prev: SortDir) => SortDir)) => {
    const val = typeof d === "function" ? d(sortDir) : d;
    setUiPref("scoringSortDir", val);
  };

  const [instrumentFilter, setInstrumentFilter] = useState<InstrumentFilter>("all");

  // Live prices — initialize from persisted stock.price values so they show before API fetch
  const [livePrices, setLivePrices] = useState<LivePrices>(() => {
    const initial: LivePrices = {};
    for (const s of stocks) {
      if (s.price != null) initial[s.ticker] = s.price;
    }
    return initial;
  });
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);

  // Score all state
  const [scoringAll, setScoringAll] = useState(false);
  const [scoreProgress, setScoreProgress] = useState("");

  // Refresh all data state (no Claude — just technicals, health, risk alerts)
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState("");

  const fetchPrices = useCallback(async () => {
    const tickers = stocks.map((s) => s.ticker);
    if (tickers.length === 0) return;
    setPricesLoading(true);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (res.ok) {
        const data = await res.json();
        const prices: LivePrices = data.prices || {};
        const currencies: Record<string, string | null> = data.currencies || {};
        setLivePrices(prices);
        setPricesFetchedAt(data.fetchedAt || new Date().toISOString());
        // Persist all fetched prices + currencies to Redis KV via stock objects
        for (const [t, p] of Object.entries(prices)) {
          if (p != null) updatePrice(t, p);
        }
        for (const [t, ccy] of Object.entries(currencies)) {
          if (ccy) updateStockFields(t, { currency: ccy });
        }
      }
    } catch { /* silent */ } finally {
      setPricesLoading(false);
    }
  }, [stocks, updatePrice, updateStockFields]);

  // Auto-fetch prices on mount
  useEffect(() => {
    fetchPrices();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Score all state per bucket
  const [scoringBucket, setScoringBucket] = useState<"Portfolio" | "Watchlist" | null>(null);

  // Score all stocks in a specific bucket sequentially
  async function handleScoreBucket(bucket: "Portfolio" | "Watchlist") {
    if (!onScoreStock || scoringAll) return;
    const bucketStocks = stocks.filter((s) => s.bucket === bucket && isScoreable(s));
    if (bucketStocks.length === 0) return;
    setScoringAll(true);
    setScoringBucket(bucket);
    for (let i = 0; i < bucketStocks.length; i++) {
      const s = bucketStocks[i];
      setScoreProgress(`Scoring ${s.ticker} (${i + 1}/${bucketStocks.length})`);
      try {
        await onScoreStock(s.ticker);
      } catch { /* continue on error */ }
    }
    setScoreProgress("");
    setScoringAll(false);
    setScoringBucket(null);
    fetchPrices();
  }

  // Refresh all data (technicals, health, risk alerts) without Claude scoring
  async function handleRefreshAll() {
    if (!onRefreshData || refreshingAll) return;
    setRefreshingAll(true);
    setRefreshProgress("Fetching data...");
    try {
      const tickers = stocks.map((s) => s.ticker);
      const res = await fetch("/api/refresh-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to refresh data");
      }
      const data = await res.json();
      const results = data.results || [];
      let updated = 0;
      for (const r of results) {
        if (r.error) continue;
        onRefreshData(r.ticker, {
          name: r.name,
          sector: r.sector,
          price: r.price,
          beta: r.beta,
          technicals: r.technicals,
          healthData: r.healthData,
          riskAlert: r.riskAlert,
        });
        updated++;
      }
      // Also refresh fund data for ETFs and mutual funds
      if (onUpdateFundData) {
        const fundStocks = stocks.filter(
          (s) => s.instrumentType === "etf" || s.instrumentType === "mutual-fund"
        );
        if (fundStocks.length > 0) {
          setRefreshProgress(`Updated ${updated} stocks. Refreshing ${fundStocks.length} fund(s)...`);
          for (const fund of fundStocks) {
            try {
              const fRes = await fetch(`/api/fund-data?ticker=${encodeURIComponent(fund.ticker)}`);
              if (fRes.ok) {
                const fData = await fRes.json();
                if (fData.fundData) {
                  const existing = fund.fundData;
                  const merged = { ...fData.fundData };
                  // Preserve user-provided holdings if API returned none
                  if (!merged.topHoldings?.length && existing?.topHoldings?.length) {
                    merged.topHoldings = existing.topHoldings;
                    merged.sectorWeightings = existing.sectorWeightings;
                    merged.holdingsLastUpdated = existing.holdingsLastUpdated;
                    merged.holdingsSource = existing.holdingsSource;
                  }
                  // Always preserve the holdings URL and timestamp
                  if (existing?.holdingsUrl && !merged.holdingsUrl) {
                    merged.holdingsUrl = existing.holdingsUrl;
                  }
                  if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
                    merged.holdingsLastUpdated = existing.holdingsLastUpdated;
                  }
                  if (merged.topHoldings?.length && !merged.holdingsLastUpdated) {
                    merged.holdingsLastUpdated = new Date().toISOString();
                  }
                  onUpdateFundData(fund.ticker, merged);
                }
                // Pick up price from fund-data response and persist to KV
                if (fData.price != null && typeof fData.price === "number") {
                  setLivePrices((prev) => ({ ...prev, [fund.ticker]: fData.price }));
                  updatePrice(fund.ticker, fData.price);
                }
              }
            } catch { /* best effort */ }
          }
        }
      }
      // Refresh S&P 500 sector weights from SPY. Cache-busting + no-store
      // to defeat any stale browser/CDN response, normalize sector names so
      // they match our internal GICS labels, and skip the write if the
      // payload looks malformed (sum < 50%).
      try {
        setRefreshProgress("Updating S&P 500 sector weights...");
        const cacheBust = Date.now();
        const spyRes = await fetch(
          `/api/fund-data?ticker=SPY&_=${cacheBust}`,
          { cache: "no-store" }
        );
        if (spyRes.ok) {
          const spyData = await spyRes.json();
          const sectorWeightings = spyData.fundData?.sectorWeightings;
          if (Array.isArray(sectorWeightings) && sectorWeightings.length > 0) {
            const weights: Record<string, number> = {};
            for (const sw of sectorWeightings) {
              const normalized = normalizeSector(sw.sector);
              weights[normalized] = parseFloat(sw.weight.toFixed(1));
            }
            const total = Object.values(weights).reduce((a, b) => a + b, 0);
            if (total >= 50 && onUpdateMarketData) {
              onUpdateMarketData({
                sp500SectorWeights: weights,
                sp500SectorWeightsAt: new Date().toISOString(),
              });
            }
          }
        }
      } catch { /* best effort */ }

      setRefreshProgress(`Updated ${updated}/${tickers.length} holdings`);
      // Clear progress message after 3s
      setTimeout(() => setRefreshProgress(""), 3000);
      // Also refresh live prices
      fetchPrices();
    } catch (err) {
      setRefreshProgress(err instanceof Error ? err.message : "Refresh failed");
      setTimeout(() => setRefreshProgress(""), 5000);
    } finally {
      setRefreshingAll(false);
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" || key === "bucket" || key === "sector" ? "asc" : "desc");
    }
  }

  // Portfolio beta (weighted by equal weight for now)
  const portfolioStocks = stocks.filter((s) => s.bucket === "Portfolio");
  const portfolioBeta = portfolioStocks.length > 0
    ? portfolioStocks.reduce((sum, s) => sum + s.beta, 0) / portfolioStocks.length
    : null;

  // Compute counts per instrument filter for badges
  const filterCounts = useMemo(() => {
    const counts: Record<InstrumentFilter, number> = { all: stocks.length, stocks: 0, "etf-usd": 0, "etf-cad": 0, "mutual-fund": 0 };
    for (const s of stocks) {
      if (!s.instrumentType || s.instrumentType === "stock") counts.stocks++;
      else if (s.instrumentType === "etf" && !isCanadianTicker(s.ticker)) counts["etf-usd"]++;
      else if (s.instrumentType === "etf" && isCanadianTicker(s.ticker)) counts["etf-cad"]++;
      else if (s.instrumentType === "mutual-fund") counts["mutual-fund"]++;
    }
    return counts;
  }, [stocks]);

  const sorted = useMemo(() => {
    const filtered = stocks.filter((s) =>
      matchesFilter(s, instrumentFilter) &&
      `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "bucket": cmp = a.bucket.localeCompare(b.bucket); break;
        case "sector": cmp = a.sector.localeCompare(b.sector); break;
        case "raw": cmp = a.raw - b.raw; break;
        case "adjusted": cmp = a.adjusted - b.adjusted; break;
        case "rating": cmp = (RATING_ORDER[a.rating] || 0) - (RATING_ORDER[b.rating] || 0); break;
        case "risk": cmp = (RISK_ORDER[a.risk] || 0) - (RISK_ORDER[b.risk] || 0); break;
        case "effect": cmp = (a.adjusted - a.raw) - (b.adjusted - b.raw); break;
        case "price": cmp = (livePrices[a.ticker] || 0) - (livePrices[b.ticker] || 0); break;
        case "pnl": {
          const aPnl = livePrices[a.ticker] && a.costBasis ? ((livePrices[a.ticker]! - a.costBasis) / a.costBasis) : 0;
          const bPnl = livePrices[b.ticker] && b.costBasis ? ((livePrices[b.ticker]! - b.costBasis) / b.costBasis) : 0;
          cmp = aPnl - bPnl;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [stocks, query, sortKey, sortDir, livePrices, instrumentFilter]);

  // Sort affordance: the active column carries a direction glyph (AppIcon,
  // never a text arrow).
  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <th className={`cursor-pointer select-none hover:text-ink ${right ? "n" : ""}`} onClick={() => toggleSort(k)}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {label}
        {sortKey === k && <AppIcon name={sortDir === "asc" ? "sortAsc" : "sortDesc"} size={12} />}
      </span>
    </th>
  );

  const SORT_LABELS: Record<SortKey, string> = {
    ticker: "ticker", bucket: "bucket", sector: "sector", raw: "raw score",
    adjusted: "adjusted score", rating: "rating", risk: "risk",
    effect: "regime effect", price: "price", pnl: "P&L",
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar: instrument filter · search · refresh actions ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg">
          {(Object.keys(FILTER_LABELS) as InstrumentFilter[]).map((key) => {
            const count = filterCounts[key];
            if (key !== "all" && count === 0) return null;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setInstrumentFilter(key)}
                className={instrumentFilter === key ? "on" : ""}
              >
                {FILTER_LABELS[key]} <span className="c">{count}</span>
              </button>
            );
          })}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ticker, name, sector…"
          aria-label="Search holdings"
          className="h-7 w-full min-w-[200px] rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border focus:ring-1 focus:ring-accent-border md:w-56"
        />

        {portfolioBeta != null && (
          <span className="text-[11.5px] text-ink-3">
            Portfolio &beta; <span className="font-mono text-ink-2">{portfolioBeta.toFixed(2)}</span>
          </span>
        )}
        {pricesFetchedAt && (
          <span className="text-[11.5px] text-ink-3">
            Prices {new Date(pricesFetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={fetchPrices}
            disabled={pricesLoading}
            className={BTN}
            title="Refresh prices from Yahoo Finance"
          >
            <AppIcon name="refresh" size={13} className={pricesLoading ? "animate-spin" : ""} />
            {pricesLoading ? "Updating…" : "Refresh prices"}
          </button>
          {onRefreshData && (
            <button
              onClick={handleRefreshAll}
              disabled={refreshingAll || scoringAll}
              className={BTN_PRIMARY}
              title="Refresh technicals, health data & risk alerts for all stocks (no AI scoring — zero token usage)"
            >
              {refreshingAll ? (
                <><AppIcon name="refresh" size={13} className="animate-spin" />{refreshProgress || "Refreshing…"}</>
              ) : refreshProgress ? (
                <>{refreshProgress}</>
              ) : (
                <><AppIcon name="download" size={13} />Refresh all data</>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Split into Portfolio (stocks), Watchlist (stocks), and Funds & ETFs */}
      {(["Portfolio", "Watchlist", "Funds & ETFs"] as const).map((section) => {
        const isFundsSection = section === "Funds & ETFs";
        const isPortfolio = section === "Portfolio";
        const sectionStocks = isFundsSection
          ? sorted.filter((s) => !isScoreable(s))
          : sorted.filter((s) => s.bucket === section && isScoreable(s));
        if (sectionStocks.length === 0) return null;

        // For the Funds & ETFs section, show cost basis & P&L for portfolio holdings
        const showCostBasis = isPortfolio || isFundsSection;
        const totalInSection = isFundsSection
          ? stocks.filter((s) => !isScoreable(s)).length
          : stocks.filter((s) => s.bucket === section && isScoreable(s)).length;

        return (
          <section key={section} className="panel">
            <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
              <span className="t">{section}</span>
              <span className="m font-mono">{sectionStocks.length}</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {!isFundsSection && (() => {
                  const prefKey = `chartingCleared_${section}`;
                  const lastCleared = uiPrefs[prefKey];
                  const confirmKey = `chartingConfirm_${section}`;
                  const isConfirming = uiPrefs[confirmKey] === "1";
                  const charted = sectionStocks.filter((s) => (s.scores?.charting ?? 0) > 0).length;
                  return (
                    <span className="inline-flex items-center gap-2">
                      {!isConfirming && lastCleared && (
                        <span className="m" title={lastCleared}>
                          Charting cleared {new Date(lastCleared).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                      <button
                        onClick={() => {
                          if (!isConfirming) {
                            setUiPref(confirmKey, "1");
                            setTimeout(() => setUiPref(confirmKey, ""), 4000);
                            return;
                          }
                          setUiPref(confirmKey, "");
                          if (charted === 0) return;
                          for (const s of sectionStocks) {
                            if ((s.scores?.charting ?? 0) > 0) updateScore(s.ticker, "charting", 0);
                          }
                          setUiPref(prefKey, new Date().toISOString());
                        }}
                        className={isConfirming ? BTN_DANGER : BTN}
                        title={`Reset charting score to 0 for all ${section.toLowerCase()} stocks`}
                      >
                        {isConfirming ? `Confirm clear ${charted} stocks?` : "Clear charting"}
                      </button>
                      {isConfirming && (
                        <button onClick={() => setUiPref(confirmKey, "")} className="text-[11.5px] text-ink-3 hover:text-ink">
                          Cancel
                        </button>
                      )}
                    </span>
                  );
                })()}
                {onScoreStock && !isFundsSection && (
                  <button
                    onClick={() => handleScoreBucket(section as "Portfolio" | "Watchlist")}
                    disabled={scoringAll}
                    className={BTN_PRIMARY}
                    title={`Score all ${section.toLowerCase()} stocks with Claude`}
                  >
                    {scoringAll && scoringBucket === section ? (
                      <><AppIcon name="refresh" size={13} className="animate-spin" />{scoreProgress}</>
                    ) : (
                      <>Score all <span className="font-mono opacity-70">{sectionStocks.filter((s) => isScoreable(s)).length}</span></>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Mobile card view */}
            <div className="flex flex-col divide-y divide-line-soft md:hidden">
              {sectionStocks.map((s) => {
                const livePrice = livePrices[s.ticker];
                const costBasis = s.costBasis;
                const pnlPct = livePrice && costBasis ? ((livePrice - costBasis) / costBasis * 100) : null;
                const isPortfolioHolding = s.bucket === "Portfolio";
                return (
                  <div
                    key={`mobile-${s.ticker}-${s.bucket}`}
                    className="cursor-pointer px-3.5 py-3 hover:bg-surface-hover transition-colors"
                    onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-mono text-[13px] font-medium text-ink">{displayTicker(s.ticker)}</span>
                      {s.instrumentType && s.instrumentType !== "stock" && (
                        <span className="text-[11px] text-ink-3">{INSTRUMENT_LABELS[s.instrumentType]}</span>
                      )}
                      {isFundsSection && <span className="text-[11px] text-ink-3">{s.bucket}</span>}
                      <span className="ml-auto flex items-center gap-2.5 text-[11.5px]">
                        {isScoreable(s) ? (
                          <>
                            <span className={ratingCls(s.rating)}>{s.rating}</span>
                            <span className="inline-flex items-center gap-1.5 text-ink-2">
                              <span className={`dot ${riskDot(s.risk)}`} />{s.risk}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-3">Wt <span className="font-mono text-ink-2">{s.weights.portfolio}%</span></span>
                        )}
                      </span>
                    </div>
                    <div className="mb-2 text-[11.5px] text-ink-3">{s.name}{isScoreable(s) && s.sector ? ` · ${s.sector}` : ""}</div>
                    <div className={`grid gap-3 ${isPortfolioHolding ? "grid-cols-3" : "grid-cols-2"}`}>
                      <div>
                        <div className="text-[11px] text-ink-3">Price</div>
                        <div className="font-mono text-[12.5px] text-ink">
                          {pricesLoading ? "…" : livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-ink-3">{isFundsSection ? "Weight" : "Score"}</div>
                        <div className="font-mono text-[12.5px] text-ink">
                          {isFundsSection ? `${s.weights.portfolio}%` : <>{Number(s.adjusted.toFixed(1))}<span className="text-ink-faint">/{MAX_SCORE}</span></>}
                        </div>
                      </div>
                      {isPortfolioHolding && (
                        <div>
                          <div className="text-[11px] text-ink-3">P&amp;L</div>
                          <div className={`font-mono text-[12.5px] ${pnlPct != null ? (pnlPct >= 0 ? "text-pos" : "text-neg") : "text-ink-faint"}`}>
                            {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : "—"}
                          </div>
                        </div>
                      )}
                    </div>
                    {(s.companySummary || s.investmentThesis) && (
                      <div className="mt-2.5 flex flex-col gap-1 border-t border-line-soft pt-2.5">
                        {s.companySummary && <p className="text-[11.5px] leading-[1.5] text-ink-2">{s.companySummary}</p>}
                        {s.investmentThesis && <p className="text-[11.5px] leading-[1.5] text-ink-2">{s.investmentThesis}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className={`data-table ${isFundsSection ? "min-w-[900px]" : "min-w-[1400px]"}`}>
                <thead>
                  <tr>
                    <th className="cursor-pointer select-none pl-3.5 hover:text-ink" onClick={() => toggleSort("ticker")}>
                      <span className="inline-flex items-center gap-1">
                        Ticker
                        {sortKey === "ticker" && <AppIcon name={sortDir === "asc" ? "sortAsc" : "sortDesc"} size={12} />}
                      </span>
                    </th>
                    {isFundsSection && <SortHead k="bucket" label="Bucket" />}
                    {!isFundsSection && <SortHead k="sector" label="Sector" />}
                    <SortHead k="price" label="Price" right />
                    {showCostBasis && <th className="n">Cost basis</th>}
                    {showCostBasis && <SortHead k="pnl" label="P&L" right />}
                    {!isFundsSection && (
                      <>
                        <SortHead k="raw" label="Raw" right />
                        <SortHead k="adjusted" label="Adj." right />
                        <SortHead k="rating" label="Rating" />
                        <SortHead k="risk" label="Risk" />
                        <SortHead k="effect" label="Regime" right />
                        <th>What they do</th>
                        <th>Why own it</th>
                      </>
                    )}
                    {isFundsSection && <th className="n">Weight</th>}
                  </tr>
                </thead>
                <tbody>
                  {sectionStocks.map((s) => {
                    const effect = (s.adjusted - s.raw).toFixed(1);
                    const livePrice = livePrices[s.ticker];
                    const cb = s.costBasis;
                    const isPortfolioHolding = s.bucket === "Portfolio";
                    const pnlPct = livePrice && cb ? ((livePrice - cb) / cb * 100) : null;
                    return (
                      <tr
                        key={`${s.ticker}-${s.bucket}`}
                        className="cursor-pointer"
                        onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                      >
                        <td className="pl-3.5">
                          <span className="flex items-center gap-2">
                            <span className="font-mono font-medium text-ink">{displayTicker(s.ticker)}</span>
                            {s.instrumentType && s.instrumentType !== "stock" && (
                              <span className="text-[11px] text-ink-3">{INSTRUMENT_LABELS[s.instrumentType]}</span>
                            )}
                            <span className="max-w-[160px] truncate text-[11.5px] text-ink-3">{s.name}</span>
                          </span>
                        </td>
                        {isFundsSection && <td className="text-ink-2">{s.bucket}</td>}
                        {!isFundsSection && <td className="text-ink-2">{s.sector}</td>}
                        <td className="n">
                          {pricesLoading ? (
                            <span className="animate-pulse text-ink-faint">…</span>
                          ) : livePrice != null ? (
                            <span className="text-ink">${livePrice.toFixed(2)}</span>
                          ) : (
                            <span className="text-ink-faint">&mdash;</span>
                          )}
                        </td>
                        {showCostBasis && (
                          <td className="n" onClick={(e) => e.stopPropagation()}>
                            {isPortfolioHolding ? (
                              <input
                                type="number"
                                step="0.01"
                                placeholder="—"
                                aria-label={`Cost basis for ${s.ticker}`}
                                value={cb ?? ""}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  if (onUpdateCostBasis && !isNaN(val)) onUpdateCostBasis(s.ticker, val);
                                  else if (onUpdateCostBasis && e.target.value === "") onUpdateCostBasis(s.ticker, 0);
                                }}
                                className="h-7 w-20 rounded-control border border-transparent bg-transparent px-1.5 text-right font-mono text-[12.5px] text-ink-2 outline-none transition-colors hover:border-line focus:border-accent-border focus:bg-surface focus:ring-1 focus:ring-accent-border"
                              />
                            ) : (
                              <span className="text-ink-faint">&mdash;</span>
                            )}
                          </td>
                        )}
                        {showCostBasis && (
                          <td className="n">
                            {isPortfolioHolding && pnlPct != null ? (
                              <span className={pnlPct >= 0 ? "text-pos" : "text-neg"}>
                                {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-ink-faint">&mdash;</span>
                            )}
                          </td>
                        )}
                        {!isFundsSection && (
                          <>
                            <td className="n text-ink-2">
                              {Number(s.raw.toFixed(1))}<span className="text-ink-faint">/{MAX_SCORE}</span>
                            </td>
                            <td className="n">
                              {Number(s.adjusted.toFixed(1))}<span className="text-ink-faint">/{MAX_SCORE}</span>
                            </td>
                            <td className={ratingCls(s.rating)}>{s.rating}</td>
                            <td>
                              <span className="inline-flex items-center gap-1.5 text-ink-2">
                                <span className={`dot ${riskDot(s.risk)}`} />{s.risk}
                              </span>
                            </td>
                            <td className={`n ${Number(effect) >= 0 ? "text-pos" : "text-neg"}`}>
                              {Number(effect) >= 0 ? "+" : ""}{effect}
                            </td>
                            <td className="max-w-[240px]">
                              <span className="block truncate text-[12px] text-ink-2" title={s.companySummary || undefined}>
                                {s.companySummary || <span className="text-ink-faint">Score to generate</span>}
                              </span>
                            </td>
                            <td className="max-w-[240px]">
                              <span className="block truncate text-[12px] text-ink-2" title={s.investmentThesis || undefined}>
                                {s.investmentThesis || <span className="text-ink-faint">Score to generate</span>}
                              </span>
                            </td>
                          </>
                        )}
                        {isFundsSection && <td className="n text-ink-2">{s.weights.portfolio}%</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer strip */}
            <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
              {sectionStocks.length} of {totalInSection} · sorted by {SORT_LABELS[sortKey]} {sortDir === "asc" ? "ascending" : "descending"}
            </div>
          </section>
        );
      })}
    </div>
  );
}
