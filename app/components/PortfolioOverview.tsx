"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoredStock, ScoreKey, HealthData, FundHolding, FundSectorWeight } from "@/app/lib/types";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { groupTotal, isScoreable, normalizeSector, computeScores } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";

/** Check if a stock has a non-empty explanation for a given category key.
 *  Handles both legacy string[] and new ScoreCategoryExplanation shapes. */
function hasExplanation(s: { explanations?: Record<string, unknown> }, key: string): boolean {
  const val = s.explanations?.[key];
  if (!val) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "object" && (val as { summary?: string }).summary) return true;
  return false;
}

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
    flushStocks,
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
  const [scoreFailures, setScoreFailures] = useState<string[]>([]);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState("");
  const scoringAny = scoringBucket != null;

  // Timestamps persist across reloads via the same uiPrefs → Redis KV bridge
  // the rest of this screen already uses. Keys: scoreAll<Bucket>At, refreshAllAt.
  const scoreAllPortfolioAt = uiPrefs["scoreAllPortfolioAt"] || "";
  const scoreAllWatchlistAt = uiPrefs["scoreAllWatchlistAt"] || "";
  const refreshAllAt = uiPrefs["refreshAllAt"] || "";

  /** Sequentially score every scoreable stock in a bucket, updating a progress
   *  banner and finally stamping the "Score All" timestamp on success.
   *
   *  Tracks failures so the user sees exactly which tickers errored out.
   *  After scoring, auto-backfills companySummary + investmentThesis for any
   *  stock that's still missing them (cheap ~$0.002/stock call). */
  const handleScoreBucket = useCallback(async (bucket: "Portfolio" | "Watchlist") => {
    if (scoringAny || refreshingAll) return;
    const source = bucket === "Portfolio" ? portfolioStocks : watchlistStocks;
    const bucketStocks = source.filter((s) => isScoreable(s));
    if (bucketStocks.length === 0) return;
    setScoringBucket(bucket);
    setScoreFailures([]);
    const failed: string[] = [];

    // Track what the score API returned per ticker during the loop so the
    // backfill/gap-fill passes don't rely on stale closure state.
    const scoreResults = new Map<string, { truncated?: boolean; missingCategories?: string[]; companySummary?: string; investmentThesis?: string }>();

    for (let i = 0; i < bucketStocks.length; i++) {
      const s = bucketStocks[i];
      setScoreProgress(`Scoring ${s.ticker} (${i + 1}/${bucketStocks.length})`);
      try {
        // Inline the score call so we can capture the raw API response metadata
        const res = await fetch("/api/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker: s.ticker,
            verifyWithWebSearch: true,
            externalSourceNotes: s.externalSourceNotes ?? [],
            researchCoverageNotes: s.researchCoverageNotes ?? [],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Failed to score ${s.ticker}`);
        }
        const data = await res.json();

        // Apply results via the existing context mutators
        if (data.scores) {
          for (const [key, val] of Object.entries(data.scores)) {
            updateScore(s.ticker, key as ScoreKey, val as number);
          }
        }
        if (data.explanations) updateExplanations(s.ticker, data.explanations);
        if (data.price != null) updatePrice(s.ticker, data.price);
        if (data.healthData) updateHealthData(s.ticker, data.healthData);
        if (data.technicals && data.riskAlert) {
          updateTechnicals(s.ticker, data.technicals, data.riskAlert);
        }
        if (data.companySummary || data.investmentThesis || data.sector || data.name) {
          updateStockFields(s.ticker, {
            ...(data.companySummary ? { companySummary: data.companySummary } : {}),
            ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
            ...(data.sector ? { sector: data.sector } : {}),
            ...(data.name && data.name !== "Unknown" ? { name: data.name } : {}),
          });
        }
        updateLastScored(
          s.ticker,
          new Date().toLocaleString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true,
          })
        );

        // Record API response metadata for backfill/gap-fill decisions
        scoreResults.set(s.ticker, {
          truncated: data.truncated,
          missingCategories: data.missingCategories,
          companySummary: data.companySummary,
          investmentThesis: data.investmentThesis,
        });
      } catch (err) {
        console.error(`[Score All] Failed to score ${s.ticker}:`, err);
        failed.push(s.ticker);
      }
    }

    // Auto-backfill companySummary + investmentThesis for stocks the API
    // flagged as truncated or that didn't return these fields. Uses the
    // scoreResults map (not stale closure state) to decide.
    const needBackfill = bucketStocks.filter((s) => {
      if (failed.includes(s.ticker)) return false;
      const result = scoreResults.get(s.ticker);
      return !result?.companySummary || !result?.investmentThesis;
    });
    if (needBackfill.length > 0) {
      setScoreProgress(`Backfilling summaries (${needBackfill.length} stocks)...`);
      for (const s of needBackfill) {
        try {
          const res = await fetch("/api/backfill-summaries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker: s.ticker, name: s.name, sector: s.sector,
              scores: s.scores, explanations: s.explanations,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.companySummary || data.investmentThesis) {
              updateStockFields(s.ticker, {
                ...(data.companySummary ? { companySummary: data.companySummary } : {}),
                ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
              });
            }
          }
        } catch { /* non-fatal */ }
      }
    }

    // Auto-fill category gaps using the API's missingCategories metadata.
    const gapStocks = bucketStocks.filter((s) => {
      if (failed.includes(s.ticker)) return false;
      const result = scoreResults.get(s.ticker);
      return result?.missingCategories && result.missingCategories.length > 0;
    });
    if (gapStocks.length > 0) {
      setScoreProgress(`Filling ${gapStocks.length} stocks with missing categories...`);
      for (const s of gapStocks) {
        const missingKeys = scoreResults.get(s.ticker)?.missingCategories ?? [];
        if (missingKeys.length === 0) continue;
        try {
          const res = await fetch("/api/score-gaps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker: s.ticker, missingKeys,
              name: s.name, sector: s.sector, existingExplanations: s.explanations,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.scores) {
              for (const [key, val] of Object.entries(data.scores)) {
                if (typeof val === "number") {
                  updateScore(s.ticker, key as ScoreKey, val as number);
                }
              }
            }
            if (data.explanations) {
              updateExplanations(s.ticker, { ...s.explanations, ...data.explanations });
            }
          }
        } catch { /* non-fatal */ }
      }
    }

    if (failed.length > 0) {
      setScoreFailures(failed);
      setScoreProgress(`Done — ${failed.length} failed: ${failed.join(", ")}`);
    } else {
      setScoreProgress("");
    }
    setScoringBucket(null);
    setUiPref(
      bucket === "Portfolio" ? "scoreAllPortfolioAt" : "scoreAllWatchlistAt",
      new Date().toISOString()
    );
    // Guarantee all state changes are persisted to Redis before we're done
    await flushStocks();
  }, [scoringAny, refreshingAll, portfolioStocks, watchlistStocks, setUiPref, updateStockFields, updateScore, updateExplanations, updatePrice, updateHealthData, updateTechnicals, updateLastScored, flushStocks]);

  // Backfill state — separate from Score All so it can run independently.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState("");

  /** Cheap backfill: generate only companySummary + investmentThesis for
   *  stocks that already have scores but are missing these text fields.
   *  ~$0.002/stock vs ~$0.18 for a full rescore. */
  const handleBackfillSummaries = useCallback(async (bucket: "Portfolio" | "Watchlist") => {
    if (backfilling || scoringAny || refreshingAll) return;
    const source = bucket === "Portfolio" ? portfolioStocks : watchlistStocks;
    const needBackfill = source.filter(
      (s) => isScoreable(s) && (!s.companySummary || !s.investmentThesis)
    );
    if (needBackfill.length === 0) return;
    setBackfilling(true);
    let done = 0;
    for (const s of needBackfill) {
      setBackfillProgress(`Generating summaries ${++done}/${needBackfill.length} (${s.ticker})...`);
      try {
        const res = await fetch("/api/backfill-summaries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker: s.ticker,
            name: s.name,
            sector: s.sector,
            scores: s.scores,
            explanations: s.explanations,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.companySummary || data.investmentThesis) {
            updateStockFields(s.ticker, {
              ...(data.companySummary ? { companySummary: data.companySummary } : {}),
              ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
            });
          }
        }
      } catch {
        // Non-fatal
      }
    }
    setBackfillProgress("");
    setBackfilling(false);
    await flushStocks();
  }, [backfilling, scoringAny, refreshingAll, portfolioStocks, watchlistStocks, updateStockFields, flushStocks]);

  // AI/SEMI category keys that should always have explanations after scoring
  const AI_SEMI_KEYS = useMemo(() =>
    SCORE_GROUPS.flatMap((g) =>
      g.categories
        .filter((c) => c.inputType === "auto" || c.inputType === "semi")
        .map((c) => c.key)
    ), []);

  // Fill-gaps state
  const [fillingGaps, setFillingGaps] = useState(false);
  const [fillGapsProgress, setFillGapsProgress] = useState("");

  /** Targeted fill: score ONLY the categories missing explanations.
   *  ~$0.01/stock — no web search, minimal context. */
  const handleFillGaps = useCallback(async (bucket: "Portfolio" | "Watchlist") => {
    if (fillingGaps || scoringAny || refreshingAll) return;
    const source = bucket === "Portfolio" ? portfolioStocks : watchlistStocks;
    // Find stocks that have been scored (raw > 0) but have missing AI/SEMI explanations
    const stocksWithGaps = source.filter((s) => {
      if (!isScoreable(s) || s.raw <= 0) return false;
      return AI_SEMI_KEYS.some((k) => !hasExplanation(s, k));
    });
    if (stocksWithGaps.length === 0) return;
    setFillingGaps(true);
    let done = 0;
    for (const s of stocksWithGaps) {
      const missingKeys = AI_SEMI_KEYS.filter((k) => !hasExplanation(s, k));
      setFillGapsProgress(`Filling ${s.ticker} (${++done}/${stocksWithGaps.length}) — ${missingKeys.length} categories`);
      try {
        const res = await fetch("/api/score-gaps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker: s.ticker,
            missingKeys,
            name: s.name,
            sector: s.sector,
            existingExplanations: s.explanations,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          // Update scores for the missing categories
          if (data.scores) {
            for (const [key, val] of Object.entries(data.scores)) {
              // Only update if the current score is 0 (was missing/defaulted)
              if ((s.scores[key as ScoreKey] ?? 0) === 0 && typeof val === "number") {
                updateScore(s.ticker, key as ScoreKey, val as number);
              }
            }
          }
          // Merge new explanations with existing ones
          if (data.explanations) {
            const merged = { ...s.explanations, ...data.explanations };
            updateExplanations(s.ticker, merged);
          }
        }
      } catch {
        // Non-fatal — best effort
      }
    }
    setFillGapsProgress("");
    setFillingGaps(false);
    await flushStocks();
  }, [fillingGaps, scoringAny, refreshingAll, portfolioStocks, watchlistStocks, AI_SEMI_KEYS, updateScore, updateExplanations, flushStocks]);

  /** Reset the "charting" manual score to 0 for every scoreable stock in
   *  the given bucket. Useful when chart signals have rotated and the PM
   *  wants a clean slate before re-evaluating. */
  const handleClearCharting = useCallback(async (bucket: "Portfolio" | "Watchlist") => {
    const source = bucket === "Portfolio" ? portfolioStocks : watchlistStocks;
    const targets = source.filter((s) => isScoreable(s) && (s.scores?.charting ?? 0) > 0);
    if (targets.length === 0) return;
    for (const s of targets) {
      updateScore(s.ticker, "charting", 0);
    }
    await flushStocks();
  }, [portfolioStocks, watchlistStocks, updateScore, flushStocks]);

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
      await flushStocks();
    }
  }, [refreshingAll, scoringAny, portfolioStocks, watchlistStocks, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateFundData, updateMarketData, setUiPref, flushStocks]);

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

      {/* Portfolio Rankings (scoreable stocks only) */}
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
        scoreFailures={scoringBucket !== "Watchlist" ? scoreFailures : []}
        onDismissFailures={() => { setScoreFailures([]); setScoreProgress(""); }}
        scoreAllDisabled={scoringAny || refreshingAll}
        lastScoredAt={scoreAllPortfolioAt}
        collapseKey="dashboard.portfolioRankings.collapsed"
        onBackfillSummaries={() => handleBackfillSummaries("Portfolio")}
        backfilling={backfilling}
        backfillProgress={backfillProgress}
        onFillGaps={() => handleFillGaps("Portfolio")}
        fillingGaps={fillingGaps}
        fillGapsProgress={fillGapsProgress}
        aiSemiKeys={AI_SEMI_KEYS}
        onClearCharting={() => handleClearCharting("Portfolio")}
      />


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
        scoreFailures={scoringBucket !== "Portfolio" ? scoreFailures : []}
        onDismissFailures={() => { setScoreFailures([]); setScoreProgress(""); }}
        scoreAllDisabled={scoringAny || refreshingAll}
        lastScoredAt={scoreAllWatchlistAt}
        collapseKey="dashboard.watchlistRankings.collapsed"
        onBackfillSummaries={() => handleBackfillSummaries("Watchlist")}
        backfilling={backfilling}
        backfillProgress={backfillProgress}
        onFillGaps={() => handleFillGaps("Watchlist")}
        fillingGaps={fillingGaps}
        fillGapsProgress={fillGapsProgress}
        aiSemiKeys={AI_SEMI_KEYS}
        onClearCharting={() => handleClearCharting("Watchlist")}
      />

      {/* Fund & ETF Holdings — moved below Watchlist Rankings per Dashboard
          layout request. Collapsible via uiPrefs (cross-device via Redis). */}
      {fundPortfolio.length > 0 && (() => {
        const fundCollapsed = uiPrefs["dashboard.fundEtfHoldings.collapsed"] === "1";
        const toggleFundCollapsed = () => setUiPref("dashboard.fundEtfHoldings.collapsed", fundCollapsed ? "0" : "1");

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
            <div className={`flex items-center gap-3 ${fundCollapsed ? "" : "mb-4"}`}>
              <button
                onClick={toggleFundCollapsed}
                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                aria-expanded={!fundCollapsed}
                aria-label={fundCollapsed ? "Expand Fund & ETF Holdings" : "Collapse Fund & ETF Holdings"}
              >
                <svg className={`w-4 h-4 text-slate-400 transition-transform ${fundCollapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h2 className="text-lg font-bold text-slate-800">Fund & ETF Holdings</h2>
              </button>
              <span className="text-sm text-slate-400">{fundPortfolio.length} holdings</span>
            </div>
            {!fundCollapsed && (
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
                              {displayTicker(s.ticker)}
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
            )}
          </section>
        );
      })()}
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
  scoreFailures,
  onDismissFailures,
  scoreAllDisabled,
  lastScoredAt,
  collapseKey,
  onBackfillSummaries,
  backfilling,
  backfillProgress,
  onFillGaps,
  fillingGaps,
  fillGapsProgress,
  aiSemiKeys,
  onClearCharting,
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
  scoreFailures?: string[];
  onDismissFailures?: () => void;
  scoreAllDisabled?: boolean;
  lastScoredAt?: string;
  /** When set, this section is collapsible and its collapsed state is
   *  persisted under this uiPrefs key (cross-device via Redis). */
  collapseKey?: string;
  onBackfillSummaries?: () => void;
  backfilling?: boolean;
  backfillProgress?: string;
  onFillGaps?: () => void;
  fillingGaps?: boolean;
  fillGapsProgress?: string;
  aiSemiKeys?: string[];
  onClearCharting?: () => void;
}) {
  // Collapse state — defaults to expanded. Persisted in uiPrefs so it
  // sticks across refreshes and syncs to other devices via Redis. The
  // Score All button stays visible even when collapsed so the user can
  // trigger a batch rescore without expanding the table first.
  const collapsed = collapseKey ? uiPrefs[collapseKey] === "1" : false;
  const toggleCollapsed = () => {
    if (!collapseKey) return;
    setUiPref(collapseKey, collapsed ? "0" : "1");
  };
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
  const chartingNonZeroCount = stocks.filter((s) => isScoreable(s) && (s.scores?.charting ?? 0) > 0).length;

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className={`flex items-center gap-3 flex-wrap ${collapsed ? "" : "mb-4"}`}>
        {collapseKey ? (
          <button
            onClick={toggleCollapsed}
            className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          >
            <svg
              className={`w-4 h-4 text-slate-400 transition-transform ${collapsed ? "-rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          </button>
        ) : (
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
        )}
        <span className="text-sm text-slate-400">{subtitle}</span>
        {onScoreAll && (
          <div className="ml-auto flex items-center gap-2">
            {lastScoredAt && !scoring && (
              <span className="text-[11px] text-slate-400">
                Last scored {formatRelTimestamp(lastScoredAt)}
              </span>
            )}
            {onClearCharting && chartingNonZeroCount > 0 && (
              <button
                onClick={onClearCharting}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 border border-slate-200 transition-colors"
                title={`Reset charting score to 0 for ${chartingNonZeroCount} stock${chartingNonZeroCount > 1 ? "s" : ""}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                Clear Charting ({chartingNonZeroCount})
              </button>
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
      {/* Score All failure banner — persists until dismissed */}
      {!scoring && scoreFailures && scoreFailures.length > 0 && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
          <span className="font-medium">{scoreFailures.length} stock{scoreFailures.length > 1 ? "s" : ""} failed to score: {scoreFailures.join(", ")}</span>
          <span className="text-red-500">— try scoring individually from the stock page</span>
          {onDismissFailures && (
            <button onClick={onDismissFailures} className="ml-auto text-red-400 hover:text-red-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>
      )}
      {/* Backfill summaries banner — shown when stocks have scores but missing What They Do / Why Own It */}
      {(() => {
        const missingSummaries = stocks.filter(
          (s) => isScoreable(s) && s.raw > 0 && (!s.companySummary || !s.investmentThesis)
        );
        if (missingSummaries.length === 0 && !backfilling) return null;
        return (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
            {backfilling ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                <span>{backfillProgress || "Generating summaries..."}</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" /></svg>
                <span>{missingSummaries.length} stock{missingSummaries.length > 1 ? "s" : ""} missing &quot;What They Do&quot; / &quot;Why Own It&quot;</span>
                {onBackfillSummaries && (
                  <button
                    onClick={onBackfillSummaries}
                    disabled={scoreAllDisabled}
                    className="ml-1 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    Fill ({missingSummaries.length}) — ~$0.01
                  </button>
                )}
              </>
            )}
          </div>
        );
      })()}
      {/* Fill unscored categories banner — shown when stocks have been scored but some AI/SEMI categories lack explanations */}
      {(() => {
        if (!aiSemiKeys || aiSemiKeys.length === 0) return null;
        const stocksWithGaps = stocks.filter((s) => {
          if (!isScoreable(s) || s.raw <= 0) return false;
          return aiSemiKeys.some((k) => !hasExplanation(s, k));
        });
        const totalGaps = stocksWithGaps.reduce(
          (sum, s) => sum + aiSemiKeys.filter((k) => !hasExplanation(s, k)).length, 0
        );
        if (stocksWithGaps.length === 0 && !fillingGaps) return null;
        return (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-700">
            {fillingGaps ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                <span>{fillGapsProgress || "Filling unscored categories..."}</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /></svg>
                <span>{totalGaps} unscored categor{totalGaps === 1 ? "y" : "ies"} across {stocksWithGaps.length} stock{stocksWithGaps.length > 1 ? "s" : ""}</span>
                {onFillGaps && (
                  <button
                    onClick={onFillGaps}
                    disabled={scoreAllDisabled}
                    className="ml-1 rounded bg-violet-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    Fill gaps ({stocksWithGaps.length} stocks) — ~${(stocksWithGaps.length * 0.01).toFixed(2)}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })()}
      {!collapsed && (
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
                        <div className="font-bold text-slate-800 font-mono">{displayTicker(s.ticker)}</div>
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
                  <td className="py-3 pr-3 text-slate-500">{Number(s.raw.toFixed(1))}</td>
                  <td className="py-3 pr-3">
                    <span className="font-bold text-slate-900">{Number(s.adjusted.toFixed(1))}</span>
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
      )}
    </section>
  );
}
