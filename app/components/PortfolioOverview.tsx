"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoredStock, ScoreKey, HealthData, FundHolding, FundSectorWeight } from "@/app/lib/types";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { groupTotal, isScoreable, normalizeSector } from "@/app/lib/scoring";
import { SignalPill } from "./SignalPill";

/** Format an ISO timestamp for display next to Score All / Refresh All buttons. */
function formatRelTimestamp(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// S&P 500 fallback sector weights (used when live SPY data is unavailable)
const SP500_WEIGHTS_FALLBACK: Record<string, number> = {
  Technology: 32,
  "Health Care": 12,
  Financials: 13,
  "Consumer Discretionary": 10,
  "Communication Services": 9,
  Industrials: 9,
  "Consumer Staples": 6,
  Energy: 4,
  Utilities: 2,
  "Real Estate": 2,
  Materials: 2,
};

// Normalize sector names — Yahoo uses different names than GICS standard
// normalizeSector imported from scoring.ts — centralized Yahoo→GICS mapping

// Distinct colors for each GICS sector — all visually distinguishable
const sectorColors: Record<string, string> = {
  Technology: "bg-blue-600",
  Financials: "bg-teal-500",
  Energy: "bg-red-500",
  "Consumer Staples": "bg-amber-500",
  "Consumer Discretionary": "bg-orange-500",
  "Health Care": "bg-purple-500",
  Industrials: "bg-slate-500",
  "Communication Services": "bg-indigo-500",
  Utilities: "bg-lime-500",
  Materials: "bg-cyan-500",
  "Real Estate": "bg-pink-500",
};

/** Compact "x minutes/hours/days ago" formatter for last-updated labels. */
function formatTimeAgo(iso: string): string {
  const ts = Date.parse(iso);
  if (!isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fundReturnFmt(val: number | undefined): string {
  if (val == null) return "—";
  return `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
}

function fundReturnColor(val: number | undefined): string {
  if (val == null) return "text-slate-400";
  return val >= 0 ? "text-emerald-600" : "text-red-500";
}

function ratingColor(label: string): string {
  if (label.includes("Buy")) return "text-emerald-600";
  if (label.includes("Underweight")) return "text-amber-600";
  if (label === "Sell") return "text-red-600";
  return "text-slate-700";
}

type DashboardFilter = "all" | "stocks" | "etf-usd" | "etf-cad" | "mutual-fund";

const DASH_FILTER_LABELS: Record<DashboardFilter, string> = {
  all: "All",
  stocks: "Stocks",
  "etf-usd": "ETFs (USD)",
  "etf-cad": "ETFs (CAD)",
  "mutual-fund": "Mutual Funds",
};

function isCanadianTicker(ticker: string): boolean {
  // .U suffix = USD-denominated Canadian-listed ETF (e.g., XUS.U, XUU.U) — NOT Canadian
  if (ticker.endsWith(".U")) return false;
  return ticker.endsWith(".TO") || /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

function matchesDashFilter(s: ScoredStock, filter: DashboardFilter): boolean {
  if (filter === "all") return true;
  if (filter === "stocks") return !s.instrumentType || s.instrumentType === "stock";
  if (filter === "etf-usd") return s.instrumentType === "etf" && !isCanadianTicker(s.ticker);
  if (filter === "etf-cad") return s.instrumentType === "etf" && isCanadianTicker(s.ticker);
  if (filter === "mutual-fund") return s.instrumentType === "mutual-fund";
  return true;
}

type FundSortField = "ticker" | "name" | "type" | "role" | "weight" | "price" | "ytd" | "oneYear" | "threeYear" | "fiveYear" | "tenYear"; // "weight" kept for backwards compat with saved prefs
type SortDir = "asc" | "desc";

function FundSortIcon({ field, sortField, sortDir }: { field: FundSortField; sortField: FundSortField; sortDir: SortDir }) {
  if (field !== sortField) {
    return (
      <svg className="w-3 h-3 ml-0.5 inline opacity-30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
      </svg>
    );
  }
  return sortDir === "asc" ? (
    <svg className="w-3 h-3 ml-0.5 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 15l4-4 4 4" />
    </svg>
  ) : (
    <svg className="w-3 h-3 ml-0.5 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 4 4-4" />
    </svg>
  );
}



export function PortfolioOverview() {
  const {
    portfolioStocks,
    watchlistStocks,
    marketData,
    updateStockFields,
    updateScore,
    updateExplanations,
    updateLastScored,
    updatePrice,
    updateHealthData,
    updateTechnicals,
    updateFundData,
    updateMarketData,
    uiPrefs,
    setUiPref,
  } = useStocks();
  const [dashFilter, setDashFilter] = useState<DashboardFilter>("all");

  // Portfolio β — weighted average across individual stocks only, using
  // the per-stock portfolio weight. ETFs and mutual funds are excluded
  // (their beta is a different series and including them double-counts
  // the stocks they hold). Falls back to equal-weight if weights sum to
  // zero so the chip still renders something meaningful. Source values
  // are auto-refreshed from Yahoo summaryDetail.beta on Refresh All Data.
  const portfolioBeta = useMemo(() => {
    const individualStocks = portfolioStocks.filter(
      (s) => !s.instrumentType || s.instrumentType === "stock"
    );
    if (individualStocks.length === 0) return null;
    const totalWeight = individualStocks.reduce(
      (sum, s) => sum + (s.weights.portfolio || 0),
      0
    );
    if (totalWeight > 0) {
      const weighted = individualStocks.reduce(
        (sum, s) => sum + s.beta * (s.weights.portfolio || 0),
        0
      );
      return weighted / totalWeight;
    }
    return (
      individualStocks.reduce((sum, s) => sum + s.beta, 0) /
      individualStocks.length
    );
  }, [portfolioStocks]);

  const fundSort = (uiPrefs["fundSort"] as FundSortField) || "ticker";
  const fundSortDir = (uiPrefs["fundSortDir"] as SortDir) || "desc";
  const setFundSort = (f: FundSortField) => setUiPref("fundSort", f);
  const setFundSortDir = (d: SortDir | ((prev: SortDir) => SortDir)) => {
    const val = typeof d === "function" ? d(fundSortDir) : d;
    setUiPref("fundSortDir", val);
  };

  // ── Score All / Refresh All state ────────────────────────────────────────
  // Per-bucket scoring state so clicking "Score All" under Portfolio Rankings
  // doesn't disable the Watchlist Rankings button (and vice versa), but both
  // share the same guard against firing refresh while either is running.
  const [scoringBucket, setScoringBucket] = useState<"Portfolio" | "Watchlist" | null>(null);
  const [scoreProgress, setScoreProgress] = useState("");
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState("");
  const scoringAny = scoringBucket != null;

  // Timestamps persist across reloads via the same uiPrefs → Redis KV bridge
  // the rest of this screen already uses. Keys: scoreAll<Bucket>At, refreshAllAt.
  const scoreAllPortfolioAt = uiPrefs["scoreAllPortfolioAt"] || "";
  const scoreAllWatchlistAt = uiPrefs["scoreAllWatchlistAt"] || "";
  const refreshAllAt = uiPrefs["refreshAllAt"] || "";

  /** Score one stock by POSTing /api/score, then fanning the result out into
   *  the context mutators so both the dashboard and PIM Model pick it up.
   *
   *  Web-search verification is always enabled for batch rescores. Each call
   *  spends ~4 searches verifying the latest reported quarter, guidance
   *  revisions, analyst rating/PT changes, and (for Canadian listings)
   *  primary financial figures. A 50-name batch takes ~5-8 min total and
   *  ~$1.50-2.50 in API spend, but produces fully audited scores rather
   *  than scores derived from possibly-stale cached feeds.
   */
  const scoreOneStock = useCallback(async (ticker: string) => {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, verifyWithWebSearch: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to score ${ticker}`);
    }
    const data = await res.json();
    if (data.scores) {
      for (const [key, val] of Object.entries(data.scores)) {
        updateScore(ticker, key as ScoreKey, val as number);
      }
    }
    if (data.explanations) updateExplanations(ticker, data.explanations);
    if (data.price != null) updatePrice(ticker, data.price);
    if (data.healthData) updateHealthData(ticker, data.healthData);
    if (data.technicals && data.riskAlert) {
      updateTechnicals(ticker, data.technicals, data.riskAlert);
    }
    if (data.companySummary || data.investmentThesis || data.sector || data.name) {
      updateStockFields(ticker, {
        ...(data.companySummary ? { companySummary: data.companySummary } : {}),
        ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
        ...(data.sector ? { sector: data.sector } : {}),
        ...(data.name && data.name !== "Unknown" ? { name: data.name } : {}),
      });
    }
    updateLastScored(
      ticker,
      new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      })
    );
  }, [updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields]);

  /** Sequentially score every scoreable stock in a bucket, updating a progress
   *  banner and finally stamping the "Score All" timestamp on success. */
  const handleScoreBucket = useCallback(async (bucket: "Portfolio" | "Watchlist") => {
    if (scoringAny || refreshingAll) return;
    const source = bucket === "Portfolio" ? portfolioStocks : watchlistStocks;
    const bucketStocks = source.filter((s) => isScoreable(s));
    if (bucketStocks.length === 0) return;
    setScoringBucket(bucket);
    for (let i = 0; i < bucketStocks.length; i++) {
      const s = bucketStocks[i];
      setScoreProgress(`Scoring ${s.ticker} (${i + 1}/${bucketStocks.length})`);
      try {
        await scoreOneStock(s.ticker);
      } catch { /* best-effort — keep going so one bad ticker doesn't block the rest */ }
    }
    setScoreProgress("");
    setScoringBucket(null);
    setUiPref(
      bucket === "Portfolio" ? "scoreAllPortfolioAt" : "scoreAllWatchlistAt",
      new Date().toISOString()
    );
  }, [scoringAny, refreshingAll, portfolioStocks, watchlistStocks, scoreOneStock, setUiPref]);

  /** Refresh *every* position — portfolio holdings, fund & ETF holdings,
   *  and watchlist — via /api/refresh-data, then re-fetch fund metadata for
   *  ETFs/mutual funds, then refresh the live SPY sector weights that feed
   *  the Portfolio Sector Exposure bar. Does NOT call Claude, so zero token
   *  spend. Mirrors the Refresh All Data flow from the old Scoring page. */
  const handleRefreshAll = useCallback(async () => {
    if (refreshingAll || scoringAny) return;
    setRefreshingAll(true);
    setRefreshProgress("Fetching data...");
    try {
      const allStocks = [...portfolioStocks, ...watchlistStocks];
      const tickers = allStocks.map((s) => s.ticker);
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
      const results: Array<{
        ticker: string;
        error?: string;
        name?: string;
        sector?: string;
        price?: number;
        beta?: number;
        technicals?: TechnicalIndicators;
        healthData?: HealthData;
        riskAlert?: RiskAlert;
      }> = data.results || [];
      // Map ticker → current stock so we can check instrumentType when
      // deciding whether to accept Yahoo's beta (funds use a different
      // series via /api/fund-data and shouldn't be overwritten here).
      const stockByTicker = new Map(allStocks.map((s) => [s.ticker, s] as const));
      let updated = 0;
      for (const r of results) {
        if (r.error) continue;
        if (r.price != null) updatePrice(r.ticker, r.price);
        if (r.healthData) updateHealthData(r.ticker, r.healthData);
        if (r.technicals) {
          const fallbackAlert: RiskAlert = {
            level: "clear", signals: [], summary: "No signals", dangerCount: 0, cautionCount: 0,
          };
          updateTechnicals(r.ticker, r.technicals, r.riskAlert || fallbackAlert);
        }
        // Only persist Yahoo's beta for individual stocks — ETFs and
        // mutual funds have their beta populated separately via fund-data.
        const s = stockByTicker.get(r.ticker);
        const isStock = !s?.instrumentType || s.instrumentType === "stock";
        const fieldUpdate: Partial<typeof s> = {};
        if (r.name) fieldUpdate.name = r.name;
        if (r.sector) fieldUpdate.sector = r.sector;
        if (isStock && typeof r.beta === "number") fieldUpdate.beta = r.beta;
        if (Object.keys(fieldUpdate).length > 0) {
          updateStockFields(r.ticker, fieldUpdate);
        }
        updated++;
      }
      // Refresh fund metadata (holdings, performance) for ETFs and MFs —
      // the /api/refresh-data route doesn't touch fundData.
      const fundStocks = allStocks.filter(
        (s) => s.instrumentType === "etf" || s.instrumentType === "mutual-fund"
      );
      // Capture each fund's *just-fetched* top holdings so the
      // sub-fund crawl pass (below) sees fresh data even when the
      // closure's fund.fundData was empty going in.
      const freshHoldingsByTicker = new Map<string, FundHolding[]>();
      if (fundStocks.length > 0) {
        setRefreshProgress(`Updated ${updated} stocks. Refreshing ${fundStocks.length} fund(s)...`);
        for (const fund of fundStocks) {
          try {
            const fRes = await fetch(`/api/fund-data?ticker=${encodeURIComponent(fund.ticker)}`);
            if (!fRes.ok) continue;
            const fData = await fRes.json();
            if (fData.fundData) {
              const existing = fund.fundData;
              const merged = { ...fData.fundData };
              // Preserve user-provided holdings when the API returns none.
              if (!merged.topHoldings?.length && existing?.topHoldings?.length) {
                merged.topHoldings = existing.topHoldings;
                merged.sectorWeightings = existing.sectorWeightings;
                merged.holdingsLastUpdated = existing.holdingsLastUpdated;
                merged.holdingsSource = existing.holdingsSource;
              }
              if (existing?.holdingsUrl && !merged.holdingsUrl) {
                merged.holdingsUrl = existing.holdingsUrl;
              }
              if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
                merged.holdingsLastUpdated = existing.holdingsLastUpdated;
              }
              if (merged.topHoldings?.length && !merged.holdingsLastUpdated) {
                merged.holdingsLastUpdated = new Date().toISOString();
              }

              // If the user had previously pasted a URL as the holdings
              // source, re-scrape it so URL-sourced holdings stay current
              // (the embedded scraper's result is otherwise frozen in
              // time from the moment the user first clicked Fetch). The
              // URL result takes precedence over the embedded result —
              // the user explicitly chose that source.
              const urlToRefresh = merged.holdingsUrl;
              if (urlToRefresh) {
                try {
                  const urlRes = await fetch("/api/fund-data", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: urlToRefresh, ticker: fund.ticker }),
                  });
                  if (urlRes.ok) {
                    const urlData = await urlRes.json();
                    if (Array.isArray(urlData.topHoldings) && urlData.topHoldings.length > 0) {
                      merged.topHoldings = urlData.topHoldings;
                      if (Array.isArray(urlData.sectorWeightings) && urlData.sectorWeightings.length > 0) {
                        merged.sectorWeightings = urlData.sectorWeightings;
                      }
                      merged.holdingsLastUpdated = new Date().toISOString();
                      try {
                        merged.holdingsSource = new URL(urlToRefresh).hostname.replace(/^www\./, "");
                      } catch {
                        merged.holdingsSource = "Custom URL";
                      }
                    }
                  }
                } catch {
                  /* URL re-scrape failed — fall back to whatever merged already has */
                }
              }

              updateFundData(fund.ticker, merged);
              if (merged.topHoldings?.length) {
                freshHoldingsByTicker.set(fund.ticker.toUpperCase(), merged.topHoldings);
              }
            }
            if (fData.price != null && typeof fData.price === "number") {
              updatePrice(fund.ticker, fData.price);
            }
          } catch { /* best effort per fund */ }
        }
      }
      // Crawl one level deeper: for every fund we just refreshed, look
      // at its top holdings and grab any ≥20%-weight constituent that
      // isn't already in portfolio/watchlist. A 20%+ weight is almost
      // always a sub-fund (e.g. XSP.TO → IVV at 98.6%), so this fills
      // out look-through data the X-ray and Top Holdings panel need
      // without polluting the user's stock list with foreign tickers.
      //
      // Cached results are written to pm:fund-data-cache in a single
      // PATCH so one Refresh All click = at most one KV write per run.
      try {
        const inStockList = new Set(
          [...portfolioStocks, ...watchlistStocks].map((s) => s.ticker.toUpperCase())
        );
        // Re-read the just-updated fund list from the ref would require
        // a render; instead, re-fetch the handful of heavy children
        // directly from the GET we already ran. Collect candidate
        // tickers here.
        const heavyChildren = new Set<string>();
        for (const [, hs] of freshHoldingsByTicker) {
          for (const h of hs) {
            if (!h.symbol) continue;
            if (h.weight < 20) continue;
            const sym = h.symbol.toUpperCase();
            if (inStockList.has(sym)) continue; // already refreshed above
            heavyChildren.add(sym);
          }
        }

        if (heavyChildren.size > 0) {
          setRefreshProgress(`Crawling ${heavyChildren.size} sub-fund(s) for look-through...`);
          const newCacheEntries: Record<
            string,
            {
              topHoldings?: FundHolding[];
              sectorWeightings?: FundSectorWeight[];
              holdingsSource?: string;
              fundFamily?: string;
              lastUpdated: string;
            }
          > = {};
          for (const sym of heavyChildren) {
            try {
              const r = await fetch(`/api/fund-data?ticker=${encodeURIComponent(sym)}`);
              if (!r.ok) continue;
              const d = await r.json();
              const fd = d?.fundData;
              if (!fd?.topHoldings?.length) continue;
              newCacheEntries[sym] = {
                topHoldings: fd.topHoldings,
                sectorWeightings: fd.sectorWeightings,
                holdingsSource: fd.holdingsSource,
                fundFamily: fd.fundFamily,
                lastUpdated: new Date().toISOString(),
              };
            } catch { /* best effort per child */ }
          }
          if (Object.keys(newCacheEntries).length > 0) {
            try {
              await fetch("/api/kv/fund-data-cache", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entries: newCacheEntries }),
              });
            } catch { /* best effort — cache is optional */ }
          }
        }
      } catch { /* best effort — cache is optional */ }

      // Refresh S&P 500 sector weights from SPY so the sector exposure bar
      // compares against current benchmark weights. Uses a cache-busting
      // query param + no-store to defeat any browser/CDN caching that
      // could otherwise serve a stale SPY response and make it look like
      // the weights "never update". We also normalize sector names so
      // Yahoo's lower_case_underscore variants (e.g. "technology",
      // "consumer_cyclical") align with our internal GICS labels — without
      // this, the over/underweight diff vs. the portfolio sector bar
      // misses entirely because the keys don't match.
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
            // Sanity check: SPY weights should sum to ~100. If they sum to
            // <50 we got a malformed payload — keep the previous saved
            // values rather than overwriting with garbage.
            const total = Object.values(weights).reduce((a, b) => a + b, 0);
            if (total >= 50) {
              updateMarketData({
                sp500SectorWeights: weights,
                sp500SectorWeightsAt: new Date().toISOString(),
              });
            }
          }
        }
      } catch { /* best effort */ }
      setRefreshProgress(`Updated ${updated}/${tickers.length} holdings`);
      setUiPref("refreshAllAt", new Date().toISOString());
      setTimeout(() => setRefreshProgress(""), 3000);
    } catch (err) {
      setRefreshProgress(err instanceof Error ? err.message : "Refresh failed");
      setTimeout(() => setRefreshProgress(""), 5000);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, scoringAny, portfolioStocks, watchlistStocks, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateFundData, updateMarketData, setUiPref]);

  // ── Auto-refresh on first Dashboard view of the day ────────────────
  //
  // When the user opens the Dashboard tab and the persisted
  // refreshAllAt timestamp is from a previous calendar day (or
  // missing), automatically fire handleRefreshAll once. The function
  // itself updates refreshAllAt at the end of a successful run, so
  // subsequent visits the same day skip this auto-fire.
  //
  // Guards:
  // - autoFireRef ensures we only attempt the fire once per mount
  //   (React Strict Mode would otherwise double-fire effects).
  // - We wait until portfolioStocks has loaded (length > 0) so the
  //   refresh has actual tickers to operate on. This also serves as
  //   a proxy for "uiPrefs has been hydrated from KV" since they
  //   load together via StockContext.
  // - Compare local-date strings (YYYY-MM-DD) — feels right to a PM
  //   used to thinking in trading days, not UTC.
  const autoFireRef = useRef(false);
  useEffect(() => {
    if (autoFireRef.current) return;
    if (refreshingAll || scoringAny) return;
    if (portfolioStocks.length === 0 && watchlistStocks.length === 0) return;
    const todayLocal = (() => {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();
    const lastDateLocal = refreshAllAt
      ? (() => {
          const d = new Date(refreshAllAt);
          if (isNaN(d.getTime())) return "";
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        })()
      : "";
    if (lastDateLocal === todayLocal) return; // already refreshed today
    autoFireRef.current = true;
    void handleRefreshAll();
  }, [refreshAllAt, refreshingAll, scoringAny, portfolioStocks.length, watchlistStocks.length, handleRefreshAll]);

  // Apply instrument filter first
  const filteredPortfolio = portfolioStocks.filter((s) => matchesDashFilter(s, dashFilter));
  const filteredWatchlist = watchlistStocks.filter((s) => matchesDashFilter(s, dashFilter));

  // Separate scoreable stocks from funds
  const scoreablePortfolio = filteredPortfolio.filter((s) => isScoreable(s));
  const fundPortfolio = filteredPortfolio.filter((s) => !isScoreable(s));
  const scoreableWatchlist = filteredWatchlist.filter((s) => isScoreable(s));
  const allScoreable = [...scoreablePortfolio, ...scoreableWatchlist].sort((a, b) => b.adjusted - a.adjusted);

  // Compute counts across ALL stocks (unfiltered) for filter badges
  const allStocks = [...portfolioStocks, ...watchlistStocks];
  const filterCounts: Record<DashboardFilter, number> = { all: allStocks.length, stocks: 0, "etf-usd": 0, "etf-cad": 0, "mutual-fund": 0 };
  for (const s of allStocks) {
    if (!s.instrumentType || s.instrumentType === "stock") filterCounts.stocks++;
    else if (s.instrumentType === "etf" && !isCanadianTicker(s.ticker)) filterCounts["etf-usd"]++;
    else if (s.instrumentType === "etf" && isCanadianTicker(s.ticker)) filterCounts["etf-cad"]++;
    else if (s.instrumentType === "mutual-fund") filterCounts["mutual-fund"]++;
  }

  // S&P 500 sector weights — use live data from marketData if available, else fallback
  const sp500Weights = marketData.sp500SectorWeights || SP500_WEIGHTS_FALLBACK;

  // Sector exposure — Alpha picks only (excludes Core indexed holdings)
  // Normalize sector names so Yahoo variants map to GICS standard
  const alphaPortfolio = scoreablePortfolio.filter((s) => s.designation !== "core");
  const alphaCount = alphaPortfolio.length;
  const sectorCounts: Record<string, number> = {};
  alphaPortfolio.forEach((s) => {
    const normalized = normalizeSector(s.sector);
    sectorCounts[normalized] = (sectorCounts[normalized] || 0) + 1;
  });
  const sectorExposure = Object.entries(sectorCounts)
    .map(([sector, count]) => ({
      sector,
      weight: alphaCount > 0 ? Math.round((count / alphaCount) * 100) : 0,
      count,
    }))
    .sort((a, b) => b.weight - a.weight);

  return (
    <div className="space-y-6">
      {/* Top toolbar: instrument filter + Refresh All Data (covers portfolio,
          fund & ETF holdings, and watchlist). */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
        {(Object.keys(DASH_FILTER_LABELS) as DashboardFilter[]).map((key) => {
          const count = filterCounts[key];
          if (key !== "all" && count === 0) return null;
          const active = dashFilter === key;
          return (
            <button
              key={key}
              onClick={() => setDashFilter(key)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-slate-800 text-white shadow-sm"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
              }`}
            >
              {DASH_FILTER_LABELS[key]}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-white/20 text-white" : "bg-slate-200 text-slate-500"}`}>
                {count}
              </span>
            </button>
          );
        })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {refreshAllAt && !refreshingAll && !refreshProgress && (
            <span className="text-[11px] text-slate-400">Last refreshed {formatRelTimestamp(refreshAllAt)}</span>
          )}
          <button
            onClick={handleRefreshAll}
            disabled={refreshingAll || scoringAny}
            className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            title="Refresh prices, technicals, health data, fund metadata and risk alerts for every position (no AI scoring)"
          >
            {refreshingAll ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                {refreshProgress || "Refreshing..."}
              </>
            ) : refreshProgress ? (
              <>{refreshProgress}</>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                Refresh All Data
              </>
            )}
          </button>
        </div>
      </div>

      {/* Sector Exposure */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <h2 className="text-lg font-bold text-slate-800">Portfolio Sector Exposure</h2>
          {portfolioBeta != null && (
            <span
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700"
              title="Weighted average beta across individual stocks only (excludes ETFs/mutual funds). Refreshed from Yahoo on Refresh All Data."
            >
              Portfolio {"\u03B2"} {portfolioBeta.toFixed(2)}
            </span>
          )}
          <span className="text-sm text-slate-400">Alpha picks only · {alphaCount} stocks (equal-weighted)</span>
          <span className="ml-auto text-xs text-slate-400">
            S&amp;P weights:{" "}
            {marketData.sp500SectorWeightsAt
              ? `updated ${formatTimeAgo(marketData.sp500SectorWeightsAt)}`
              : marketData.sp500SectorWeights
                ? "live (timestamp pending)"
                : "fallback (run Refresh All Data)"}
          </span>
        </div>
        <div className="flex h-8 rounded-xl overflow-hidden mb-3">
          {sectorExposure.map((s) => (
            <div
              key={s.sector}
              className={`${sectorColors[s.sector] || "bg-slate-400"} flex items-center justify-center text-[11px] font-semibold text-white`}
              style={{ width: `${s.weight}%` }}
            >
              {s.weight >= 8 && `${s.weight}%`}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-4">
          {sectorExposure.map((s) => (
            <span key={s.sector} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${sectorColors[s.sector] || "bg-slate-400"}`} />
              {s.sector} {s.weight}% ({s.count})
            </span>
          ))}
        </div>
        {/* Over/Underweight vs S&P */}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {sectorExposure.map((s) => {
            const spWeight = sp500Weights[s.sector] || 0;
            const diff = s.weight - spWeight;
            return (
              <div key={s.sector} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5">
                <span className="text-xs text-slate-600">{s.sector}</span>
                <span className={`text-xs font-semibold ${diff > 0 ? "text-emerald-600" : diff < 0 ? "text-red-500" : "text-slate-400"}`}>
                  {diff > 0 ? "+" : ""}{parseFloat(diff.toFixed(1))}% vs S&P
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Portfolio Rankings (scoreable stocks only) — moved above Fund & ETF Holdings */}
      <RankingTable
        title="Portfolio Rankings"
        subtitle="Bottom 3 flagged for review"
        stocks={scoreablePortfolio}
        flagType="review"
        uiPrefs={uiPrefs}
        setUiPref={setUiPref}
        onScoreAll={() => handleScoreBucket("Portfolio")}
        scoring={scoringBucket === "Portfolio"}
        scoreProgress={scoringBucket === "Portfolio" ? scoreProgress : ""}
        scoreAllDisabled={scoringAny || refreshingAll}
        lastScoredAt={scoreAllPortfolioAt}
      />

      {/* Fund Holdings */}
      {fundPortfolio.length > 0 && (() => {
        const handleFundSort = (field: FundSortField) => {
          if (fundSort === field) {
            setFundSortDir((d) => (d === "asc" ? "desc" : "asc"));
          } else {
            setFundSort(field);
            setFundSortDir(field === "ticker" || field === "name" || field === "type" || field === "role" ? "asc" : "desc");
          }
        };

        const sortedFunds = [...fundPortfolio].sort((a, b) => {
          let cmp = 0;
          const perfA = a.fundData?.performance;
          const perfB = b.fundData?.performance;
          switch (fundSort) {
            case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
            case "name": cmp = a.name.localeCompare(b.name); break;
            case "type": cmp = (a.instrumentType || "").localeCompare(b.instrumentType || ""); break;
            case "role": cmp = (a.designation || "alpha").localeCompare(b.designation || "alpha"); break;
            case "weight": cmp = a.weights.portfolio - b.weights.portfolio; break;
            case "price": cmp = (a.price ?? -1) - (b.price ?? -1); break;
            case "ytd": cmp = (perfA?.ytd ?? -999) - (perfB?.ytd ?? -999); break;
            case "oneYear": cmp = (perfA?.oneYear ?? -999) - (perfB?.oneYear ?? -999); break;
            case "threeYear": cmp = (perfA?.threeYear ?? -999) - (perfB?.threeYear ?? -999); break;
            case "fiveYear": cmp = (perfA?.fiveYear ?? -999) - (perfB?.fiveYear ?? -999); break;
            case "tenYear": cmp = (perfA?.tenYear ?? -999) - (perfB?.tenYear ?? -999); break;
          }
          return fundSortDir === "asc" ? cmp : -cmp;
        });

        const fThClass = "pb-2 font-semibold cursor-pointer select-none hover:text-slate-800 transition-colors whitespace-nowrap";

        return (
          <section className="rounded-[30px] border border-indigo-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-slate-800">Fund & ETF Holdings</h2>
              <span className="text-sm text-slate-400">{fundPortfolio.length} holdings</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className={fThClass} onClick={() => handleFundSort("ticker")}>
                      Ticker<FundSortIcon field="ticker" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("name")}>
                      Name<FundSortIcon field="name" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("type")}>
                      Type<FundSortIcon field="type" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("role")}>
                      Role<FundSortIcon field="role" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("price")}>
                      Price<FundSortIcon field="price" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("ytd")}>
                      YTD<FundSortIcon field="ytd" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("oneYear")}>
                      1Y<FundSortIcon field="oneYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("threeYear")}>
                      3Y<FundSortIcon field="threeYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("fiveYear")}>
                      5Y<FundSortIcon field="fiveYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("tenYear")}>
                      10Y<FundSortIcon field="tenYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFunds.map((s) => {
                    const perf = s.fundData?.performance;
                    // MER alert: flag the row when we don't have a credible
                    // MER. Missing OR zero both count as "needs attention"
                    // because a real fund/ETF essentially never has a 0%
                    // management fee — a 0 almost always means the
                    // auto-fetch scraped the wrong field. Without the
                    // alert, the Client Report's blended-MER calc silently
                    // treats the position as 0%, which understates fees.
                    const autoMer = s.fundData?.expenseRatio;
                    const manualMer = s.manualExpenseRatio;
                    const validMer = (v: number | null | undefined) =>
                      typeof v === "number" && Number.isFinite(v) && v > 0;
                    const hasMer = validMer(autoMer) || validMer(manualMer);
                    return (
                      <tr key={s.ticker} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <Link href={`/stock/${s.ticker.toLowerCase()}`} className="font-bold text-slate-800 hover:underline font-mono">
                              {s.ticker}
                            </Link>
                            {!hasMer && (
                              <Link
                                href={`/stock/${s.ticker.toLowerCase()}`}
                                title={
                                  validMer(autoMer)
                                    ? "" // unreachable
                                    : typeof autoMer === "number" && autoMer === 0
                                    ? "Auto-fetch returned 0% — almost certainly wrong for a fund/ETF. Click to enter the real MER as a manual override."
                                    : "No MER on file — click to add a manual override. Missing MERs show as 0% in the Client Report blended-fee calc."
                                }
                                className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 hover:bg-amber-200 transition-colors"
                              >
                                ⚠ No MER
                              </Link>
                            )}
                          </div>
                        </td>
                        <td className="py-3 text-slate-600 max-w-[180px] truncate">{s.name}</td>
                        <td className="py-3">
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${s.instrumentType === "etf" ? "bg-indigo-100 text-indigo-700" : "bg-purple-100 text-purple-700"}`}>
                            {INSTRUMENT_LABELS[s.instrumentType || "stock"]}
                          </span>
                        </td>
                        <td className="py-3">
                          {(() => {
                            // Only show Core/Alpha for equity-class ETFs/MFs
                            const nl = (s.name || "").toLowerCase();
                            const sl = (s.sector || "").toLowerCase();
                            const isBondOrAlt = sl.includes("bond") || sl.includes("fixed") || nl.includes("bond") || nl.includes("fixed income")
                              || sl.includes("alternative") || nl.includes("alternative") || nl.includes("premium yield") || nl.includes("premium incom") || nl.includes("hedge") || nl.includes("option income") || nl.includes("option writing") || nl.includes("covered call");
                            if (isBondOrAlt) return <span className="text-[10px] text-slate-300">—</span>;
                            return (
                              <button
                                onClick={() => updateStockFields(s.ticker, { designation: (s.designation || "alpha") === "core" ? "alpha" : "core" })}
                                className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors ${
                                  (s.designation || "alpha") === "core"
                                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                                    : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                }`}
                              >
                                {(s.designation || "alpha") === "core" ? "Core" : "Alpha"}
                              </button>
                            );
                          })()}
                        </td>
                        <td className="py-3 text-right text-slate-600">{s.price != null ? `$${s.price.toFixed(2)}` : "—"}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.ytd)}`}>{fundReturnFmt(perf?.ytd)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.oneYear)}`}>{fundReturnFmt(perf?.oneYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.threeYear)}`}>{fundReturnFmt(perf?.threeYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.fiveYear)}`}>{fundReturnFmt(perf?.fiveYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.tenYear)}`}>{fundReturnFmt(perf?.tenYear)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {/* Watchlist Rankings (scoreable stocks only) */}
      <RankingTable
        title="Watchlist Rankings"
        subtitle="Top 3 flagged as buy candidates"
        stocks={scoreableWatchlist}
        flagType="buy"
        uiPrefs={uiPrefs}
        setUiPref={setUiPref}
        onScoreAll={() => handleScoreBucket("Watchlist")}
        scoring={scoringBucket === "Watchlist"}
        scoreProgress={scoringBucket === "Watchlist" ? scoreProgress : ""}
        scoreAllDisabled={scoringAny || refreshingAll}
        lastScoredAt={scoreAllWatchlistAt}
      />

      {/* Score Comparison (scoreable stocks only) */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Score Comparison</h2>
        <div className="space-y-2">
          {allScoreable.map((s) => {
            const pct = (s.adjusted / MAX_SCORE) * 100;
            const adj = Math.round((s.adjusted - s.raw) * 10) / 10;
            const label = s.ratingLabel || s.rating;
            const barColor =
              s.adjusted >= 22
                ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
                : s.adjusted >= 18
                ? "bg-gradient-to-r from-amber-300 to-amber-400"
                : "bg-gradient-to-r from-orange-400 to-red-400";

            return (
              <Link
                key={s.ticker}
                href={`/stock/${s.ticker.toLowerCase()}`}
                className="flex items-center gap-3 rounded-xl py-1.5 hover:bg-slate-50 transition-colors"
              >
                <span className="w-16 text-sm font-bold text-slate-800 text-right font-mono">{s.ticker}</span>
                <SignalPill tone={s.bucket === "Portfolio" ? "blue" : "gray"}>
                  {s.bucket === "Portfolio" ? "PF" : "WL"}
                </SignalPill>
                <div className="flex-1 h-6 rounded-full bg-slate-100 overflow-hidden relative">
                  <div
                    className={`h-full rounded-full ${barColor} flex items-center justify-end pr-2`}
                    style={{ width: `${Math.max(pct, 5)}%` }}
                  >
                    <span className="text-xs font-bold text-white">{s.adjusted}</span>
                  </div>
                </div>
                <span className={`w-6 text-xs font-semibold ${adj >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {adj >= 0 ? "+" : ""}{adj}
                </span>
                <span className={`w-24 text-xs font-medium text-right ${ratingColor(label)}`}>
                  {label}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

type RankingSortKey =
  | "ticker"
  | "raw"
  | "adjusted"
  | "rating"
  | "sector"
  | "price"
  | string;

function RankingTable({
  title,
  subtitle,
  stocks,
  flagType,
  uiPrefs,
  setUiPref,
  onScoreAll,
  scoring,
  scoreProgress,
  scoreAllDisabled,
  lastScoredAt,
}: {
  title: string;
  subtitle: string;
  stocks: ScoredStock[];
  flagType: "review" | "buy";
  uiPrefs: Record<string, string>;
  setUiPref: (key: string, value: string) => void;
  onScoreAll?: () => void;
  scoring?: boolean;
  scoreProgress?: string;
  scoreAllDisabled?: boolean;
  lastScoredAt?: string;
}) {
  // Per-row expanded state. Keyed by ticker — a single toggle on a row
  // expands *both* the "What They Do" and "Why Own It" cells together,
  // so the user only has to click once per row to see the full context.
  // Collapsed rows line-clamp to 2 lines so the default layout stays
  // compact. Either the Show more button under "What They Do" OR the
  // one under "Why Own It" flips the same state, so whichever is closer
  // to where the user is reading will do the job.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleRowExpanded = (ticker: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  };

  const prefPrefix = flagType === "review" ? "rankPort" : "rankWatch";
  const sort = {
    key: (uiPrefs[`${prefPrefix}Sort`] as RankingSortKey) || "adjusted",
    dir: (uiPrefs[`${prefPrefix}SortDir`] as SortDir) || "desc",
  };
  const setSort = (val: { key: RankingSortKey; dir: SortDir }) => {
    setUiPref(`${prefPrefix}Sort`, val.key);
    setUiPref(`${prefPrefix}SortDir`, val.dir);
  };

  const GROUP_HEADER_COLORS: Record<string, string> = {
    "Long-term": "text-blue-600",
    Research: "text-purple-600",
    Technicals: "text-teal-600",
    Fundamental: "text-emerald-600",
    "Company Specific": "text-amber-600",
    Management: "text-red-600",
  };

  function toggleSort(key: RankingSortKey) {
    if (sort.key === key) {
      setSort({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      setSort({ key, dir: "desc" });
    }
  }

  const arrow = (key: RankingSortKey) => sort.key === key ? (sort.dir === "asc" ? " \u25B2" : " \u25BC") : "";

  const sorted = [...stocks].sort((a, b) => {
    const { key, dir } = sort;
    let cmp = 0;
    if (key === "ticker") {
      cmp = a.ticker.localeCompare(b.ticker);
    } else if (key === "raw") {
      cmp = a.raw - b.raw;
    } else if (key === "adjusted") {
      cmp = a.adjusted - b.adjusted;
    } else if (key === "sector") {
      cmp = (a.sector || "").localeCompare(b.sector || "");
    } else if (key === "price") {
      cmp = (a.price ?? -Infinity) - (b.price ?? -Infinity);
    } else if (key === "rating") {
      const order = { "Sell": 0, "Underweight": 1, "Hold": 2, "Moderate Buy": 3, "Strong Buy": 4 };
      cmp = (order[(a.ratingLabel || a.rating) as keyof typeof order] ?? 2) - (order[(b.ratingLabel || b.rating) as keyof typeof order] ?? 2);
    } else {
      // Score group sort
      const group = SCORE_GROUPS.find((g) => g.name === key);
      if (group) {
        cmp = groupTotal(a, group) - groupTotal(b, group);
      }
    }
    return dir === "asc" ? cmp : -cmp;
  });

  const thClass = "pb-2 pr-3 cursor-pointer hover:text-slate-800 select-none whitespace-nowrap";
  // Sticky first column — ticker + company name stay visible while the rest of
  // the row scrolls horizontally. `left-0` pins it to the scroll container.
  // The explicit bg matches the row background (white, or the hover tint via
  // the `group` pattern on the parent <tr>) so the scrolled-under columns
  // don't bleed through. `z-10` on body cells, `z-20` on header to stay above.
  const stickyHeadCls =
    "pb-2 pr-4 cursor-pointer hover:text-slate-800 select-none whitespace-nowrap sticky left-0 z-20 bg-white";
  const stickyCellCls =
    "py-3 pr-4 sticky left-0 z-10 bg-white group-hover:bg-slate-50/80 align-top";

  const scoreableCount = stocks.filter((s) => isScoreable(s)).length;

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-lg font-bold text-slate-800">{title}</h2>
        <span className="text-sm text-slate-400">{subtitle}</span>
        {onScoreAll && (
          <div className="ml-auto flex items-center gap-2">
            {lastScoredAt && !scoring && (
              <span className="text-[11px] text-slate-400">
                Last scored {formatRelTimestamp(lastScoredAt)}
              </span>
            )}
            <button
              onClick={onScoreAll}
              disabled={scoreAllDisabled || scoreableCount === 0}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
                flagType === "review" ? "bg-blue-600 hover:bg-blue-700" : "bg-slate-600 hover:bg-slate-700"
              }`}
              title={`Score all ${title.toLowerCase()} stocks with Claude`}
            >
              {scoring ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                  {scoreProgress || "Scoring..."}
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /></svg>
                  Score All ({scoreableCount})
                </>
              )}
            </button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1400px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th className={stickyHeadCls} onClick={() => toggleSort("ticker")}>
                <span className="text-slate-400 mr-1">#</span>Ticker{arrow("ticker")}
              </th>
              <th className={thClass} onClick={() => toggleSort("sector")}>Sector{arrow("sector")}</th>
              <th className={`${thClass} text-right`} onClick={() => toggleSort("price")}>Price{arrow("price")}</th>
              <th className={`${thClass} min-w-[220px]`}>What They Do</th>
              <th className={`${thClass} min-w-[220px]`}>Why Own It</th>
              <th className={thClass} onClick={() => toggleSort("raw")}>Base{arrow("raw")}</th>
              <th className={`${thClass} font-bold`} onClick={() => toggleSort("adjusted")}>Adj{arrow("adjusted")}</th>
              {SCORE_GROUPS.map((g) => (
                <th key={g.name} className={`${thClass} ${GROUP_HEADER_COLORS[g.name] || ""}`} onClick={() => toggleSort(g.name)}>
                  {g.name === "Company Specific" ? "Company" : g.name}{arrow(g.name)}
                </th>
              ))}
              <th className={thClass} onClick={() => toggleSort("rating")}>Rating{arrow("rating")}</th>
              <th className="pb-2 pr-3">Signal</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => {
              const adj = Math.round((s.adjusted - s.raw) * 10) / 10;
              const label = s.ratingLabel || s.rating;
              const isFlagged =
                flagType === "review" ? i >= sorted.length - 3 : i < 3;

              return (
                <tr key={s.ticker} className="group border-b border-slate-50 hover:bg-slate-50/80 transition-colors [&>td]:align-top">
                  <td className={stickyCellCls}>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 text-xs w-5 text-right">{i + 1}</span>
                      <Link href={`/stock/${s.ticker.toLowerCase()}`} className="hover:underline block">
                        <div className="font-bold text-slate-800 font-mono">{s.ticker}</div>
                        <div className="text-xs text-slate-400 max-w-[160px] truncate" title={s.name}>{s.name}</div>
                      </Link>
                    </div>
                  </td>
                  <td className="py-3 pr-3 text-slate-600 text-xs whitespace-nowrap">{s.sector || "—"}</td>
                  <td className="py-3 pr-3 text-right text-slate-600 tabular-nums">
                    {s.price != null ? `$${s.price.toFixed(2)}` : "—"}
                  </td>
                  {(() => {
                    // Both "What They Do" and "Why Own It" share a single
                    // per-row expanded flag keyed on ticker — clicking Show
                    // more under either cell toggles both at once.
                    const expanded = expandedRows.has(s.ticker);
                    // Only show the toggle if at least one of the two texts
                    // is long enough to be clipped; short summaries render
                    // in full with no button clutter.
                    const anyLong =
                      (!!s.companySummary && (s.companySummary.length > 140 || s.companySummary.includes("\n"))) ||
                      (!!s.investmentThesis && (s.investmentThesis.length > 140 || s.investmentThesis.includes("\n")));
                    const renderCell = (text: string | undefined) => {
                      if (!text) return <span className="text-slate-300">—</span>;
                      return (
                        <div className="max-w-[320px] whitespace-normal leading-relaxed">
                          <div className={expanded ? "" : "line-clamp-2"}>{text}</div>
                          {anyLong && (
                            <button
                              type="button"
                              onClick={() => toggleRowExpanded(s.ticker)}
                              className="mt-1 text-[10px] font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {expanded ? "Show less" : "Show more"}
                            </button>
                          )}
                        </div>
                      );
                    };
                    return (
                      <>
                        <td className="py-3 pr-3 text-xs text-slate-600 align-top">
                          {renderCell(s.companySummary)}
                        </td>
                        <td className="py-3 pr-3 text-xs text-slate-600 align-top">
                          {renderCell(s.investmentThesis)}
                        </td>
                      </>
                    );
                  })()}
                  <td className="py-3 pr-3 text-slate-500">{s.raw}</td>
                  <td className="py-3 pr-3">
                    <span className="font-bold text-slate-900">{s.adjusted}</span>
                    <span className={`ml-0.5 text-xs ${adj >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {adj >= 0 ? "+" : ""}{adj}
                    </span>
                  </td>
                  {SCORE_GROUPS.map((g) => (
                    <td key={g.name} className="py-3 pr-3 text-slate-600">
                      {groupTotal(s, g)}/{g.maxTotal}
                    </td>
                  ))}
                  <td className={`py-3 pr-3 font-medium ${ratingColor(label)}`}>{label}</td>
                  <td className="py-3 pr-3">
                    {isFlagged && flagType === "buy" && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                        BUY CANDIDATE
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
