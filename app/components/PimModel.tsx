"use client";

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { PimModelGroup, PimProfileType, PimComputedHolding, PimAssetClass, PimPerformanceData } from "@/app/lib/pim-types";
import type { Stock, InstrumentType, ScoreKey } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";
import { useStocks } from "@/app/lib/StockContext";
import { useLiveTodayReturn } from "@/app/lib/useLiveTodayReturn";
import { getTodayET } from "@/app/lib/market-hours";
import { PimPerformance } from "./PimPerformance";
import { apportionColumn, fmtPct2, sameAtDisplay } from "@/app/lib/display-weights";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

/** Convert PIM symbol (e.g., PAYF-T) to the ticker used in stock routes (PAYF.TO) */
function symbolToTicker(symbol: string): string {
  if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
  return symbol;
}

/** Render an ISO timestamp as "Xm ago" / "Xh ago" / "MMM D h:mm a" so the
 *  Sleeve Drift "Last updated" label stays compact and human-readable. */
function formatPerfRelTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(t).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

type Props = {
  groups: PimModelGroup[];
};

const PROFILE_LABELS: Record<PimProfileType, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
  core: "Core",
};

const ASSET_CLASS_LABELS: Record<PimAssetClass, string> = {
  fixedIncome: "Fixed Income",
  equity: "Equities",
  alternative: "Alternatives",
};

const ASSET_CLASS_COLORS: Record<PimAssetClass, { bg: string; text: string; bar: string; header: string }> = {
  fixedIncome: { bg: "bg-accent-soft", text: "text-accent", bar: "bg-accent", header: "bg-accent-soft text-accent" },
  equity: { bg: "bg-pos-soft", text: "text-pos", bar: "bg-pos", header: "bg-pos-soft text-pos" },
  alternative: { bg: "bg-warn-soft", text: "text-warn", bar: "bg-warn", header: "bg-warn-soft text-warn" },
};

type SortField = "name" | "symbol" | "currency" | "weightInClass" | "weightInPortfolio" | "cadModelWeight" | "usdModelWeight";
type SortDir = "asc" | "desc";

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (field !== sortField) {
    return (
      <svg className="w-3 h-3 ml-1 inline opacity-30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
      </svg>
    );
  }
  return sortDir === "asc" ? (
    <svg className="w-3 h-3 ml-1 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 15l4-4 4 4" />
    </svg>
  ) : (
    <svg className="w-3 h-3 ml-1 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 4 4-4" />
    </svg>
  );
}

