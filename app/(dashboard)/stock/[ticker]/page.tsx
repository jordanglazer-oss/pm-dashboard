"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoreKey, FundData } from "@/app/lib/types";
import { groupTotal, isScoreable, normalizeSector } from "@/app/lib/scoring";
import { SignalPill, ratingTone } from "@/app/components/SignalPill";
import StockHealthMonitor from "@/app/components/StockHealthMonitor";
import RiskAlertPanel from "@/app/components/RiskAlertPanel";
import RatioVsSpxSparkline from "@/app/components/RatioVsSpxSparkline";
import StockChart from "@/app/components/StockChart";

// ── Helpers ──
function formatAUM(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toLocaleString()}`;
}

function formatReturn(value: number | undefined): string {
  if (value == null) return "--";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function returnColor(value: number | undefined): string {
  if (value == null) return "text-slate-400";
  return value >= 0 ? "text-emerald-600" : "text-red-500";
}

// ── Color mapping ──
const GROUP_COLORS: Record<
  string,
  { bar: string; text: string; scoreText: string; activeBg: string; activeText: string; ring: string; barBg: string }
> = {
  blue:   { bar: "bg-blue-500",    text: "text-blue-600",    scoreText: "text-blue-600",    activeBg: "bg-blue-500",    activeText: "text-white", ring: "#3b82f6", barBg: "bg-blue-100" },
  purple: { bar: "bg-purple-500",  text: "text-purple-600",  scoreText: "text-purple-600",  activeBg: "bg-purple-500",  activeText: "text-white", ring: "#a855f7", barBg: "bg-purple-100" },
  teal:   { bar: "bg-teal-500",    text: "text-teal-600",    scoreText: "text-teal-600",    activeBg: "bg-teal-500",    activeText: "text-white", ring: "#14b8a6", barBg: "bg-teal-100" },
  green:  { bar: "bg-emerald-500", text: "text-emerald-600", scoreText: "text-emerald-600", activeBg: "bg-emerald-500", activeText: "text-white", ring: "#10b981", barBg: "bg-emerald-100" },
  amber:  { bar: "bg-amber-500",   text: "text-amber-600",   scoreText: "text-amber-600",   activeBg: "bg-amber-500",   activeText: "text-white", ring: "#f59e0b", barBg: "bg-amber-100" },
  red:    { bar: "bg-red-500",     text: "text-red-600",     scoreText: "text-red-600",     activeBg: "bg-red-500",     activeText: "text-white", ring: "#ef4444", barBg: "bg-red-100" },
};


// Per-model weight input with local string state (supports backspace/clearing)
function ModelWeightInput({ groupId, modelWeight, isOverride, onCommit }: {
  groupId: string;
  modelWeight: number;
  isOverride: boolean;
  onCommit: (val: number) => void;
}) {
  const [text, setText] = useState(String(modelWeight));
  const [focused, setFocused] = useState(false);
  // No sync-from-parent effect: when not focused the <input> displays
  // `String(modelWeight)` directly via the value prop below, and on
  // focus we reset `text` from the latest parent value. So keeping
  // `text` in sync with `modelWeight` between focus events is
  // unnecessary (and triggered a cascading-render lint error).

  const commit = (raw: string) => {
    const val = parseFloat(raw);
    if (!isNaN(val) && val >= 0) {
      onCommit(val);
    } else {
      setText(String(modelWeight));
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2">
      <input
        type="text"
        inputMode="decimal"
        value={focused ? text : String(modelWeight)}
        onFocus={() => { setFocused(true); setText(String(modelWeight)); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => { commit(e.target.value); setFocused(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(text); (e.target as HTMLInputElement).blur(); } }}
        className="w-16 rounded-md border border-emerald-200 bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-emerald-400"
      />
      <span className="text-xs text-emerald-500">%</span>
      {isOverride && (
        <span className="text-[10px] text-amber-500 ml-1" title="Overrides default weight">override</span>
      )}
    </div>
  );
}

// Donut chart SVG
function ScoreDonut({ score, max, groups, stock }: { score: number; max: number; groups: typeof SCORE_GROUPS; stock: { scores: Record<string, number> } }) {
  const radius = 80;
  const strokeWidth = 16;
  const circumference = 2 * Math.PI * radius;
  const center = 100;
  const gap = 4; // degrees gap between segments

  // Precompute each segment's start-angle (`rotation`) up-front so we
  // don't mutate a running accumulator inside the .map() below — that
  // tripped the react-hooks/immutability lint rule. Start at -90° so
  // the first segment begins at 12 o'clock.
  const segments = groups.map((g) => {
    const value = groupTotal(stock as never, g);
    return {
      color: GROUP_COLORS[g.color]?.ring || "#94a3b8",
      value,
      maxVal: g.maxTotal,
      segDeg: (value / max) * 360,
    };
  });
  const rotations: number[] = [];
  {
    let acc = -90;
    for (const s of segments) {
      rotations.push(acc);
      acc += s.segDeg;
    }
  }

  // Rating label
  let ratingLabel = "Hold";
  if (score >= 30) ratingLabel = "Strong Buy";
  else if (score >= 26) ratingLabel = "Moderate Buy";
  else if (score >= 22) ratingLabel = "Hold";
  else if (score >= 18) ratingLabel = "Underweight";
  else ratingLabel = "Sell";

  const ratingColor = score >= 26 ? "#10b981" : score >= 22 ? "#f59e0b" : score >= 18 ? "#f97316" : "#ef4444";

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 200" className="w-40 h-40">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
        {segments.map((seg, i) => {
          const segPct = seg.value / max;
          const segLen = segPct * circumference;
          const gapLen = (gap / 360) * circumference;
          const dashArray = `${Math.max(segLen - gapLen, 0)} ${circumference - Math.max(segLen - gapLen, 0)}`;
          const rotation = rotations[i];
          if (seg.value === 0) return null;
          return (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={0}
              strokeLinecap="round"
              transform={`rotate(${rotation} ${center} ${center})`}
              className="transition-all duration-500"
            />
          );
        })}
        <text x={center} y={center - 4} textAnchor="middle" style={{ fontSize: "32px", fontWeight: 700 }} className="fill-slate-900">
          {score}
        </text>
        <text x={center} y={center + 16} textAnchor="middle" style={{ fontSize: "13px" }} className="fill-slate-400">
          / {max}
        </text>
      </svg>
      <span className="mt-1 text-sm font-bold" style={{ color: ratingColor }}>{ratingLabel}</span>
    </div>
  );
}

// ── Fund Data Panels ──

/**
 * Expand fund-of-funds holdings so ETF/MF positions are replaced by
 * their underlying equity (or bond) constituents, weighted by the
 * parent's weight in this fund.
 *
 * Example: XSP.TO → IVV at 98.6%. If IVV's topHoldings include AAPL at
 * 7.5%, the look-through view shows AAPL at 98.6% × 7.5% = 7.4%.
 *
 * - Only expands when the child fund's `topHoldings` are already
 *   cached on our stock list — we don't trigger network fetches during
 *   render.
 * - Combines direct + via-fund exposure to the same symbol (e.g. if
 *   the parent holds AAPL directly AND via IVV).
 * - Recurses up to `maxDepth` levels deep to handle ETF-of-ETF-of-ETF.
 * - Falls back to the original holding if no underlying data is
 *   available (so the view degrades gracefully).
 *
 * `lookedThrough` accumulates the set of symbols that were expanded so
 * the UI can tell the user which funds it looked through.
 */
type LookThroughLookup = (symbol: string) => FundData["topHoldings"] | undefined;

function expandLookThrough(
  holdings: NonNullable<FundData["topHoldings"]>,
  lookup: LookThroughLookup,
  lookedThrough: Set<string>,
  maxDepth = 3,
  depth = 0,
): NonNullable<FundData["topHoldings"]> {
  const acc = new Map<string, { symbol: string; name: string; weight: number }>();

  const add = (sym: string, name: string, weight: number) => {
    const key = (sym || name).toUpperCase();
    if (!key) return;
    const prev = acc.get(key);
    if (prev) {
      prev.weight += weight;
    } else {
      acc.set(key, { symbol: sym, name, weight });
    }
  };

  for (const h of holdings) {
    const sym = (h.symbol || "").toUpperCase();
    const childHoldings = sym && depth < maxDepth ? lookup(sym) : undefined;

    if (childHoldings && childHoldings.length > 0) {
      // Recurse so an ETF-of-ETFs also gets expanded.
      const expandedChildren = depth + 1 < maxDepth
        ? expandLookThrough(childHoldings, lookup, lookedThrough, maxDepth, depth + 1)
        : childHoldings;
      lookedThrough.add(sym);
      // Scale each child by the parent weight as a fraction.
      // (Child weights already sum ≤ 100 in percent terms.)
      const scale = h.weight / 100;
      for (const c of expandedChildren) {
        add(c.symbol || "", c.name, c.weight * scale);
      }
    } else {
      add(sym, h.name, h.weight);
    }
  }

  return Array.from(acc.values())
    .sort((a, b) => b.weight - a.weight)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      weight: parseFloat(r.weight.toFixed(2)),
    }));
}

function FundDataPanels({ fundData, ticker, onHoldingsUpdate }: { fundData: FundData; ticker: string; onHoldingsUpdate?: (holdings: FundData["topHoldings"], sectors: FundData["sectorWeightings"], url: string) => void }) {
  const { scoredStocks } = useStocks();
  const [holdingsUrl, setHoldingsUrl] = useState(fundData.holdingsUrl || "");
  const [scrapingHoldings, setScrapingHoldings] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState(false);
  const [lookThroughEnabled, setLookThroughEnabled] = useState(true);
  // Cache for holdings fetched on-the-fly for look-through expansion.
  // Seeded on mount from the shared pm:fund-data-cache (populated by
  // Refresh All crawling heavy sub-funds), then augmented with any
  // on-the-fly fetches done here. We also PATCH back into the shared
  // cache when an on-the-fly fetch succeeds, so visiting one fund's
  // page can populate look-through data for others without having to
  // pollute the main stock list KV with arbitrary ETF constituents.
  const [extraCache, setExtraCache] = useState<Record<string, FundData["topHoldings"]>>({});

  // Mount-time: pull the shared fund-data-cache and seed extraCache so
  // look-through works immediately without waiting for the on-the-fly
  // 20%-weight auto-fetch below.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/kv/fund-data-cache")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const entries = data?.entries as Record<string, { topHoldings?: FundData["topHoldings"] }> | undefined;
        if (!entries) return;
        const seed: Record<string, FundData["topHoldings"]> = {};
        for (const [sym, entry] of Object.entries(entries)) {
          if (entry?.topHoldings?.length) seed[sym.toUpperCase()] = entry.topHoldings;
        }
        if (Object.keys(seed).length) {
          setExtraCache((prev) => ({ ...seed, ...prev }));
        }
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, []);

  // Build a symbol → cached topHoldings lookup. Combines stocks the
  // user has already visited (persisted) with the on-the-fly cache we
  // populate below. Excludes the current ticker to avoid self-recursion.
  const lookup = React.useMemo<LookThroughLookup>(() => {
    const map = new Map<string, FundData["topHoldings"]>();
    for (const s of scoredStocks) {
      if (s.ticker.toUpperCase() === ticker.toUpperCase()) continue;
      if (s.fundData?.topHoldings?.length) {
        map.set(s.ticker.toUpperCase(), s.fundData.topHoldings);
      }
    }
    for (const [sym, h] of Object.entries(extraCache)) {
      if (sym.toUpperCase() === ticker.toUpperCase()) continue;
      if (h?.length && !map.has(sym.toUpperCase())) {
        map.set(sym.toUpperCase(), h);
      }
    }
    return (sym: string) => map.get(sym.toUpperCase());
  }, [scoredStocks, ticker, extraCache]);

  // Auto-fetch underlying holdings for any heavily-weighted (≥20%)
  // constituent that we don't already have cached. A 20%+ weight is
  // almost always a sub-fund (e.g. XSP.TO → IVV at 98.6%), not an
  // individual stock, so this doesn't fire fetches for normal stock
  // holdings in diversified ETFs.
  useEffect(() => {
    if (!lookThroughEnabled) return;
    const hs = fundData.topHoldings;
    if (!hs?.length) return;
    const already = new Set<string>(scoredStocks
      .filter((s) => s.fundData?.topHoldings?.length)
      .map((s) => s.ticker.toUpperCase()));
    Object.keys(extraCache).forEach((k) => already.add(k.toUpperCase()));
    already.add(ticker.toUpperCase());

    for (const h of hs) {
      if (!h.symbol || h.weight < 20) continue;
      const sym = h.symbol.toUpperCase();
      if (already.has(sym)) continue;
      already.add(sym); // prevent duplicate fires while fetch is in flight
      fetch(`/api/fund-data?ticker=${encodeURIComponent(sym)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const fd = data?.fundData as FundData | undefined;
          const holdings = fd?.topHoldings;
          if (holdings?.length) {
            setExtraCache((prev) => ({ ...prev, [sym]: holdings }));
            // Write through to the shared KV cache so other pages /
            // the Client Report X-ray pick this up without having to
            // re-fetch. Best-effort — failure here doesn't break
            // anything user-visible.
            fetch("/api/kv/fund-data-cache", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                entries: {
                  [sym]: {
                    topHoldings: holdings,
                    sectorWeightings: fd?.sectorWeightings,
                    holdingsSource: fd?.holdingsSource,
                    fundFamily: fd?.fundFamily,
                    lastUpdated: new Date().toISOString(),
                  },
                },
              }),
            }).catch(() => { /* best effort */ });
          }
        })
        .catch(() => { /* best effort */ });
    }
  }, [lookThroughEnabled, fundData.topHoldings, scoredStocks, extraCache, ticker]);

  // Apply look-through (when enabled). `lookedThroughSymbols` reflects
  // which fund tickers were actually expanded, for the UI hint.
  const { displayedHoldings, lookedThroughSymbols } = React.useMemo(() => {
    const symbols = new Set<string>();
    if (!fundData.topHoldings?.length) {
      return { displayedHoldings: [] as NonNullable<FundData["topHoldings"]>, lookedThroughSymbols: symbols };
    }
    if (!lookThroughEnabled) {
      return { displayedHoldings: fundData.topHoldings, lookedThroughSymbols: symbols };
    }
    const expanded = expandLookThrough(fundData.topHoldings, lookup, symbols);
    return { displayedHoldings: expanded.slice(0, 10), lookedThroughSymbols: symbols };
  }, [fundData.topHoldings, lookThroughEnabled, lookup]);

  const handleScrapeHoldings = async () => {
    if (!holdingsUrl.trim()) return;
    setScrapingHoldings(true);
    setScrapeError("");
    setScrapeSuccess(false);
    try {
      const res = await fetch("/api/fund-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: holdingsUrl.trim(), ticker }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScrapeError(data.error || "Failed to scrape holdings");
        return;
      }
      if (data.topHoldings?.length) {
        onHoldingsUpdate?.(data.topHoldings, data.sectorWeightings, holdingsUrl.trim());
        setScrapeSuccess(true);
        setTimeout(() => setScrapeSuccess(false), 3000);
      }
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setScrapingHoldings(false);
    }
  };
  const sectorColors: Record<string, string> = {
    Technology: "bg-blue-500",
    Financials: "bg-teal-500",
    "Health Care": "bg-purple-500",
    "Consumer Discretionary": "bg-orange-500",
    "Consumer Staples": "bg-amber-500",
    "Communication Services": "bg-indigo-500",
    Industrials: "bg-slate-500",
    Energy: "bg-red-500",
    Utilities: "bg-lime-500",
    Materials: "bg-cyan-500",
    "Real Estate": "bg-pink-500",
  };

  return (
    <div className="space-y-4 mt-6">
      {/* Row 1: Performance + Risk */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Performance */}
        {fundData.performance && (
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-800 mb-4">Performance</h2>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: "1M", val: fundData.performance.oneMonth },
                { label: "3M", val: fundData.performance.threeMonth },
                { label: "YTD", val: fundData.performance.ytd },
                { label: "1Y", val: fundData.performance.oneYear },
                { label: "3Y", val: fundData.performance.threeYear },
                { label: "5Y", val: fundData.performance.fiveYear },
                { label: "10Y", val: fundData.performance.tenYear },
              ]
                .filter((r) => r.val != null)
                .map((r) => (
                  <div key={r.label} className="rounded-xl bg-slate-50 p-2.5">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase">{r.label}</div>
                    <div className={`mt-1 text-sm font-bold ${returnColor(r.val)}`}>
                      {formatReturn(r.val)}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Risk & Key Stats */}
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-800 mb-4">Key Statistics</h2>
          <div className="grid grid-cols-2 gap-3">
            {fundData.fundFamily && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Fund Family</div>
                <div className="mt-1 text-sm font-semibold text-slate-700 truncate">{fundData.fundFamily}</div>
              </div>
            )}
            {fundData.inceptionDate && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Inception</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.inceptionDate}</div>
              </div>
            )}
            {fundData.turnover != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Turnover</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.turnover.toFixed(0)}%</div>
              </div>
            )}
            {fundData.riskStats?.beta != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Beta (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.beta.toFixed(2)}</div>
              </div>
            )}
            {fundData.riskStats?.sharpeRatio != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Sharpe (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.sharpeRatio.toFixed(2)}</div>
              </div>
            )}
            {fundData.riskStats?.stdDev != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Std Dev (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.stdDev.toFixed(2)}%</div>
              </div>
            )}
            {fundData.riskStats?.alpha != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Alpha (3Y)</div>
                <div className={`mt-1 text-sm font-semibold ${fundData.riskStats.alpha >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {fundData.riskStats.alpha >= 0 ? "+" : ""}{fundData.riskStats.alpha.toFixed(2)}
                </div>
              </div>
            )}
            {fundData.riskStats?.rSquared != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">R-Squared</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.rSquared.toFixed(2)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Top Holdings + Sector Breakdown */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Top Holdings */}
        <div className="rounded-[24px] border border-slate-200 bg-white p-4 sm:p-5 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-base font-bold text-slate-800">Top Holdings</h2>
            {fundData.topHoldings && fundData.topHoldings.length > 0 && (
              <div className="flex items-center gap-1 rounded-full bg-slate-100 p-0.5 text-[10px] font-semibold">
                <button
                  onClick={() => setLookThroughEnabled(true)}
                  className={`px-2 py-0.5 rounded-full transition-colors ${lookThroughEnabled ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  title="Expand ETF / fund holdings to their underlying positions, scaled proportionally"
                >
                  Look-through
                </button>
                <button
                  onClick={() => setLookThroughEnabled(false)}
                  className={`px-2 py-0.5 rounded-full transition-colors ${!lookThroughEnabled ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  title="Show holdings exactly as the fund reports them"
                >
                  As reported
                </button>
              </div>
            )}
          </div>
          {lookThroughEnabled && lookedThroughSymbols.size > 0 && (
            <p className="text-[10px] text-slate-500 mb-2">
              Looked through{" "}
              <span className="font-semibold text-slate-700">
                {Array.from(lookedThroughSymbols).join(", ")}
              </span>{" "}
              to show underlying positions. Switch to <em>As reported</em> to see the raw holdings.
            </p>
          )}
          {displayedHoldings.length > 0 ? (
            <div className="space-y-1.5">
              {displayedHoldings.map((h, i) => (
                <div key={i} className="flex items-center gap-2 sm:gap-3">
                  <span className="w-4 sm:w-5 text-xs text-slate-400 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 sm:gap-2">
                      {h.symbol && <span className="text-xs font-bold font-mono text-slate-700 shrink-0">{h.symbol}</span>}
                      <span className="text-xs text-slate-500 truncate">{h.name}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                    <div className="w-12 sm:w-20 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${Math.min(h.weight * 3, 100)}%` }}
                      />
                    </div>
                    <span className="w-11 sm:w-12 text-right text-xs font-semibold text-slate-700">{h.weight.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Missing holdings alert */
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
                <div>
                  <p className="text-xs font-semibold text-amber-800">Holdings data not available</p>
                  <p className="text-[11px] text-amber-700 mt-0.5">
                    Automatic sources could not find holdings for this fund. Paste a link to the fund&apos;s holdings page below.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Holdings source info + URL input */}
          {onHoldingsUpdate && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              {(() => {
                const hasHoldings = Boolean(fundData.topHoldings?.length);
                const fromUrl = Boolean(fundData.holdingsUrl);
                const sourceLabel = fundData.holdingsSource || (fromUrl ? "Custom URL" : "Embedded scraper");
                const whenStr = fundData.holdingsLastUpdated
                  ? new Date(fundData.holdingsLastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                  : null;
                if (!hasHoldings) {
                  return (
                    <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 border border-amber-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      No holdings found — paste a URL below
                    </div>
                  );
                }
                return (
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${fromUrl ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${fromUrl ? "bg-indigo-500" : "bg-emerald-500"}`} />
                      {fromUrl ? "Fetched from your URL" : "Auto-found by embedded scraper"}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      Source: <span className="font-semibold text-slate-700">{sourceLabel}</span>
                    </span>
                    {whenStr && (
                      <span className="text-[10px] text-slate-400">· {whenStr}</span>
                    )}
                  </div>
                );
              })()}
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Holdings source URL
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  type="url"
                  value={holdingsUrl}
                  onChange={(e) => { setHoldingsUrl(e.target.value); setScrapeError(""); }}
                  placeholder="https://provider.com/etf/holdings"
                  className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 sm:px-3 py-1.5 text-xs outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all"
                />
                <button
                  onClick={handleScrapeHoldings}
                  disabled={scrapingHoldings || !holdingsUrl.trim()}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {scrapingHoldings ? "Loading..." : "Fetch"}
                </button>
              </div>
              {scrapeError && (
                <p className="text-[11px] text-red-500 mt-1">{scrapeError}</p>
              )}
              {scrapeSuccess && (
                <p className="text-[11px] text-emerald-600 mt-1">Holdings updated successfully!</p>
              )}
            </div>
          )}
        </div>

        {/* Sector Breakdown */}
        {fundData.sectorWeightings && fundData.sectorWeightings.length > 0 && (() => {
          // Normalize provider sector names (Yahoo / Morningstar / Globe
          // and Mail all emit their own variants) so e.g. "Financial
          // Services" and "Financials" roll into a single bucket instead
          // of rendering as two bars with mismatched colors.
          const bySector = new Map<string, number>();
          for (const s of fundData.sectorWeightings) {
            const key = normalizeSector(s.sector);
            bySector.set(key, (bySector.get(key) ?? 0) + s.weight);
          }
          const normalizedSectors = Array.from(bySector.entries())
            .map(([sector, weight]) => ({ sector, weight }))
            .sort((a, b) => b.weight - a.weight);
          return (
          <div className="rounded-[24px] border border-slate-200 bg-white p-4 sm:p-5 shadow-sm overflow-hidden">
            <h2 className="text-base font-bold text-slate-800 mb-3">Sector Breakdown</h2>
            {/* Stacked bar */}
            <div className="flex h-7 sm:h-8 rounded-xl overflow-hidden mb-3">
              {normalizedSectors.map((s) => (
                <div
                  key={s.sector}
                  className={`${sectorColors[s.sector] || "bg-slate-400"} flex items-center justify-center text-[9px] sm:text-[10px] font-semibold text-white`}
                  style={{ width: `${s.weight}%` }}
                >
                  {s.weight >= 8 && `${s.weight.toFixed(0)}%`}
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {normalizedSectors.map((s) => (
                <div key={s.sector} className="flex items-center gap-2 min-w-0">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${sectorColors[s.sector] || "bg-slate-400"}`} />
                  <span className="flex-1 text-xs text-slate-600 truncate">{s.sector}</span>
                  <span className="text-xs font-semibold text-slate-700 shrink-0">{s.weight.toFixed(1)}%</span>
                </div>
              ))}
            </div>

            {/* Asset Allocation */}
            {fundData.assetAllocation && (
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Asset Allocation</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  {fundData.assetAllocation.stock != null && (
                    <div className="rounded-lg bg-blue-50 p-2">
                      <div className="text-[10px] text-blue-500">Stocks</div>
                      <div className="text-sm font-bold text-blue-700">{fundData.assetAllocation.stock.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.bond != null && (
                    <div className="rounded-lg bg-amber-50 p-2">
                      <div className="text-[10px] text-amber-500">Bonds</div>
                      <div className="text-sm font-bold text-amber-700">{fundData.assetAllocation.bond.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.cash != null && (
                    <div className="rounded-lg bg-emerald-50 p-2">
                      <div className="text-[10px] text-emerald-500">Cash</div>
                      <div className="text-sm font-bold text-emerald-700">{fundData.assetAllocation.cash.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.other != null && (
                    <div className="rounded-lg bg-slate-50 p-2">
                      <div className="text-[10px] text-slate-500">Other</div>
                      <div className="text-sm font-bold text-slate-700">{fundData.assetAllocation.other.toFixed(1)}%</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          );
        })()}
      </div>

      {/* Row 3: Equity Metrics (P/E, P/B, etc.) */}
      {fundData.equityMetrics && (
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-800 mb-3">Underlying Equity Metrics</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {fundData.equityMetrics.priceToEarnings != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/E Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToEarnings.toFixed(1)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToBook != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/B Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToBook.toFixed(2)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToSales != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/S Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToSales.toFixed(2)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToCashflow != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/CF Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToCashflow.toFixed(2)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function StockDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const ticker = (params.ticker as string)?.toUpperCase();

  const backHref = from === "pim-model" ? "/pim-model" : "/";
  const backLabel = from === "pim-model" ? "PIM Model" : "Dashboard";
  const fromSuffix = from ? `?from=${from}` : "";

  // Preserve the horizontal scroll position of the ticker nav bar across
  // ticker → ticker navigations. Each click is a full client-side route
  // transition that remounts this page component and resets the bar to
  // scrollLeft=0, which threw the PM back to the first ticker every time.
  // We stash the last scrollLeft in sessionStorage (per-tab, cleared when
  // the tab closes) and rehydrate on mount before the browser paints.
  const tickerBarRef = useRef<HTMLDivElement | null>(null);
  const TICKER_BAR_SCROLL_KEY = "stock-ticker-bar-scroll";
  useEffect(() => {
    const el = tickerBarRef.current;
    if (!el) return;
    try {
      const raw = sessionStorage.getItem(TICKER_BAR_SCROLL_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) el.scrollLeft = n;
      }
    } catch {
      /* sessionStorage disabled — accept the reset, no-op */
    }
    const onScroll = () => {
      try {
        sessionStorage.setItem(TICKER_BAR_SCROLL_KEY, String(el.scrollLeft));
      } catch {
        /* quota / privacy mode — silently drop */
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const { getStock, scoredStocks, marketData, updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateWeight, updateFundData, moveBucket, removeStock, pimModels, toggleModelEligibility, updateModelWeight } = useStocks();
  const stock = getStock(ticker);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState("");
  const [loadingFundData, setLoadingFundData] = useState(false);

  const scoreable = stock ? isScoreable(stock) : true;

  const fetchFundData = useCallback(async () => {
    if (!stock || scoreable) return;
    setLoadingFundData(true);
    try {
      const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.fundData) {
          const existing = stock.fundData;
          // Merge: API data is base, but preserve user-provided holdings
          // (from URL scraping) if the API didn't return any
          const merged = { ...data.fundData };
          if (!merged.topHoldings?.length && existing?.topHoldings?.length) {
            merged.topHoldings = existing.topHoldings;
            merged.sectorWeightings = existing.sectorWeightings;
            merged.holdingsLastUpdated = existing.holdingsLastUpdated;
            merged.holdingsSource = existing.holdingsSource;
          }
          // Always preserve the holdings URL
          if (existing?.holdingsUrl && !merged.holdingsUrl) {
            merged.holdingsUrl = existing.holdingsUrl;
          }
          // Preserve holdingsLastUpdated for URL-sourced holdings
          if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
            merged.holdingsLastUpdated = existing.holdingsLastUpdated;
          }
          // Stamp a fresh timestamp whenever the embedded scraper populated
          // holdings but didn't yet have a last-updated marker — otherwise the
          // UI can't tell the user "we found these live".
          if (merged.topHoldings?.length && !merged.holdingsLastUpdated && !existing?.holdingsLastUpdated) {
            merged.holdingsLastUpdated = new Date().toISOString();
          }
          updateFundData(ticker, merged);
        }
        // Update price from Morningstar for mutual funds (Yahoo doesn't have FUNDSERV prices)
        if (data.price != null && typeof data.price === "number") {
          updatePrice(ticker, data.price);
        }
        // Update name from Morningstar for Canadian funds if we got a better name
        if (data.name && (!stock.name || stock.name === ticker)) {
          updateStockFields(ticker, { name: data.name });
        }
      }
    } catch { /* best effort */ }
    finally { setLoadingFundData(false); }
  }, [ticker, stock, scoreable, updateFundData, updateStockFields, updatePrice]);

  // Auto-fetch fund data on mount if missing
  useEffect(() => {
    if (stock && !scoreable && !stock.fundData) {
      fetchFundData();
    }
  }, [stock, scoreable, fetchFundData]);

  if (!stock) {
    return (
      <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-[30px] border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">{ticker} not found</h1>
            <p className="mt-2 text-slate-500">This ticker is not in your portfolio or watchlist.</p>
            <Link href={backHref} className="mt-4 inline-block text-blue-600 hover:underline text-sm">Back to {backLabel}</Link>
          </div>
        </div>
      </main>
    );
  }

  const portfolioAll = scoredStocks.filter((s) => s.bucket === "Portfolio");
  const watchlistAll = scoredStocks.filter((s) => s.bucket === "Watchlist");
  const alpha = (a: string, b: string) => a.localeCompare(b);
  const portfolioStockTickers = portfolioAll.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const portfolioFundTickers = portfolioAll.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const watchlistStockTickers = watchlistAll.filter((s) => isScoreable(s)).map((s) => s.ticker).sort(alpha);
  const watchlistFundTickers = watchlistAll.filter((s) => !isScoreable(s)).map((s) => s.ticker).sort(alpha);

  const handleRescore = async () => {
    setScoring(true);
    setScoreError("");
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: stock.ticker }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setScoreError(errData.error || `Scoring failed (${res.status})`);
        return;
      }
      const data = await res.json();
      if (data.scores) {
        for (const [key, val] of Object.entries(data.scores)) {
          updateScore(ticker, key as ScoreKey, val as number);
        }
      }
      if (data.explanations) {
        updateExplanations(ticker, data.explanations);
      }
      if (data.price != null) {
        updatePrice(ticker, data.price);
      }
      if (data.healthData) {
        updateHealthData(ticker, data.healthData);
      }
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
      updateLastScored(ticker, new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      }));
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const handleRefreshData = async () => {
    setRefreshing(true);
    setRefreshError("");
    try {
      const res = await fetch("/api/refresh-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: [stock.ticker] }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setRefreshError(errData.error || `Refresh failed (${res.status})`);
        return;
      }
      const data = await res.json();
      const result = data.results?.[0];
      if (result) {
        if (result.price != null) updatePrice(ticker, result.price);
        if (result.healthData) updateHealthData(ticker, result.healthData);
        if (result.technicals && result.riskAlert) updateTechnicals(ticker, result.technicals, result.riskAlert);
        if (result.name || result.sector) {
          updateStockFields(ticker, {
            ...(result.name ? { name: result.name } : {}),
            ...(result.sector ? { sector: result.sector } : {}),
          });
        }
      }
      // Also refresh fund data for ETFs/mutual funds
      if (!scoreable) {
        await fetchFundData();
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = () => {
    removeStock(ticker);
    router.push("/");
  };

  return (
    <main className="min-h-screen bg-[#f4f5f7] text-slate-900 overflow-x-hidden">
      {/* Ticker navigation bar */}
      <div ref={tickerBarRef} className="border-b border-slate-200 bg-white px-4 py-2.5 md:px-8 overflow-x-auto">
        <div className="flex items-center gap-2 w-max">
          <Link
            href={backHref}
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
          >
            &larr; {backLabel}
          </Link>
          {portfolioStockTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Portfolio</span>
              {portfolioStockTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}${fromSuffix}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-blue-600 text-white"
                      : "border border-blue-200 text-blue-700 hover:bg-blue-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
          {portfolioFundTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-indigo-400">Funds & ETFs</span>
              {portfolioFundTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}${fromSuffix}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-indigo-600 text-white"
                      : "border border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
          {watchlistStockTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Watchlist</span>
              {watchlistStockTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}${fromSuffix}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-blue-600 text-white"
                      : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
          {watchlistFundTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">WL Funds & ETFs</span>
              {watchlistFundTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}${fromSuffix}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-indigo-600 text-white"
                      : "border border-slate-200 text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-7xl">
          {/* Stock header card */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-6 items-start">
              {/* Left: stock info */}
              <div className="min-w-0">
                {/* Ticker + price */}
                <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap mb-1">
                  <h1 className="text-2xl sm:text-3xl font-bold font-mono tracking-tight">{stock.ticker}</h1>
                  {stock.price != null && (
                    <span className="text-xl sm:text-2xl font-semibold text-slate-600">${stock.price.toFixed(2)}</span>
                  )}
                  <SignalPill tone={stock.bucket === "Portfolio" ? "blue" : "gray"}>
                    {stock.bucket}
                  </SignalPill>
                  {stock.instrumentType && stock.instrumentType !== "stock" && (
                    <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${stock.instrumentType === "etf" ? "bg-indigo-100 text-indigo-700" : "bg-purple-100 text-purple-700"}`}>
                      {INSTRUMENT_LABELS[stock.instrumentType]}
                    </span>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap mb-3">
                  {scoreable && (
                    <button
                      onClick={handleRescore}
                      disabled={scoring}
                      className="rounded-lg bg-blue-600 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {scoring ? "Scoring..." : "Score"}
                    </button>
                  )}
                  <button
                    onClick={handleRefreshData}
                    disabled={refreshing}
                    className="rounded-lg bg-emerald-600 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    {refreshing ? "Refreshing..." : "Refresh Data"}
                  </button>
                  <button
                    onClick={() => moveBucket(ticker)}
                    className="rounded-lg border border-slate-300 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    Move to {stock.bucket === "Portfolio" ? "Watchlist" : "Portfolio"}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="rounded-lg border border-red-200 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Delete
                  </button>
                  {stock.lastScored && (
                    <span className="text-xs text-slate-400 ml-1">
                      Last scored: {stock.lastScored}
                    </span>
                  )}
                  {scoreError && <span className="text-xs text-red-500 ml-1">{scoreError}</span>}
                  {refreshError && <span className="text-xs text-red-500 ml-1">{refreshError}</span>}
                </div>

                {/* Sector (stocks only) + Weight (funds only) */}
                <div className="flex items-center gap-2 mb-2">
                  {scoreable && stock.sector && (
                    <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700">{stock.sector}</span>
                  )}
                  {!scoreable && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-400">Default Weight:</span>
                      {editingWeight ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const val = parseFloat(weightInput);
                            if (!isNaN(val) && val >= 0) {
                              updateWeight(ticker, val);
                            }
                            setEditingWeight(false);
                          }}
                          className="flex items-center gap-1"
                        >
                          <input
                            value={weightInput}
                            onChange={(e) => setWeightInput(e.target.value)}
                            type="number"
                            step="0.1"
                            min="0"
                            autoFocus
                            className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
                          />
                          <span className="text-xs text-slate-400">%</span>
                          <button type="submit" className="rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700">Save</button>
                          <button type="button" onClick={() => setEditingWeight(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                        </form>
                      ) : (
                        <button
                          onClick={() => { setWeightInput(String(stock.weights.portfolio)); setEditingWeight(true); }}
                          className="rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-200 transition-colors"
                          title="Fallback weight used when no per-model override is set"
                        >
                          {stock.weights.portfolio}%
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Company name */}
                <p className="text-base text-slate-600">{stock.name}</p>

                {/* Company summary & investment thesis */}
                {stock.companySummary && (
                  <p className="mt-2 text-sm text-slate-500 leading-relaxed">{stock.companySummary}</p>
                )}
                {stock.investmentThesis && (
                  <p className="mt-1 text-sm italic text-blue-600/70 leading-relaxed">{stock.investmentThesis}</p>
                )}

                {/* Group progress bars (stocks only) */}
                {scoreable && (
                  <div className="mt-6 space-y-3 max-w-xl">
                    {SCORE_GROUPS.map((group) => {
                      const total = groupTotal(stock, group);
                      const colors = GROUP_COLORS[group.color] || GROUP_COLORS.blue;
                      const pct = (total / group.maxTotal) * 100;

                      return (
                        <div key={group.name} className="flex items-center gap-3">
                          <span className="w-20 text-right text-xs text-slate-500 shrink-0 leading-tight">
                            {group.name === "Company Specific" ? "Company Specific" : group.name}
                          </span>
                          <div className="flex-1 h-3.5 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${colors.bar} transition-all duration-500`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={`w-10 text-right text-xs font-bold shrink-0 ${colors.scoreText}`}>
                            {total}/{group.maxTotal}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Fund key stats for non-scoreable instruments.
                    `effectiveMer` prefers the manual override over the
                    auto-fetched value — same precedence the Client
                    Report uses. When the manual override is the only
                    source (e.g. DYN3366 where auto-fetch missed), we
                    still render the MER tile outside the fundData
                    block so the value is prominent. */}
                {!scoreable && (() => {
                  const manualMer = stock.manualExpenseRatio;
                  const autoMer = stock.fundData?.expenseRatio;
                  // A fund/ETF essentially never has a 0% MER. When the
                  // auto-fetch returns 0 it's almost always a scrape miss
                  // (wrong field parsed), so treat 0 as "no credible MER"
                  // and prefer any manual override. A manual 0 is also
                  // treated as invalid for the same reason — there is no
                  // legitimate reason to type 0 for a real fund/ETF.
                  const validMer = (v: number | null | undefined) =>
                    typeof v === "number" && Number.isFinite(v) && v > 0;
                  const effectiveMer = validMer(manualMer)
                    ? (manualMer as number)
                    : validMer(autoMer)
                    ? (autoMer as number)
                    : null;
                  const autoIsZero =
                    typeof autoMer === "number" && Number.isFinite(autoMer) && autoMer === 0;
                  const merIsManual = validMer(manualMer);
                  const merLabel =
                    stock.instrumentType === "mutual-fund" ? "MER" : "Expense Ratio";
                  return (
                  <div className="mt-6 max-w-xl">
                    {loadingFundData && !stock.fundData && (
                      <div className="rounded-xl bg-slate-50 p-4">
                        <p className="text-sm text-slate-400 animate-pulse">Loading fund data...</p>
                      </div>
                    )}
                    {/* Suspect-zero warning — auto-fetch returned 0 and
                        no manual override exists. 0% MER isn't realistic
                        for a fund/ETF, so surface a visible nudge to type
                        the real value into the Manual MER field below.
                        Rendered above the fund-data grid so the PM sees
                        it without scrolling. */}
                    {autoIsZero && !merIsManual && (
                      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                        <span className="font-semibold">⚠ Auto-fetched {merLabel} is 0%.</span>{" "}
                        This is almost certainly a scrape miss — funds and ETFs essentially never have a 0% MER. Enter the real value in the Manual MER field below so the Client Report blended-fee calc uses it.
                      </div>
                    )}
                    {/* Standalone MER tile — shown whenever we have an
                        effective MER from EITHER source. Without this,
                        tickers with only a manual override (no fundData
                        block) had no visible MER at all. */}
                    {effectiveMer != null && !stock.fundData && (
                      <div className="rounded-xl bg-slate-50 p-3 w-40">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                          {merLabel}
                          {merIsManual && (
                            <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-indigo-700">
                              MANUAL
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-lg font-bold text-slate-800">
                          {effectiveMer.toFixed(2)}%
                        </div>
                      </div>
                    )}
                    {stock.fundData && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {effectiveMer != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                              {merLabel}
                              {merIsManual && (
                                <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-indigo-700">
                                  MANUAL
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-lg font-bold text-slate-800">
                              {effectiveMer.toFixed(2)}%
                            </div>
                          </div>
                        )}
                        {stock.fundData.totalAssets != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">AUM</div>
                            <div className="mt-1 text-lg font-bold text-slate-800">{formatAUM(stock.fundData.totalAssets)}</div>
                          </div>
                        )}
                        {stock.fundData.yield != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Yield</div>
                            <div className="mt-1 text-lg font-bold text-slate-800">{stock.fundData.yield.toFixed(2)}%</div>
                          </div>
                        )}
                        {stock.fundData.starRating != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Morningstar</div>
                            <div className="mt-1 text-lg font-bold text-amber-500">
                              {"★".repeat(stock.fundData.starRating)}{"☆".repeat(5 - stock.fundData.starRating)}
                            </div>
                          </div>
                        )}
                        {stock.fundData.category && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Category</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 leading-tight">{stock.fundData.category}</div>
                          </div>
                        )}
                      </div>
                    )}
                    {!stock.fundData && !loadingFundData && (
                      <button
                        onClick={fetchFundData}
                        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
                      >
                        Load Fund Data
                      </button>
                    )}

                    {/* Manual MER override.
                        The auto-fetch in /api/fund-data misses many
                        mutual-fund series and some lightly-covered ETFs
                        (Morningstar page-layout drift, missing yfinance
                        coverage). This input is a reliable fallback —
                        the Client Report's blended-MER calculation reads
                        `stock.manualExpenseRatio ?? fundData.expenseRatio`
                        so a value typed here overrides whatever the
                        scraper found (or didn't). Stored directly on the
                        Stock record in Redis. */}
                    <div className="mt-4 rounded-xl bg-slate-50 p-3 max-w-sm">
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                        Manual MER override (%)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="10"
                          placeholder={
                            stock.fundData?.expenseRatio != null
                              ? `auto: ${stock.fundData.expenseRatio.toFixed(2)}`
                              : "e.g. 0.08"
                          }
                          defaultValue={
                            stock.manualExpenseRatio != null
                              ? String(stock.manualExpenseRatio)
                              : ""
                          }
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            if (raw === "") {
                              if (stock.manualExpenseRatio != null) {
                                updateStockFields(ticker, { manualExpenseRatio: undefined });
                              }
                              return;
                            }
                            const n = Number(raw);
                            if (Number.isFinite(n) && n >= 0 && n <= 10) {
                              updateStockFields(ticker, { manualExpenseRatio: n });
                            }
                          }}
                          className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
                        />
                        <span className="text-[10px] text-slate-500">
                          Used by the Client Report when auto-fetch is missing or wrong.
                        </span>
                      </div>
                    </div>
                  </div>
                  );
                })()}
              </div>

              {/* Right: donut chart (stocks only) */}
              {scoreable && (
                <div className="flex justify-center lg:justify-end">
                  <ScoreDonut score={stock.adjusted} max={MAX_SCORE} groups={SCORE_GROUPS} stock={stock} />
                </div>
              )}
            </div>
          </div>

          {/* Price Chart (not available for mutual funds) */}
          {stock.instrumentType !== "mutual-fund" && (
            <StockChart ticker={stock.ticker} technicals={stock.technicals} className="mt-6" />
          )}

          {/* Fund Data Panels (ETFs / Mutual Funds) */}
          {!scoreable && stock.fundData && (
            <FundDataPanels
              fundData={stock.fundData}
              ticker={stock.ticker}
              onHoldingsUpdate={(holdings, sectors, url) => {
                let sourceLabel = "Custom URL";
                try {
                  sourceLabel = new URL(url).hostname.replace(/^www\./, "");
                } catch {
                  /* fall through to default label */
                }
                updateFundData(stock.ticker, {
                  ...stock.fundData!,
                  topHoldings: holdings,
                  sectorWeightings: sectors,
                  holdingsUrl: url,
                  holdingsLastUpdated: new Date().toISOString(),
                  holdingsSource: sourceLabel,
                });
              }}
            />
          )}

          {/* Portfolio Role — only for equity ETFs/MFs */}
          {!scoreable && stock.instrumentType && stock.instrumentType !== "stock" && (() => {
            // Only show for equity-class ETFs/MFs (not bond/alternative funds)
            const nameLower = (stock.name || "").toLowerCase();
            const sectorLower = (stock.sector || "").toLowerCase();
            const isBondOrAlt = sectorLower.includes("bond") || sectorLower.includes("fixed") || nameLower.includes("bond") || nameLower.includes("fixed income")
              || sectorLower.includes("alternative") || nameLower.includes("alternative") || nameLower.includes("premium yield") || nameLower.includes("premium incom") || nameLower.includes("hedge") || nameLower.includes("option income") || nameLower.includes("option writing") || nameLower.includes("covered call");
            if (isBondOrAlt) return null;
            return (
              <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm mt-6">
                <h2 className="text-sm font-bold text-slate-800 mb-2">Portfolio Role</h2>
                <p className="text-xs text-slate-400 mb-3">Core = indexed/passive. Alpha = active picks. Sector exposure is based on Alpha picks only.</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateStockFields(ticker, { designation: "core" })}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all border ${
                      stock.designation === "core"
                        ? "bg-blue-100 border-blue-300 text-blue-700"
                        : "bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100"
                    }`}
                  >
                    Core
                  </button>
                  <button
                    onClick={() => updateStockFields(ticker, { designation: "alpha" })}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all border ${
                      (stock.designation || "alpha") === "alpha"
                        ? "bg-amber-100 border-amber-300 text-amber-700"
                        : "bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100"
                    }`}
                  >
                    Alpha
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Model Eligibility & Per-Model Weights */}
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm mt-6">
            <h2 className="text-sm font-bold text-slate-800 mb-3">Model Eligibility</h2>
            <p className="text-xs text-slate-400 mb-3">
              Toggle which PIM model groups this position is eligible for.
              {!scoreable && " Set the weight (%) for each model's Balanced profile."}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {pimModels.groups.map((group) => {
                const eligible = stock.modelEligibility?.[group.id] !== false;
                const modelWeight = stock.modelWeights?.[group.id] ?? stock.weights.portfolio;
                return (
                  <div
                    key={group.id}
                    className={`rounded-lg border transition-all ${
                      eligible
                        ? "bg-emerald-50 border-emerald-200"
                        : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    <button
                      onClick={() => toggleModelEligibility(ticker, group.id, !eligible)}
                      className={`flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-all ${
                        eligible ? "text-emerald-700" : "text-slate-400 hover:text-slate-500"
                      }`}
                    >
                      <span className={`flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                        eligible ? "bg-emerald-500 border-emerald-500" : "border-slate-300 bg-white"
                      }`}>
                        {eligible && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                      {group.name}
                    </button>
                    {/* Per-model weight input for funds/ETFs */}
                    {!scoreable && eligible && (
                      <ModelWeightInput
                        groupId={group.id}
                        modelWeight={modelWeight}
                        isOverride={stock.modelWeights?.[group.id] != null && stock.modelWeights[group.id] !== stock.weights.portfolio}
                        onCommit={(val) => updateModelWeight(ticker, group.id, val)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Score breakdown - 2 column grid (stocks only) */}
          {scoreable && <div className="grid gap-4 md:grid-cols-2 mt-6">
            {SCORE_GROUPS.map((group) => {
              const total = groupTotal(stock, group);
              const colors = GROUP_COLORS[group.color] || GROUP_COLORS.blue;
              const pct = (total / group.maxTotal) * 100;

              return (
                <div key={group.name} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-base ${colors.text}`}>{group.icon}</span>
                      <h2 className="text-base font-bold text-slate-800">{group.name}</h2>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                      <span className={`text-2xl font-bold ${colors.scoreText}`}>{total}</span>
                      <span className="text-sm text-slate-400">/{group.maxTotal}</span>
                    </div>
                  </div>

                  <div className="h-1.5 rounded-full bg-slate-100 mb-5 overflow-hidden">
                    <div className={`h-full rounded-full ${colors.bar} transition-all`} style={{ width: `${pct}%` }} />
                  </div>

                  <div className="space-y-4">
                    {group.categories.map((cat) => {
                      const val = stock.scores[cat.key as ScoreKey] || 0;
                      const bullets = stock.explanations?.[cat.key as ScoreKey];
                      const typeBg =
                        cat.inputType === "auto"
                          ? "bg-emerald-100 text-emerald-700"
                          : cat.inputType === "semi"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-slate-100 text-slate-600";

                      return (
                        <div key={cat.key}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-slate-700">{cat.label}</span>
                              <span className="text-xs text-slate-400">/{cat.max}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${typeBg}`}>
                                {cat.inputType.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex gap-1">
                              {Array.from({ length: cat.max + 1 }, (_, i) => (
                                <button
                                  key={i}
                                  onClick={() => updateScore(ticker, cat.key as ScoreKey, i)}
                                  className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold transition-colors cursor-pointer hover:opacity-80 ${
                                    i === val
                                      ? `${colors.activeBg} ${colors.activeText}`
                                      : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                                  }`}
                                >
                                  {i}
                                </button>
                              ))}
                            </div>
                          </div>
                          {bullets && bullets.length > 0 && (
                            <ul className="ml-1 space-y-1 mb-1">
                              {bullets.map((b, i) => (
                                <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-500">
                                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                                  {b}
                                </li>
                              ))}
                            </ul>
                          )}
                          {!bullets && cat.inputType !== "manual" && (
                            <p className="text-[11px] text-slate-400 italic ml-1">Re-score via Claude to generate explanation</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>}

          {/* Regime context (stocks only) */}
          {scoreable && <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm mt-6">
            <h2 className="text-base font-bold text-slate-800 mb-3">Regime Context</h2>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Current Regime</div>
                <div className="mt-1 text-lg font-semibold">{marketData.riskRegime}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Sector Classification</div>
                <div className="mt-1 text-lg font-semibold">
                  {["Technology", "Communication Services", "Consumer Discretionary"].includes(stock.sector)
                    ? "Offensive"
                    : ["Energy", "Utilities", "Consumer Staples", "Financials", "Materials", "Industrials"].includes(stock.sector)
                    ? "Defensive"
                    : "Neutral"}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Regime Effect</div>
                <div className={`mt-1 text-lg font-semibold ${stock.adjusted - stock.raw >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {stock.adjusted - stock.raw >= 0 ? "+" : ""}{(stock.adjusted - stock.raw).toFixed(1)} pts
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Composite Signal</div>
                <div className="mt-1 text-lg font-semibold">{marketData.compositeSignal}</div>
              </div>
            </div>
          </div>}

          {/* Relative strength vs SPY — informational sparkline */}
          <RatioVsSpxSparkline ticker={stock.ticker} className="mt-6" />

          {/* Risk Alert Panel */}
          {stock.riskAlert && stock.technicals && (
            <RiskAlertPanel riskAlert={stock.riskAlert} technicals={stock.technicals} />
          )}

          {/* Stock Health Monitor */}
          {stock.healthData && (
            <StockHealthMonitor healthData={stock.healthData} technicals={stock.technicals} />
          )}
        </div>
      </div>
    </main>
  );
}