export function PimModel({ groups }: Props) {
  const { getGroupState, uiPrefs, setUiPref, addStock, stocks, pimPortfolioState } = useStocks();
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || "");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("balanced");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Keep the model-group + profile IN SYNC with the shared header selectors
  // (PortfolioTabs writes ?model=&version=). The URL is the shared source of
  // truth, so the two selector sets on the Models page never disagree. URL →
  // state below; state → URL is written by the selectors' onClick (syncUrl).
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const urlModel = searchParams.get("model");
  const urlVersion = searchParams.get("version");
  useEffect(() => {
    if (urlModel && urlModel !== selectedGroupId && groups.some((g) => g.id === urlModel)) {
      setSelectedGroupId(urlModel);
    }
  }, [urlModel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (urlVersion && urlVersion !== selectedProfile) {
      setSelectedProfile(urlVersion as PimProfileType);
    }
  }, [urlVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncUrl = (next: { model?: string; version?: string }) => {
    const p = new URLSearchParams(Array.from(searchParams.entries()));
    if (next.model) p.set("model", next.model);
    if (next.version) p.set("version", next.version);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  // On first mount, seed the shared URL params from the local selection when
  // absent, so the header selectors match the Models page on initial load
  // (not just after the user changes one). Runs once.
  useEffect(() => {
    const p = new URLSearchParams(Array.from(searchParams.entries()));
    let changed = false;
    if (!p.get("model") && selectedGroupId) { p.set("model", selectedGroupId); changed = true; }
    if (!p.get("version")) { p.set("version", selectedProfile); changed = true; }
    if (changed) router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [dropdownSearch, setDropdownSearch] = useState("");
  const [addingToScoring, setAddingToScoring] = useState<string | null>(null);
  const [holdingSearch, setHoldingSearch] = useState("");
  const sortField = (uiPrefs["modelSort"] as SortField) || "name";
  const sortDir = (uiPrefs["modelSortDir"] as SortDir) || "asc";
  const setSortField = (f: SortField) => setUiPref("modelSort", f);
  const setSortDir = (d: SortDir | ((prev: SortDir) => SortDir)) => {
    const val = typeof d === "function" ? d(sortDir) : d;
    setUiPref("modelSortDir", val);
  };
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  // Persisted PIM model performance — read from Redis blob
  // pm:pim-performance via /api/kv/pim-performance. Powers the
  // sleeve-level "Dynamic Weight %" column in the holdings table:
  // we read the standalone "alpha" series (groupId="pim") for the
  // Alpha Model return, and the "core-${profile}" series for the
  // current group/profile to get the Core sleeve return — both
  // measured cumulatively from the group's lastRebalance.date. No
  // local-only state: all underlying data persists in Redis.
  const [perfData, setPerfData] = useState<PimPerformanceData | null>(null);
  // Status of the one-shot core-series backfill (see useEffect below).
  // Surfaced in the Dynamic Wt column header so the user can see when
  // the column is being seeded for the first time.
  const [perfBackfilling, setPerfBackfilling] = useState(false);
  // True while the auto-refresh on first tab open is appending today's
  // prices. Drives the "Refreshing..." indicator on the Sleeve Drift card.
  const [perfAutoRefreshing, setPerfAutoRefreshing] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/kv/pim-performance");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data || !Array.isArray((data as PimPerformanceData).models)) return;
        const perf = data as PimPerformanceData;
        setPerfData(perf);
        // The Dynamic Weight column needs the core-${profile} series
        // (added in this branch) to compute drift. The blob in Redis
        // pre-dates that addition, so we trigger a full recompute via
        // POST /api/pim-performance the first time we detect the new
        // series is missing. The route writes back to pm:pim-performance,
        // so subsequent loads on any device see the populated data.
        // /api/update-daily-value (the Refresh button) only APPENDS
        // daily values to existing series — it can't seed new types.
        // Trigger a recompute when EITHER the per-group "core-${profile}"
        // series OR the firm-wide standalone "core" model (PIM-only)
        // is missing. The firm-wide Core was added later; existing
        // blobs may have core-${profile} but not "core".
        const hasCoreSeries = perf.models.some((m) =>
          typeof m.profile === "string" && m.profile.startsWith("core-")
        );
        const hasFirmWideCore = perf.models.some((m) =>
          m.groupId === "pim" && m.profile === "core"
        );
        if (!hasCoreSeries || !hasFirmWideCore) {
          setPerfBackfilling(true);
          try {
            const recompute = await fetch("/api/pim-performance", { method: "POST" });
            if (recompute.ok) {
              const fresh = await recompute.json();
              if (!cancelled) setPerfData(fresh as PimPerformanceData);
            }
          } catch {
            // Leave column as "—"; user can retry from the Refresh
            // button in the PimPerformance section.
          } finally {
            if (!cancelled) setPerfBackfilling(false);
          }
          // Backfill already produced fresh data — skip the auto-refresh below.
          return;
        }
        // Auto-refresh on first tab open when the cached perf data is
        // stale (>15 min old). Fires /api/update-daily-value, which
        // appends today's prices to every series, then re-reads the
        // updated blob. Sleeve Drift / Dynamic Wt columns then reflect
        // intraday prices without the user having to click Refresh
        // on the Performance section. Skipped when a fresh backfill
        // just ran (above) or when cancelled mid-flight.
        const STALE_MS = 15 * 60 * 1000;
        const lastUpdatedMs = perf.lastUpdated ? new Date(perf.lastUpdated).getTime() : 0;
        const isStale = !lastUpdatedMs || Date.now() - lastUpdatedMs > STALE_MS;
        if (isStale && !cancelled) {
          setPerfAutoRefreshing(true);
          try {
            const refresh = await fetch("/api/update-daily-value", { method: "POST" });
            if (refresh.ok && !cancelled) {
              // The route writes to pm:pim-performance — re-read to get
              // the freshly appended values.
              const fresh = await fetch("/api/kv/pim-performance");
              if (fresh.ok && !cancelled) {
                const freshData = await fresh.json();
                if (freshData && Array.isArray((freshData as PimPerformanceData).models)) {
                  setPerfData(freshData as PimPerformanceData);
                }
              }
            }
          } catch {
            // Non-fatal — Sleeve Drift just shows the stale numbers.
          } finally {
            if (!cancelled) setPerfAutoRefreshing(false);
          }
        }
      } catch {
        // ignore — Dynamic Weight column falls back to target weight
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close dropdown when clicking outside, or when Escape is pressed.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setDropdownSearch("");
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dropdownOpen) {
        setDropdownOpen(false);
        setDropdownSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [dropdownOpen]);

  // Focus search when dropdown opens
  useEffect(() => {
    if (dropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [dropdownOpen]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || groups[0],
    [groups, selectedGroupId]
  );

  const groupState = useMemo(() => getGroupState(selectedGroupId), [getGroupState, selectedGroupId]);

  // Identify the most recently purchased ticker(s) FIRM-WIDE so we can
  // tag them with a "NEW" badge in the holdings table on EVERY model
  // (PIM, PC USA, Non-Res, EY, Deloitte, etc.) — not just the model
  // where the trade was originally executed.
  //
  // Why firm-wide: trades currently only happen in the "pim" group, but
  // the firm-wide propagation we built earlier replaces the holding in
  // every model that owns the sold ticker. So a swap creates transaction
  // records in pim AND any other group that contained the sold ticker
  // (timestamps match). The badge should follow the holding across all
  // models that picked it up.
  //
  // Implementation: union all groupStates' transactions, find the
  // latest buy day's date prefix (YYYY-MM-DD UTC), and tag every symbol
  // bought on that day. Per-group divergence (rare, only if you ever
  // do a one-off model-specific trade) is naturally handled — the
  // latest day across the firm wins. Each model's holdings table then
  // shows the badge on whichever of its holdings match.
  const normalizeTicker = (s: string) => s.toUpperCase().replace("-T", ".TO");

  const latestBuyTickers = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    const allBuys = pimPortfolioState.groupStates.flatMap((gs) =>
      gs.transactions.filter((t) => t.direction === "buy")
    );
    if (allBuys.length === 0) return set;
    // Sort newest-first by ISO timestamp (lexicographic = chronological).
    const sorted = [...allBuys].sort((a, b) => b.date.localeCompare(a.date));
    const latestDay = sorted[0].date.slice(0, 10); // YYYY-MM-DD prefix
    for (const t of allBuys) {
      if (t.date.slice(0, 10) === latestDay) {
        set.add(normalizeTicker(t.symbol));
      }
    }
    return set;
  }, [pimPortfolioState.groupStates]);

  const isLatestBuy = (symbol: string): boolean =>
    latestBuyTickers.has(normalizeTicker(symbol));

  // Build set of core-designated symbols (alpha model excludes these)
  const coreSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const s of stocks) {
      if (s.designation === "core") set.add(s.ticker);
    }
    return set;
  }, [stocks]);

  const availableProfiles = useMemo<PimProfileType[]>(() => {
    if (!selectedGroup) return [];
    const base = (["conservative", "balanced", "growth", "allEquity"] as PimProfileType[]).filter(
      (p) => selectedGroup.profiles[p]
    );
    // Alpha and Core are firm-wide standalone models — only available
    // under the PIM group (chartable views; their data is computed once
    // and shared across all groups via the Sleeve Drift card).
    if (selectedGroup.id === "pim") {
      const hasEquity = selectedGroup.holdings.some((h) => h.assetClass === "equity");
      if (hasEquity) {
        base.push("alpha");
        base.push("core");
      }
    }
    return base;
  }, [selectedGroup]);

  const activeProfile = availableProfiles.includes(selectedProfile)
    ? selectedProfile
    : availableProfiles[0] || "balanced";

  // Keyboard navigation:
  //   ← / →  cycle through available profiles (balanced ↔ growth ↔
  //          allEquity ↔ alpha, where applicable for the group)
  //   ↑ / ↓  cycle through groups (PIM, PC USA, Non-Res, EY, KPMG,
  //          Deloitte, RCGT, etc.)
  // Skips when focus is on a text input so search bars / forms
  // aren't hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      // Shift + ← / → is reserved for switching Portfolio segments (PortfolioTabs);
      // plain arrows drive model/profile here.
      if (e.shiftKey) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (availableProfiles.length <= 1) return;
        const idx = availableProfiles.indexOf(activeProfile);
        const nextIdx = e.key === "ArrowRight"
          ? (idx + 1) % availableProfiles.length
          : (idx - 1 + availableProfiles.length) % availableProfiles.length;
        setSelectedProfile(availableProfiles[nextIdx]);
        e.preventDefault();
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (groups.length <= 1) return;
        const idx = groups.findIndex((g) => g.id === selectedGroupId);
        if (idx < 0) return;
        const nextIdx = e.key === "ArrowDown"
          ? (idx + 1) % groups.length
          : (idx - 1 + groups.length) % groups.length;
        setSelectedGroupId(groups[nextIdx].id);
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [availableProfiles, activeProfile, groups, selectedGroupId]);

  // Alpha + Core profiles = virtual 100% equity; otherwise use stored
  // profile weights. Both are standalone equity-only models composed
  // from designation:"alpha" / designation:"core" stocks respectively.
  const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const CORE_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = activeProfile === "alpha"
    ? ALPHA_WEIGHTS
    : activeProfile === "core"
    ? CORE_WEIGHTS
    : selectedGroup?.profiles[activeProfile];

  // Reference PIM group for canonical individual stock weights
  const pimGroup = useMemo(() => groups.find((g) => g.id === "pim"), [groups]);

  const effectiveGroup = useMemo(() => {
    if (!selectedGroup) return selectedGroup;

    // Alpha: equity-only, exclude core ETFs, re-normalize proportionally
    if (activeProfile === "alpha") {
      const alphaHoldings = selectedGroup.holdings.filter(
        (h) => h.assetClass === "equity" && !coreSymbols.has(symbolToTicker(h.symbol))
      );
      const totalWeight = alphaHoldings.reduce((s, h) => s + h.weightInClass, 0);
      const normalized = totalWeight > 0
        ? alphaHoldings.map((h) => ({ ...h, weightInClass: h.weightInClass / totalWeight }))
        : alphaHoldings;
      return { ...selectedGroup, holdings: normalized };
    }

    // Core: equity-only, ONLY core-designated ETFs/funds, weighted
    // proportionally and re-normalized to sum to 100%. Mirror of the
    // Alpha view but for the core sleeve. Locked specialty funds
    // (FID5982, GRNJ) are not in coreSymbols by default, so they
    // appear in Alpha rather than here.
    if (activeProfile === "core") {
      const coreHoldings = selectedGroup.holdings.filter(
        (h) => h.assetClass === "equity" && coreSymbols.has(symbolToTicker(h.symbol))
      );
      const totalWeight = coreHoldings.reduce((s, h) => s + h.weightInClass, 0);
      const normalized = totalWeight > 0
        ? coreHoldings.map((h) => ({ ...h, weightInClass: h.weightInClass / totalWeight }))
        : coreHoldings;
      return { ...selectedGroup, holdings: normalized };
    }

    // Non-PIM groups: RESPECT the stored equity weightInClass. StockContext's
    // rebalanceStockWeights is the single source of truth — it keeps Core ETFs
    // + Alpha funds at their manually-set weights and flexes the individual
    // stocks to fill the residual, always summing the equity class to 100%.
    // The page therefore just uses those stored weights (so a manual Core /
    // Alpha weight edit is actually VISIBLE) and only normalizes the equity
    // class to 1.0 as a safety net against any stale/legacy blob whose weights
    // don't already sum cleanly.
    //
    // Replaces an older deficit-split that force-adopted PIM-canonical weights
    // for individual stocks and made Core ETFs absorb the residual. That math
    // overrode manual Core/Alpha weight edits on screen — the stored value
    // changed but the page recomputed and hid it, so edits appeared to do
    // nothing. (No-op on currently-balanced data: stored equity already sums
    // to 1.0, so normalization changes nothing until a weight is edited.)
    if (selectedGroup.id !== "pim" && pimGroup) {
      const equityTotal = selectedGroup.holdings
        .filter((h) => h.assetClass === "equity")
        .reduce((s, h) => s + h.weightInClass, 0);
      if (equityTotal <= 0) return selectedGroup;
      const adjusted = selectedGroup.holdings.map((h) =>
        h.assetClass === "equity"
          ? { ...h, weightInClass: h.weightInClass / equityTotal }
          : h,
      );
      return { ...selectedGroup, holdings: adjusted };
    }

    return selectedGroup;
  }, [selectedGroup, activeProfile, coreSymbols, pimGroup]);

  // Fetch live prices for all holdings
  const fetchPrices = useCallback(async () => {
    if (!selectedGroup) return;
    setPricesLoading(true);
    const symbols = selectedGroup.holdings
      .map((h) => {
        if (h.symbol.endsWith("-T")) return h.symbol.replace("-T", ".TO");
        if (h.symbol.endsWith(".U")) return h.symbol.replace(".U", "-U.TO");
        return h.symbol;
      })
      .filter((s) => !/^[A-Z]{2,4}\d{2,5}$/i.test(s)); // skip FUNDSERV
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: symbols }),
      });
      if (res.ok) {
        const data = await res.json();
        const mapped: Record<string, number> = {};
        // Map back to original symbols
        for (const h of selectedGroup.holdings) {
          let yahoo = h.symbol;
          if (h.symbol.endsWith("-T")) yahoo = h.symbol.replace("-T", ".TO");
          else if (h.symbol.endsWith(".U")) yahoo = h.symbol.replace(".U", "-U.TO");
          if (data.prices?.[yahoo] != null) mapped[h.symbol] = data.prices[yahoo];
        }
        setLivePrices(mapped);
      }
    } catch { /* ignore */ }
    setPricesLoading(false);
  }, [selectedGroup]);

  // Auto-fetch prices on group change
  useEffect(() => { fetchPrices(); }, [selectedGroupId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live today returns for the two firm-wide standalone models —
  // these feed both the Sleeve Drift card and the Dynamic Wt column.
  //
  // useLiveTodayReturn is backed by a module-level cache keyed on
  // (groupId, profile), so PimPerformance's ("pim", selectedProfile)
  // instance, PimPortfolio's tile, and these two calls all share the
  // exact same fetched value per key. When ANY consumer calls refetch
  // the cache fan-outs the new value to every subscriber — no more
  // drift between chart Period Return and Sleeve Drift.
  //
  // We still proactively refetch alpha + core when PimPerformance
  // reloads its perf data, because PimPerformance's own refetch only
  // covers the selectedProfile key. When the user is on the Balanced
  // tab (say), refreshing the chart would refetch ("pim","balanced")
  // but leave ("pim","alpha") and ("pim","core") stale until the
  // next StockContext mutation. This callback closes that gap.
  const { value: alphaLiveToday, refetch: refetchAlphaLive } = useLiveTodayReturn("pim", "alpha");
  const { value: coreLiveToday, refetch: refetchCoreLive } = useLiveTodayReturn("pim", "core");

  const handlePerfDataChanged = useCallback((data: PimPerformanceData) => {
    setPerfData(data);
    refetchAlphaLive();
    refetchCoreLive();
  }, [refetchAlphaLive, refetchCoreLive]);

  const computedHoldings = useMemo<PimComputedHolding[]>(() => {
    if (!effectiveGroup || !profileWeights) return [];

    const holdings = effectiveGroup.holdings;
    const rebalancePriceMap = groupState.lastRebalance?.prices || {};

    // CAD Model & USD Model columns: per-asset-class, per-currency-sleeve
    // normalization, scaled by the asset-class allocation. Each currency
    // column independently sums to that class's target weight (e.g. for
    // Balanced: FI 28%, equity 66%, alt 6%) — i.e. each column answers
    // "if this asset class were entirely <currency>, what weight would
    // each holding have?", with positions proportionally filling the
    // class target by their share of that currency's sleeve.
    //
    // This replaced an earlier CAD-only scheme that divided by the total
    // CAD portfolio across ALL classes (so the CAD column summed to ~100%
    // and drifted whenever a trade shifted the CAD/USD mix). The symmetric
    // per-class version makes CAD and USD behave identically and keeps
    // each column's total locked to the class target. DISPLAY-ONLY — these
    // values never feed weightInClass or any persisted/rebalance math.
    const classCadTotals: Record<string, number> = {};
    const classUsdTotals: Record<string, number> = {};
    holdings.forEach((h) => {
      if (h.currency === "CAD") {
        classCadTotals[h.assetClass] = (classCadTotals[h.assetClass] || 0) + h.weightInClass;
      } else if (h.currency === "USD") {
        classUsdTotals[h.assetClass] = (classUsdTotals[h.assetClass] || 0) + h.weightInClass;
      }
    });

    // (The equity class used to be built here with a "2x rule" plus a
    // stocks-only special case. Both encoded a 50/50 CAD/USD assumption that
    // PC USA breaks; the per-holding computation below now derives each
    // column from the sleeve's actual share instead. DISPLAY-ONLY — none of
    // it feeds weightInClass or rebalance math.)

    // ── Dynamic Weight computation (sleeve-level drift) ────────────
    // Read the standalone Alpha Model return (PIM "alpha" series) and
    // this group's core-sleeve return (groupId/"core-${profile}"
    // series), both as cumulative returns since the relevant
    // lastRebalance.date. The Alpha Model anchors to PIM's lastRebalance
    // since the standalone alpha series IS the PIM alpha profile.
    // Returns null when no data is available (no rebalance yet, no
    // perf cron run, or alpha profile selected) → dynamicWeight falls
    // back to the target weight.
    const returnSinceRebalance = (
      groupId: string,
      profileKey: string,
      rebalanceDate: string | undefined,
      liveToday: number | null,
    ): number | null => {
      if (!perfData || !rebalanceDate) return null;
      const series = perfData.models.find((m) => m.groupId === groupId && m.profile === profileKey);
      if (!series || series.history.length === 0) return null;
      const rebalDay = rebalanceDate.slice(0, 10);
      // Walk newest-first to find the last entry on/before the rebalance day.
      let baseline: number | null = null;
      for (let i = series.history.length - 1; i >= 0; i--) {
        if (series.history[i].date <= rebalDay) {
          baseline = series.history[i].value;
          break;
        }
      }
      if (baseline == null || baseline <= 0) return null;
      // Apply the same live-today overlay PimPerformance uses for its
      // Period Return / chart, so the Dynamic Wt column reflects
      // intraday moves rather than yesterday's close.
      const lastEntry = series.history[series.history.length - 1];
      let latest = lastEntry.value;
      if (liveToday != null && lastEntry.date === getTodayET() && series.history.length >= 2) {
        const yesterdayValue = series.history[series.history.length - 2].value;
        latest = yesterdayValue * (1 + liveToday / 100);
      }
      return latest / baseline - 1;
    };

    // PIM's lastRebalance.date is the firm-wide drift anchor: every
    // rebalance is triggered from PIM and propagates trades across all
    // groups (PC-USA, Non-Res, EY, KPMG, Deloitte, RCGT), but the
    // rebalance handler only writes lastRebalance to the selected
    // group's state. Using PIM as the universal anchor means every
    // model — including those whose own lastRebalance was never set —
    // can compute drift from the same start date.
    const pimGroupState = getGroupState("pim");
    const firmRebalanceDate = pimGroupState.lastRebalance?.date;
    // Both Alpha and Core are firm-wide standalone models — same single
    // pair of return numbers powers Dynamic Wt across every group.
    // Skip on Alpha / Core profiles themselves (no sleeves to drift).
    const skipDrift = activeProfile === "alpha" || activeProfile === "core";
    const alphaReturn = skipDrift
      ? null
      : returnSinceRebalance("pim", "alpha", firmRebalanceDate, alphaLiveToday);
    const coreReturn = skipDrift
      ? null
      : returnSinceRebalance("pim", "core", firmRebalanceDate, coreLiveToday);

    // Tally sleeve target totals across all equity (locked specialty
    // funds DO drift with the alpha sleeve here — they're excluded
    // from the server-side core/alpha SERIES calculation, but they
    // still need to scale on the display).
    let alphaSleeveTarget = 0;
    let coreSleeveTarget = 0;
    if (alphaReturn != null && coreReturn != null) {
      const alphaAlloc = profileWeights ? profileWeights.equity : 0;
      for (const h of holdings) {
        if (h.assetClass !== "equity") continue;
        const tk = symbolToTicker(h.symbol);
        const wInPortfolio = h.weightInClass * alphaAlloc;
        if (coreSymbols.has(tk)) coreSleeveTarget += wInPortfolio;
        else alphaSleeveTarget += wInPortfolio;
      }
    }
    const totalSleeveTarget = alphaSleeveTarget + coreSleeveTarget;
    // coreScale / alphaScale: multiplied into each holding's target
    // weight to produce the dynamic weight, so each position keeps
    // its RELATIVE share of its sleeve. ETFs/mutual funds with
    // larger target weights (XUH, FID5982) stay larger than smaller
    // siblings; only the sleeve totals shift.
    let coreScale = 1;
    let alphaScale = 1;
    if (alphaReturn != null && coreReturn != null && totalSleeveTarget > 0) {
      const driftedAlpha = alphaSleeveTarget * (1 + alphaReturn);
      const driftedCore = coreSleeveTarget * (1 + coreReturn);
      const driftedTotal = driftedAlpha + driftedCore;
      const renormScale = driftedTotal > 0 ? totalSleeveTarget / driftedTotal : 1;
      let finalAlphaTotal = driftedAlpha * renormScale;
      let finalCoreTotal = driftedCore * renormScale;
      // Core floor: per-position dynamic >= its target (so XUH never
      // drops below 16.67%), AND aggregate core sum >= 50% of the
      // equity sleeve. Per-position floor is enforced by clamping
      // the sleeve total to >= sum of core targets, which (combined
      // with proportional distribution below) keeps each core
      // position at >= target. The 50% floor kicks in only if a
      // model's core target is already <50% of equity — defensive.
      const coreFloor = Math.max(coreSleeveTarget, totalSleeveTarget * 0.5);
      if (finalCoreTotal < coreFloor) {
        finalCoreTotal = Math.min(coreFloor, totalSleeveTarget);
        finalAlphaTotal = totalSleeveTarget - finalCoreTotal;
      }
      coreScale = coreSleeveTarget > 0 ? finalCoreTotal / coreSleeveTarget : 1;
      alphaScale = alphaSleeveTarget > 0 ? finalAlphaTotal / alphaSleeveTarget : 1;
    }

    // Compute growth factors for live weight drift
    const holdingsWithGrowth = holdings.map((h) => {
      let assetClassAllocation = 0;
      if (h.assetClass === "fixedIncome") assetClassAllocation = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") assetClassAllocation = profileWeights.equity;
      else if (h.assetClass === "alternative") assetClassAllocation = profileWeights.alternatives;

      const weightInPortfolio = h.weightInClass * assetClassAllocation;
      const currentPrice = livePrices[h.symbol];
      const rebalPrice = rebalancePriceMap[h.symbol];
      const growthFactor = (currentPrice && rebalPrice && rebalPrice > 0)
        ? currentPrice / rebalPrice : 1;

      return { h, assetClassAllocation, weightInPortfolio, currentPrice, rebalPrice, growthFactor };
    });

    // Portfolio-level growth denominator for live weight
    const portfolioGrowth = holdingsWithGrowth.reduce(
      (sum, x) => sum + x.weightInPortfolio * x.growthFactor, 0
    );
    const hasRebalance = !!groupState.lastRebalance;

    return holdingsWithGrowth.map((x) => {
      const { h, weightInPortfolio, currentPrice, rebalPrice, growthFactor } = x;

      const assetClassAllocation = x.assetClassAllocation;

      // CAD/USD Model columns — see the construction notes above.
      const classCadTotal = classCadTotals[h.assetClass] || 0;
      const classUsdTotal = classUsdTotals[h.assetClass] || 0;
      let cadModelWeight: number | null = null;
      let usdModelWeight: number | null = null;

      // A holding's share of its own currency sleeve, scaled by the class
      // allocation — EXCEPT where that currency exists in only one asset
      // class, in which case the sleeve is a sub-account holding nothing else
      // and its column normalizes to 100% instead.
      //
      // PC USA is the case: its only Canadian positions are CAD stocks, so a
      // Balanced client's CAD account is still 100% equity and each of the 7
      // names is 100%/7 = 14.29% of it, on every profile. Scaling that by the
      // household's 66% equity allocation would report 9.43% for an account
      // that holds nothing but those stocks. PIM's CAD sleeve does hold bonds
      // (JBND-T), so there the class allocation rightly applies.
      //
      // Equity used to be special-cased with a "2x rule" — non-Core holdings
      // shown at twice their class weight, Core ETFs absorbing the residual —
      // on the reasoning that each currency is half of a 50/50 model. But 2 is
      // just 1/0.5, a hardcoded 50/50 assumption, and PC USA is ~87/13. Its US
      // stocks were displayed at 3.64% when the correct figure is 2.08%
      // (1.82% target / 0.8727 sleeve), making the column unreliable precisely
      // where it was needed most.
      //
      // Dividing by the sleeve's ACTUAL share generalizes the old rule rather
      // than replacing it: a sleeve at exactly 50% yields 1/0.5 = 2x, so every
      // 50/50 model is unchanged to the last decimal. It also drops the
      // separate stocks-only branch (PC USA's CAD sleeve) — that existed to
      // work around the same 50/50 assumption — so both columns are now
      // symmetric and each sums to its class target by construction.
      // Does this currency appear in any OTHER asset class in this model?
      const cadClassCount = Object.values(classCadTotals).filter((v) => v > 0).length;
      const usdClassCount = Object.values(classUsdTotals).filter((v) => v > 0).length;
      const cadScale = cadClassCount <= 1 ? 1 : assetClassAllocation;
      const usdScale = usdClassCount <= 1 ? 1 : assetClassAllocation;

      cadModelWeight = h.currency === "CAD" && classCadTotal > 0
        ? (h.weightInClass / classCadTotal) * cadScale : null;
      usdModelWeight = h.currency === "USD" && classUsdTotal > 0
        ? (h.weightInClass / classUsdTotal) * usdScale : null;

      // Live weight with drift
      let liveWeight: number | undefined;
      let driftBps: number | undefined;
      if (hasRebalance && portfolioGrowth > 0 && currentPrice && rebalPrice) {
        liveWeight = (weightInPortfolio * growthFactor) / portfolioGrowth;
        driftBps = Math.round((liveWeight - weightInPortfolio) * 10000);
      }

      // Sleeve-level drifted target for the Dynamic Weight column.
      // FI/alts/locked equity stay at the static target; alpha and
      // core equity holdings each get the equal-weighted share of
      // their drifted sleeve total.
      let dynamicWeight: number | undefined;
      if (alphaReturn != null && coreReturn != null && totalSleeveTarget > 0) {
        if (h.assetClass !== "equity") {
          dynamicWeight = weightInPortfolio;
        } else {
          const tk = symbolToTicker(h.symbol);
          const scale = coreSymbols.has(tk) ? coreScale : alphaScale;
          dynamicWeight = weightInPortfolio * scale;
        }
      }

      return {
        ...h, weightInPortfolio, cadModelWeight, usdModelWeight,
        liveWeight, driftBps, currentPrice, rebalancePrice: rebalPrice,
        dynamicWeight,
      };
    });
  }, [effectiveGroup, profileWeights, livePrices, groupState, perfData, activeProfile, coreSymbols, getGroupState, alphaLiveToday, coreLiveToday]);

  const filteredHoldings = useMemo(() => {
    if (!holdingSearch.trim()) return computedHoldings;
    const q = holdingSearch.toLowerCase();
    return computedHoldings.filter((h) => h.name.toLowerCase().includes(q) || h.symbol.toLowerCase().includes(q));
  }, [computedHoldings, holdingSearch]);

  const holdingsByClass = useMemo(() => {
    const grouped: Record<PimAssetClass, PimComputedHolding[]> = { fixedIncome: [], equity: [], alternative: [] };
    filteredHoldings.forEach((h) => grouped[h.assetClass].push(h));
    return grouped;
  }, [filteredHoldings]);

  const filteredDropdownGroups = useMemo(() => {
    if (!dropdownSearch.trim()) return groups;
    const q = dropdownSearch.toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, dropdownSearch]);

  // Drift summary: surfaces the same alpha-vs-core returns that drive
  // the Dynamic Wt column so they can be displayed standalone above
  // the holdings table. Mirrors the computation in computedHoldings —
  // alphaReturn from PIM "alpha" series, coreReturn from this group's
  // "core-${profile}" series, both anchored to PIM lastRebalance.
  const driftSummary = useMemo<{
    anchorDate: string | null;
    alphaReturn: number | null;
    coreReturn: number | null;
  }>(() => {
    // Show on every profile, including Alpha and Core themselves —
    // on those tabs the card displays the same Alpha / Core / Spread
    // numbers as a cumulative return since the last rebalance, which
    // is what the SLR period view in the chart is anchored to.
    if (!perfData || !effectiveGroup) {
      return { anchorDate: null, alphaReturn: null, coreReturn: null };
    }
    const anchor = getGroupState("pim").lastRebalance?.date || null;
    if (!anchor) return { anchorDate: null, alphaReturn: null, coreReturn: null };
    const day = anchor.slice(0, 10);
    const todayET = getTodayET();
    const compute = (groupId: string, profileKey: string, liveToday: number | null): number | null => {
      const series = perfData.models.find((m) => m.groupId === groupId && m.profile === profileKey);
      if (!series || series.history.length === 0) return null;
      let baseline: number | null = null;
      for (let i = series.history.length - 1; i >= 0; i--) {
        if (series.history[i].date <= day) { baseline = series.history[i].value; break; }
      }
      if (baseline == null || baseline <= 0) return null;
      // Match PimPerformance's `effectiveHistory` overlay: when the
      // last persisted entry is dated today and we have a live Today
      // return (market open / after-hours), replace today's value with
      // yesterday × (1 + liveToday/100). This keeps Sleeve Drift in
      // lockstep with the chart's Period Return.
      const lastEntry = series.history[series.history.length - 1];
      let latest = lastEntry.value;
      if (liveToday != null && lastEntry.date === todayET && series.history.length >= 2) {
        const yesterdayValue = series.history[series.history.length - 2].value;
        latest = yesterdayValue * (1 + liveToday / 100);
      }
      return latest / baseline - 1;
    };
    // BOTH Alpha and Core are firm-wide standalone models stored under
    // groupId="pim". Every model uses the same Alpha return and the
    // same Core return for the Sleeve Drift comparison.
    return {
      anchorDate: day,
      alphaReturn: compute("pim", "alpha", alphaLiveToday),
      coreReturn: compute("pim", "core", coreLiveToday),
    };
  }, [activeProfile, perfData, effectiveGroup, getGroupState, alphaLiveToday, coreLiveToday]);

  // Diagnostic for the Dynamic Weight column — when the column is
  // blank, explain *why*. Walks the same prerequisites as the
  // computation so the message stays in sync.
  const dynamicWeightDiagnostic = useMemo<string | null>(() => {
    if (activeProfile === "alpha") return "alpha profile shows no drift";
    if (activeProfile === "core") return "core profile shows no drift";
    if (perfBackfilling) return null;
    if (!perfData) return "perf data not loaded yet";
    const pimRebal = getGroupState("pim").lastRebalance?.date;
    if (!pimRebal) return "PIM has no rebalance date — execute a rebalance from PIM Portfolio";
    const alphaSeries = perfData.models.find((m) => m.groupId === "pim" && m.profile === "alpha");
    if (!alphaSeries || alphaSeries.history.length === 0) return "no \"alpha\" series under groupId=pim — confirm at least one stock has designation:'alpha' (or unset)";
    if (!effectiveGroup) return null;
    // Firm-wide Core model: same series for every group.
    const coreSeries = perfData.models.find((m) => m.groupId === "pim" && m.profile === "core");
    if (!coreSeries || coreSeries.history.length === 0) {
      const coreCount = Array.from(coreSymbols).length;
      return coreCount === 0
        ? "no stocks tagged designation:'core' — visit the Stocks tab and tag your core ETFs (XSP, XUH, XUU, etc.)"
        : "no \"core\" series under groupId=pim — recompute may have failed";
    }
    const day = pimRebal.slice(0, 10);
    const alphaBase = [...alphaSeries.history].reverse().find((h) => h.date <= day);
    if (!alphaBase) return `alpha series has no data on or before ${day} (earliest is ${alphaSeries.history[0]?.date})`;
    const coreBase = [...coreSeries.history].reverse().find((h) => h.date <= day);
    if (!coreBase) return `core series has no data on or before ${day} (earliest is ${coreSeries.history[0]?.date})`;
    return null;
  }, [activeProfile, perfBackfilling, perfData, effectiveGroup, coreSymbols, getGroupState]);

  const portfolioTotal = useMemo(
    () => computedHoldings.reduce((sum, h) => sum + h.weightInPortfolio, 0),
    [computedHoldings]
  );

  // Dynamic currency split based on model holdings
  const currencySplit = useMemo(() => {
    let cadWeight = 0;
    let usdWeight = 0;
    for (const h of computedHoldings) {
      if (h.currency === "CAD") cadWeight += h.weightInPortfolio;
      else if (h.currency === "USD") usdWeight += h.weightInPortfolio;
    }
    const total = cadWeight + usdWeight;
    if (total === 0) return { cad: 0, usd: 0 };
    return { cad: cadWeight / total, usd: usdWeight / total };
  }, [computedHoldings]);

  // Sort handler
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" || field === "symbol" || field === "currency" ? "asc" : "desc");
    }
  };

  const sortHoldings = (list: PimComputedHolding[]): PimComputedHolding[] => {
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "symbol": cmp = a.symbol.localeCompare(b.symbol); break;
        case "currency": cmp = a.currency.localeCompare(b.currency); break;
        case "weightInClass": cmp = a.weightInClass - b.weightInClass; break;
        case "weightInPortfolio": cmp = a.weightInPortfolio - b.weightInPortfolio; break;
        case "cadModelWeight": cmp = (a.cadModelWeight ?? -1) - (b.cadModelWeight ?? -1); break;
        case "usdModelWeight": cmp = (a.usdModelWeight ?? -1) - (b.usdModelWeight ?? -1); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  };

  // Check if a PIM holding is already in the scoring/dashboard stocks list
  const isInScoring = useCallback((symbol: string) => {
    const ticker = symbolToTicker(symbol);
    return stocks.some((s) => s.ticker === ticker || s.ticker === symbol || s.ticker.replace("-T", ".TO") === ticker);
  }, [stocks]);

  // Add a PIM holding to the scoring/dashboard stocks list
  const handleAddToScoring = useCallback(async (holding: PimComputedHolding) => {
    const ticker = symbolToTicker(holding.symbol);
    if (isInScoring(holding.symbol)) return;
    setAddingToScoring(holding.symbol);

    let name = holding.name || ticker;
    let instrumentType: InstrumentType = "stock";
    let sector = "";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[ticker]) name = data.names[ticker];
        if (data.sectors?.[ticker]) sector = data.sectors[ticker];
        if (data.types?.[ticker]) instrumentType = data.types[ticker] as InstrumentType;
      }
    } catch { /* fallback */ }

    const stock: Stock = {
      ticker,
      name,
      instrumentType,
      bucket: "Portfolio",
      sector: instrumentType === "etf" || instrumentType === "mutual-fund" ? "" : sector,
      beta: 1.0,
      weights: { portfolio: 0 },
      scores: { ...ZERO_SCORES },
      notes: "",
    };
    addStock(stock);
    setAddingToScoring(null);
  }, [isInScoring, addStock]);

  if (!selectedGroup) return null;

  const thClass = "py-2.5 px-2 font-semibold cursor-pointer select-none hover:text-ink transition-colors whitespace-nowrap";
  const isPimGroup = ["pim", "pc-usa", "non-res", "no-us-situs"].includes(selectedGroup.id);

  return (
    <div className="space-y-5">
      {/* Header: Model selector + Profile tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {/* Model group dropdown */}
        <div className="flex-1 max-w-md" ref={dropdownRef}>
          <label className="block text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1.5">
            Model Group
          </label>
          <div className="relative">
            <button
              onClick={() => { setDropdownOpen(!dropdownOpen); setDropdownSearch(""); }}
              className="w-full flex items-center justify-between rounded-control border border-line bg-white px-4 py-2.5 text-sm text-left outline-none hover:border-line focus:border-accent-border focus:ring-2 focus:ring-accent-border transition-all"
            >
              <span className="font-semibold text-ink">{selectedGroup.name}</span>
              <svg className={`w-4 h-4 text-ink-3 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="absolute z-30 mt-1 w-full rounded-control border border-line bg-white shadow-lg overflow-hidden">
                <div className="p-2 border-b border-line-soft">
                  <input ref={searchInputRef} type="text" value={dropdownSearch} onChange={(e) => setDropdownSearch(e.target.value)}
                    placeholder="Search..." className="w-full rounded-lg border border-line-soft bg-surface-2 px-3 py-1.5 text-sm outline-none placeholder:text-ink-3 focus:border-accent-border focus:bg-white transition-all" />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredDropdownGroups.map((g) => (
                    <button key={g.id} onClick={() => { setSelectedGroupId(g.id); syncUrl({ model: g.id }); setDropdownOpen(false); setDropdownSearch(""); }}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-surface-2 transition-colors flex items-center justify-between ${g.id === selectedGroupId ? "bg-accent-soft text-accent" : "text-ink"}`}>
                      <span className={g.id === selectedGroupId ? "font-semibold" : ""}>{g.name}</span>
                      <span className="text-[10px] text-ink-3 uppercase">{Object.keys(g.profiles).map((p) => PROFILE_LABELS[p as PimProfileType]?.[0]).join(" / ")}</span>
                    </button>
                  ))}
                  {filteredDropdownGroups.length === 0 && <div className="px-4 py-3 text-sm text-ink-3 text-center">No models found</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Profile tabs — horizontally scrollable so 5-6 profiles
            (Conservative … Core) don't overflow on mobile. */}
        <div className="flex gap-1 rounded-control bg-surface-2 p-1 overflow-x-auto max-w-full">
          {availableProfiles.map((p) => (
            <button key={p} onClick={() => { setSelectedProfile(p); syncUrl({ version: p }); }}
              className={`shrink-0 rounded-lg px-3 sm:px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${activeProfile === p ? "bg-white text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Action Buttons (PIM groups only) */}
      {isPimGroup && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={fetchPrices} disabled={pricesLoading}
            className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-line transition-colors disabled:opacity-50">
            <svg className={`w-3.5 h-3.5 ${pricesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
            {pricesLoading ? "Loading..." : "Refresh Prices"}
          </button>
        </div>
      )}

      {/* ── Asset Allocation (left) + Performance Tracker (right), per mockup ── */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_1fr] items-start">
      {/* Asset Allocation Summary */}
      {profileWeights ? (
        <div className="rounded-card border border-line bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">Asset Allocation</h2>
            <span className="text-sm font-semibold text-accent">{PROFILE_LABELS[activeProfile]}</span>
          </div>
          <div className="mb-4 flex h-3 overflow-hidden rounded-full">
            <div className="bg-accent" style={{ width: `${profileWeights.equity * 100}%` }} />
            {profileWeights.fixedIncome > 0 && <div className="bg-pos" style={{ width: `${profileWeights.fixedIncome * 100}%` }} />}
            {profileWeights.alternatives > 0 && <div className="bg-violet" style={{ width: `${profileWeights.alternatives * 100}%` }} />}
            {profileWeights.cash > 0 && <div className="bg-ink-3" style={{ width: `${profileWeights.cash * 100}%` }} />}
          </div>
          {/* Allocations are model inputs too, so they carry the same 2dp
              contract as the holdings tables: apportioned to sum to exactly
              100.00% (cash included), and the invested Total below is the sum
              of the three displayed class rows — so it always agrees with the
              three TOTAL rows in the tables rather than being rounded apart
              from them. */}
          {(() => {
            const allocRows = [
              { label: "Equities", value: profileWeights.equity, dot: "bg-accent" },
              { label: "Fixed Income", value: profileWeights.fixedIncome, dot: "bg-pos" },
              { label: "Alternatives", value: profileWeights.alternatives, dot: "bg-violet" },
              { label: "Cash", value: profileWeights.cash, dot: "bg-ink-3" },
            ];
            const dAlloc = apportionColumn(allocRows.map((r) => r.value), 1);
            const invested = (dAlloc.values[0] ?? 0) + (dAlloc.values[1] ?? 0) + (dAlloc.values[2] ?? 0);
            const dCcy = apportionColumn([currencySplit.cad, currencySplit.usd], 1);
            const ties = Math.abs(portfolioTotal - (profileWeights.fixedIncome + profileWeights.equity + profileWeights.alternatives)) < 0.001;
            return (
              <>
                <div className="space-y-2.5 text-sm">
                  {allocRows.map((r, i) => (r.value > 0 ? (
                    <div key={r.label} className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-sm ${r.dot}`} />
                        <span className="text-ink-2">{r.label}</span>
                      </span>
                      <span className="font-semibold text-ink tabular-nums">{fmtPct2(dAlloc.values[i])}</span>
                    </div>
                  ) : null))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line-soft pt-3 text-xs text-ink-3">
                  <span>CAD {fmtPct2(dCcy.values[0])}</span>
                  <span>USD {fmtPct2(dCcy.values[1])}</span>
                  <span className="ml-auto">
                    Total <span className={`font-semibold ${ties ? "text-pos" : "text-neg"}`}>{fmtPct2(invested)}</span>
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      ) : <div />}

      {/* Performance Tracker — only shown for the PIM group. The
          onPerfDataChanged callback keeps THIS component's perfData in
          sync with whatever PimPerformance just loaded (initial load,
          auto-update, manual Refresh, or seed) so the Sleeve Drift
          card and Dynamic Wt column reflect the same data the chart
          is showing without needing a remount. */}
      {selectedGroup.id === "pim" ? (
        <PimPerformance
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          selectedProfile={activeProfile}
          onPerfDataChanged={handlePerfDataChanged}
        />
      ) : <div />}
      </div>

      {/* Sleeve Drift summary — Alpha Model and per-group Core sleeve
          returns since the most recent firm-wide rebalance. These are
          the inputs that drive the Dynamic Wt column. Shown on every
          profile including Alpha and Core so the SLR view in the
          performance chart has a matching summary card. */}
      {driftSummary.anchorDate && (
        <div className="rounded-card border border-line bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
            <h3 className="text-sm font-bold text-ink">Sleeve Drift</h3>
            <div className="flex items-baseline gap-3 text-xs text-ink-3">
              {perfAutoRefreshing ? (
                <span className="flex items-center gap-1 text-ink-3">
                  <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                  Refreshing prices...
                </span>
              ) : (
                perfData?.lastUpdated && (
                  <span>Last updated {formatPerfRelTime(perfData.lastUpdated)}</span>
                )
              )}
              <span>since rebalance · {driftSummary.anchorDate}</span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-control bg-surface-2 px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Alpha Model</div>
              <div className={`text-lg font-bold mt-1 ${
                driftSummary.alphaReturn == null ? "text-ink-faint"
                : driftSummary.alphaReturn > 0 ? "text-pos"
                : driftSummary.alphaReturn < 0 ? "text-neg"
                : "text-ink"
              }`}>
                {driftSummary.alphaReturn == null
                  ? "—"
                  : `${driftSummary.alphaReturn > 0 ? "+" : ""}${(driftSummary.alphaReturn * 100).toFixed(2)}%`}
              </div>
              <div className="text-[10px] text-ink-3 mt-0.5">PIM standalone alpha · firm-wide</div>
            </div>
            <div className="rounded-control bg-surface-2 px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Core Model</div>
              <div className={`text-lg font-bold mt-1 ${
                driftSummary.coreReturn == null ? "text-ink-faint"
                : driftSummary.coreReturn > 0 ? "text-pos"
                : driftSummary.coreReturn < 0 ? "text-neg"
                : "text-ink"
              }`}>
                {driftSummary.coreReturn == null
                  ? "—"
                  : `${driftSummary.coreReturn > 0 ? "+" : ""}${(driftSummary.coreReturn * 100).toFixed(2)}%`}
              </div>
              <div className="text-[10px] text-ink-3 mt-0.5">PIM standalone core ETFs · firm-wide</div>
            </div>
            <div className="rounded-control bg-surface-2 px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Spread (α − Core)</div>
              {driftSummary.alphaReturn != null && driftSummary.coreReturn != null ? (
                <>
                  <div className={`text-lg font-bold mt-1 ${
                    driftSummary.alphaReturn - driftSummary.coreReturn > 0 ? "text-pos"
                    : driftSummary.alphaReturn - driftSummary.coreReturn < 0 ? "text-neg"
                    : "text-ink"
                  }`}>
                    {driftSummary.alphaReturn - driftSummary.coreReturn > 0 ? "+" : ""}
                    {((driftSummary.alphaReturn - driftSummary.coreReturn) * 100).toFixed(2)}%
                  </div>
                  <div className="text-[10px] text-ink-3 mt-0.5">
                    {driftSummary.alphaReturn > driftSummary.coreReturn
                      ? "Alpha outperforming → Dynamic Wt tilts toward alpha holdings"
                      : driftSummary.alphaReturn < driftSummary.coreReturn
                      ? "Core outperforming → Dynamic Wt tilts toward core ETFs"
                      : "Sleeves matching → Dynamic Wt = Target Wt"}
                  </div>
                </>
              ) : (
                <div className="text-lg font-bold mt-1 text-ink-faint">—</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Holdings search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input type="text" value={holdingSearch} onChange={(e) => setHoldingSearch(e.target.value)} placeholder="Filter holdings..."
            className="w-full rounded-control border border-line bg-white pl-10 pr-4 py-2 text-sm outline-none placeholder:text-ink-3 focus:border-accent-border focus:ring-2 focus:ring-accent-border transition-all" />
        </div>
        <span className="text-xs text-ink-3">{computedHoldings.length} holdings</span>
      </div>

      {/* Holdings tables by asset class */}
      {(["fixedIncome", "equity", "alternative"] as PimAssetClass[]).map((ac) => {
        const holdings = sortHoldings(holdingsByClass[ac]);
        if (holdings.length === 0 && profileWeights && (
          (ac === "fixedIncome" && profileWeights.fixedIncome === 0) ||
          (ac === "alternative" && profileWeights.alternatives === 0)
        )) return null;

        const colors = ASSET_CLASS_COLORS[ac];

        // ── 2dp display weights ────────────────────────────────────────────
        // These numbers get typed into the modelling software, which takes two
        // decimals. Rounding each cell on its own makes the column miss its
        // total by a few hundredths (32 holdings at 1.82% round to 100.05%),
        // so each column is APPORTIONED instead: 2dp everywhere, and the
        // column still ties to its category total exactly.
        //
        // The tie-to-allocation only holds when the whole class is on screen —
        // with the holdings filter active the visible rows are a subset, so the
        // column ties to its own rounded sum instead of a total it isn't.
        const filterActive = holdingSearch.trim().length > 0;
        const classAlloc = profileWeights
          ? ac === "equity"
            ? profileWeights.equity
            : ac === "fixedIncome"
              ? profileWeights.fixedIncome
              : profileWeights.alternatives
          : undefined;
        // Tie each column to the class's REAL total, never to a forced 100%.
        //
        // Forcing it meant a sleeve that genuinely summed to 150% was rescaled
        // until it printed 100.00%, while the colour — computed from the true
        // sum — turned red. The number and its colour disagreed, and the
        // holding weights shown were rescaled fiction. A broken sleeve now
        // reads as broken.
        const rawClassSum = holdings.reduce((t, h) => t + h.weightInClass, 0);
        const tieTo = filterActive || classAlloc == null ? undefined : rawClassSum * classAlloc;
        const hasDynamic = holdings.some((h) => h.dynamicWeight != null);

        const dTarget = apportionColumn(holdings.map((h) => h.weightInPortfolio), tieTo);
        const dDynamic = apportionColumn(
          holdings.map((h) => h.dynamicWeight ?? null),
          hasDynamic ? tieTo : undefined,
        );
        const dCad = apportionColumn(holdings.map((h) => h.cadModelWeight));
        const dUsd = apportionColumn(holdings.map((h) => h.usdModelWeight));
        const dCheck = apportionColumn(holdings.map((h) => h.weightInClass), filterActive ? undefined : rawClassSum);

        return (
          <div key={ac} className="rounded-card border border-line bg-white shadow-sm overflow-hidden">
            <div className={`${colors.header} px-5 py-3 flex items-center justify-between`}>
              <h3 className="text-sm font-bold">
                {ASSET_CLASS_LABELS[ac]}
                <span className="ml-2 font-normal text-xs opacity-70">({holdings.length} holdings)</span>
              </h3>
              <div className="flex items-center gap-4 text-xs">
                <span>
                  Class Weight Check:{" "}
                  {/* Colour is driven by the number actually shown, so the two
                      can never contradict each other. */}
                  <span className={`font-semibold ${sameAtDisplay(dCheck.total, 1) ? "opacity-70" : "text-neg"}`}>
                    {fmtPct2(dCheck.total)}
                  </span>
                </span>
              </div>
            </div>
            {/* min-w so the eight weight columns scroll sideways on a phone
                instead of compressing into unreadable slivers; the container
                owns the overflow so the page never scrolls horizontally. */}
            <div className="max-w-full overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)]">
                  <tr className="border-b border-line-soft text-xs text-ink-3">
                    <th className={`text-left pl-5 pr-2 ${thClass}`} onClick={() => handleSort("name")}>
                      Name<SortIcon field="name" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-left ${thClass}`} onClick={() => handleSort("symbol")}>
                      Symbol<SortIcon field="symbol" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-center ${thClass}`} onClick={() => handleSort("currency")}>
                      Ccy<SortIcon field="currency" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("weightInPortfolio")}>
                      Target Wt<SortIcon field="weightInPortfolio" sortField={sortField} sortDir={sortDir} />
                    </th>
                    {activeProfile !== "alpha" && activeProfile !== "core" && (
                      <th
                        className="py-2.5 px-2 text-right text-xs font-semibold whitespace-nowrap"
                        title={dynamicWeightDiagnostic
                          ? `Dynamic Weight unavailable: ${dynamicWeightDiagnostic}`
                          : "Each holding's target weight scaled by sleeve drift since the most recent rebalance. Core sleeve floored at its target sum (and 50% of equity) so core positions never sell into a rebalance. Equity-only; FI/Alts unaffected."}
                      >
                        Dynamic Wt
                        {perfBackfilling && (
                          <span className="ml-1 font-normal text-[10px] text-ink-3">computing…</span>
                        )}
                        {!perfBackfilling && dynamicWeightDiagnostic && (
                          <>
                            <span className="ml-1 font-normal text-[9px] text-warn normal-case" title={dynamicWeightDiagnostic}>
                              ⓘ
                            </span>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                setPerfBackfilling(true);
                                try {
                                  const res = await fetch("/api/pim-performance", { method: "POST" });
                                  if (res.ok) setPerfData(await res.json() as PimPerformanceData);
                                } finally {
                                  setPerfBackfilling(false);
                                }
                              }}
                              className="ml-1 font-normal text-[9px] text-accent hover:underline normal-case"
                              title="Force a full recompute of pm:pim-performance"
                            >
                              recompute
                            </button>
                          </>
                        )}
                      </th>
                    )}
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("cadModelWeight")}>
                      CAD Model<SortIcon field="cadModelWeight" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("usdModelWeight")}>
                      USD Model<SortIcon field="usdModelWeight" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className="py-2.5 px-2 text-center text-xs font-semibold whitespace-nowrap w-16">Scoring</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr key={`${h.symbol}-${i}`} className={`border-b border-line-soft hover:bg-surface-hover transition-colors ${h.weightInPortfolio === 0 ? "opacity-40" : ""}`}>
                      <td className="py-2 pl-5 pr-2 font-medium text-ink truncate max-w-[200px]">
                        <Link href={`/stock/${symbolToTicker(h.symbol).toLowerCase()}?from=pim-model`} className="hover:underline hover:text-accent transition-colors">
                          {h.name}
                        </Link>
                      </td>
                      <td className="py-2 px-2 font-mono text-xs text-ink-2">
                        <span className="inline-flex items-center gap-1.5">
                          <Link href={`/stock/${symbolToTicker(h.symbol).toLowerCase()}?from=pim-model`} className="hover:underline hover:text-accent transition-colors">
                            {displayTicker(h.symbol)}
                          </Link>
                          {isLatestBuy(h.symbol) && (
                            <span
                              className="inline-flex items-center rounded-full bg-pos-soft px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-pos ring-1 ring-pos-border"
                              title="Purchased on the most recent buy day (firm-wide)"
                            >
                              NEW
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${h.currency === "CAD" ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"}`}>{h.currency}</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs font-semibold">{fmtPct2(dTarget.values[i])}</td>
                      {activeProfile !== "alpha" && activeProfile !== "core" && (
                        <td className="py-2 px-2 text-right font-mono text-xs">
                          {dDynamic.values[i] != null ? (
                            <span
                              className={
                                sameAtDisplay(dDynamic.values[i], dTarget.values[i])
                                  ? "text-ink"
                                  : (dDynamic.values[i] as number) > (dTarget.values[i] as number)
                                    ? "text-pos"
                                    : "text-neg"
                              }
                            >
                              {fmtPct2(dDynamic.values[i])}
                            </span>
                          ) : (
                            <span className="text-ink-faint">&mdash;</span>
                          )}
                        </td>
                      )}
                      <td className="py-2 px-2 text-right font-mono text-xs">{dCad.values[i] != null ? fmtPct2(dCad.values[i]) : <span className="text-ink-faint">&mdash;</span>}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{dUsd.values[i] != null ? fmtPct2(dUsd.values[i]) : <span className="text-ink-faint">&mdash;</span>}</td>
                      <td className="py-2 px-2 text-center">
                        {isInScoring(h.symbol) ? (
                          <span className="text-[10px] font-semibold text-pos">Added</span>
                        ) : (
                          <button
                            onClick={() => handleAddToScoring(h)}
                            disabled={addingToScoring === h.symbol}
                            className="rounded px-2 py-0.5 text-[10px] font-bold bg-accent-soft text-accent hover:bg-accent-soft transition-colors disabled:opacity-50"
                          >
                            {addingToScoring === h.symbol ? "..." : "+ Add"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr className={`${colors.bg} font-semibold`}>
                    <td className="py-2 pl-5 pr-2 text-xs text-ink-3" colSpan={3}>TOTAL</td>
                    <td className="py-2 px-2 text-right font-mono text-xs font-bold">{fmtPct2(dTarget.total)}</td>
                    {activeProfile !== "alpha" && activeProfile !== "core" && (
                      <td className="py-2 px-2 text-right font-mono text-xs font-bold">
                        {hasDynamic ? fmtPct2(dDynamic.total) : <span className="text-ink-faint">&mdash;</span>}
                      </td>
                    )}
                    <td className="py-2 px-2 text-right font-mono text-xs">{fmtPct2(dCad.total)}</td>
                    <td className="py-2 px-2 text-right font-mono text-xs">{fmtPct2(dUsd.total)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* Transaction History */}
      {isPimGroup && groupState.transactions.length > 0 && (
        <details className="rounded-card border border-line bg-white shadow-sm overflow-hidden">
          <summary className="px-5 py-3 text-sm font-bold text-ink cursor-pointer hover:bg-surface-2 transition-colors">
            Transaction History ({groupState.transactions.length})
          </summary>
          <div className="overflow-x-auto px-5 pb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-soft text-xs text-ink-3">
                  <th className="text-left py-2 font-semibold">Date</th>
                  <th className="text-left py-2 font-semibold">Type</th>
                  <th className="text-left py-2 font-semibold">Symbol</th>
                  <th className="text-center py-2 font-semibold">Direction</th>
                  <th className="text-right py-2 font-semibold">Price</th>
                  <th className="text-right py-2 font-semibold">Target Wt</th>
                  <th className="text-left py-2 font-semibold">Paired</th>
                </tr>
              </thead>
              <tbody>
                {[...groupState.transactions].reverse().slice(0, 50).map((t) => (
                  <tr key={t.id} className="border-b border-line-soft">
                    <td className="py-1.5 text-xs text-ink-2">{new Date(t.date).toLocaleDateString()}</td>
                    <td className="py-1.5 text-xs">
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold bg-surface-2 text-ink-2">{t.type}</span>
                    </td>
                    <td className="py-1.5 text-xs font-mono font-semibold">{displayTicker(t.symbol)}</td>
                    <td className="py-1.5 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${t.direction === "sell" ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"}`}>
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-1.5 text-xs text-right font-mono">${t.price.toFixed(2)}</td>
                    <td className="py-1.5 text-xs text-right font-mono">{fmtPct2(t.targetWeight)}</td>
                    <td className="py-1.5 text-xs text-ink-3">{t.pairedWith || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
