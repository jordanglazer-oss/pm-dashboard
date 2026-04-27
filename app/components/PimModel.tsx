"use client";

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { PimModelGroup, PimProfileType, PimComputedHolding, PimAssetClass } from "@/app/lib/pim-types";
import type { Stock, InstrumentType, ScoreKey } from "@/app/lib/types";
import { useStocks } from "@/app/lib/StockContext";
import { PimPerformance } from "./PimPerformance";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
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

type Props = {
  groups: PimModelGroup[];
};

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
};

const ASSET_CLASS_LABELS: Record<PimAssetClass, string> = {
  fixedIncome: "Fixed Income",
  equity: "Equities",
  alternative: "Alternatives",
};

const ASSET_CLASS_COLORS: Record<PimAssetClass, { bg: string; text: string; bar: string; header: string }> = {
  fixedIncome: { bg: "bg-blue-50", text: "text-blue-700", bar: "bg-blue-500", header: "bg-blue-100 text-blue-800" },
  equity: { bg: "bg-emerald-50", text: "text-emerald-700", bar: "bg-emerald-500", header: "bg-emerald-100 text-emerald-800" },
  alternative: { bg: "bg-amber-50", text: "text-amber-700", bar: "bg-amber-500", header: "bg-amber-100 text-amber-800" },
};

function pct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function pctClean(v: number): string {
  const p = v * 100;
  if (p === 0) return "0.00%";
  return p.toFixed(2) + "%";
}

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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setDropdownSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
    const base = (["balanced", "growth", "allEquity"] as PimProfileType[]).filter(
      (p) => selectedGroup.profiles[p]
    );
    // Alpha is only available for the PIM group
    if (selectedGroup.id === "pim") {
      const hasEquity = selectedGroup.holdings.some((h) => h.assetClass === "equity");
      if (hasEquity) base.push("alpha");
    }
    return base;
  }, [selectedGroup]);

  const activeProfile = availableProfiles.includes(selectedProfile)
    ? selectedProfile
    : availableProfiles[0] || "balanced";

  // Alpha profile = virtual 100% equity; otherwise use stored profile weights
  const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = activeProfile === "alpha"
    ? ALPHA_WEIGHTS
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

    // Non-PIM groups: keep individual stock weights from PIM, excess to core ETFs by currency
    if (selectedGroup.id !== "pim" && pimGroup) {
      const pimWeightMap = new Map<string, number>();
      for (const h of pimGroup.holdings) {
        if (h.assetClass === "equity") pimWeightMap.set(h.symbol, h.weightInClass);
      }

      // Find which PIM equity holdings are missing from this group
      const groupSymbols = new Set(selectedGroup.holdings.map((h) => h.symbol));
      let cadMissing = 0;
      let usdMissing = 0;
      for (const h of pimGroup.holdings) {
        if (h.assetClass === "equity" && !groupSymbols.has(h.symbol)) {
          if (h.currency === "USD") usdMissing += h.weightInClass;
          else cadMissing += h.weightInClass;
        }
      }

      if (cadMissing > 0 || usdMissing > 0) {
        // Identify core ETFs in this group by currency
        const coreCad: string[] = [];
        const coreUsd: string[] = [];
        let coreCadTotal = 0;
        let coreUsdTotal = 0;
        for (const h of selectedGroup.holdings) {
          if (h.assetClass === "equity" && coreSymbols.has(symbolToTicker(h.symbol))) {
            const pimW = pimWeightMap.get(h.symbol) || h.weightInClass;
            if (h.currency === "USD") { coreUsd.push(h.symbol); coreUsdTotal += pimW; }
            else { coreCad.push(h.symbol); coreCadTotal += pimW; }
          }
        }

        const adjusted = selectedGroup.holdings.map((h) => {
          if (h.assetClass !== "equity") return h;

          // Non-core: use PIM weight
          const pimW = pimWeightMap.get(h.symbol);
          if (!coreSymbols.has(symbolToTicker(h.symbol))) {
            return pimW != null ? { ...h, weightInClass: pimW } : h;
          }

          // Core ETF: PIM weight + proportional share of missing stocks' weight
          const basePimW = pimW || h.weightInClass;
          const isUsd = h.currency === "USD";
          const missing = isUsd ? usdMissing : cadMissing;
          const bucketTotal = isUsd ? coreUsdTotal : coreCadTotal;
          const share = bucketTotal > 0 ? (basePimW / bucketTotal) * missing : 0;
          return { ...h, weightInClass: basePimW + share };
        });

        return { ...selectedGroup, holdings: adjusted };
      }
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

  const computedHoldings = useMemo<PimComputedHolding[]>(() => {
    if (!effectiveGroup || !profileWeights) return [];

    const holdings = effectiveGroup.holdings;
    const rebalancePriceMap = groupState.lastRebalance?.prices || {};

    // Pre-compute sums of weightInClass by (assetClass, currency) for normalization
    const classCurrencyTotals: Record<string, number> = {};
    holdings.forEach((h) => {
      const key = `${h.assetClass}:${h.currency}`;
      classCurrencyTotals[key] = (classCurrencyTotals[key] || 0) + h.weightInClass;
    });

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

      const cadTotal = classCurrencyTotals[`${h.assetClass}:CAD`] || 0;
      const usdTotal = classCurrencyTotals[`${h.assetClass}:USD`] || 0;
      const assetClassAllocation = x.assetClassAllocation;

      const cadModelWeight = h.currency === "CAD" && cadTotal > 0
        ? (h.weightInClass / cadTotal) * assetClassAllocation : null;
      const usdModelWeight = h.currency === "USD" && usdTotal > 0
        ? (h.weightInClass / usdTotal) * assetClassAllocation : null;

      // Live weight with drift
      let liveWeight: number | undefined;
      let driftBps: number | undefined;
      if (hasRebalance && portfolioGrowth > 0 && currentPrice && rebalPrice) {
        liveWeight = (weightInPortfolio * growthFactor) / portfolioGrowth;
        driftBps = Math.round((liveWeight - weightInPortfolio) * 10000);
      }

      return {
        ...h, weightInPortfolio, cadModelWeight, usdModelWeight,
        liveWeight, driftBps, currentPrice, rebalancePrice: rebalPrice,
      };
    });
  }, [effectiveGroup, profileWeights, livePrices, groupState]);

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

  const checkTotals = useMemo(() => {
    const totals: Record<PimAssetClass, number> = { fixedIncome: 0, equity: 0, alternative: 0 };
    computedHoldings.forEach((h) => { totals[h.assetClass] += h.weightInClass; });
    return totals;
  }, [computedHoldings]);

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

  const thClass = "py-2.5 px-2 font-semibold cursor-pointer select-none hover:text-slate-800 transition-colors whitespace-nowrap";
  const isPimGroup = ["pim", "pc-usa", "non-res", "no-us-situs"].includes(selectedGroup.id);

  return (
    <div className="space-y-5">
      {/* Header: Model selector + Profile tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {/* Model group dropdown */}
        <div className="flex-1 max-w-md" ref={dropdownRef}>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
            Model Group
          </label>
          <div className="relative">
            <button
              onClick={() => { setDropdownOpen(!dropdownOpen); setDropdownSearch(""); }}
              className="w-full flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-left outline-none hover:border-slate-300 focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
            >
              <span className="font-semibold text-slate-800">{selectedGroup.name}</span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="absolute z-30 mt-1 w-full rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden">
                <div className="p-2 border-b border-slate-100">
                  <input ref={searchInputRef} type="text" value={dropdownSearch} onChange={(e) => setDropdownSearch(e.target.value)}
                    placeholder="Search..." className="w-full rounded-lg border border-slate-100 bg-slate-50 px-3 py-1.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-200 focus:bg-white transition-all" />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredDropdownGroups.map((g) => (
                    <button key={g.id} onClick={() => { setSelectedGroupId(g.id); setDropdownOpen(false); setDropdownSearch(""); }}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition-colors flex items-center justify-between ${g.id === selectedGroupId ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}>
                      <span className={g.id === selectedGroupId ? "font-semibold" : ""}>{g.name}</span>
                      <span className="text-[10px] text-slate-400 uppercase">{Object.keys(g.profiles).map((p) => PROFILE_LABELS[p as PimProfileType]?.[0]).join(" / ")}</span>
                    </button>
                  ))}
                  {filteredDropdownGroups.length === 0 && <div className="px-4 py-3 text-sm text-slate-400 text-center">No models found</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Profile tabs */}
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {availableProfiles.map((p) => (
            <button key={p} onClick={() => setSelectedProfile(p)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${activeProfile === p ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Action Buttons (PIM groups only) */}
      {isPimGroup && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={fetchPrices} disabled={pricesLoading}
            className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-50">
            <svg className={`w-3.5 h-3.5 ${pricesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
            {pricesLoading ? "Loading..." : "Refresh Prices"}
          </button>
        </div>
      )}

      {/* Asset Allocation Summary */}
      {profileWeights && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-slate-800 mb-3">Asset Allocation</h2>
          <div className="flex h-10 rounded-xl overflow-hidden mb-4">
            {profileWeights.cash > 0 && (
              <div className="bg-slate-400 flex items-center justify-center text-xs font-semibold text-white" style={{ width: `${profileWeights.cash * 100}%` }}>
                {profileWeights.cash >= 0.05 && `${(profileWeights.cash * 100).toFixed(0)}%`}
              </div>
            )}
            {profileWeights.fixedIncome > 0 && (
              <div className="bg-blue-500 flex items-center justify-center text-xs font-semibold text-white" style={{ width: `${profileWeights.fixedIncome * 100}%` }}>
                {(profileWeights.fixedIncome * 100).toFixed(0)}%
              </div>
            )}
            <div className="bg-emerald-500 flex items-center justify-center text-xs font-semibold text-white" style={{ width: `${profileWeights.equity * 100}%` }}>
              {(profileWeights.equity * 100).toFixed(0)}%
            </div>
            {profileWeights.alternatives > 0 && (
              <div className="bg-amber-500 flex items-center justify-center text-xs font-semibold text-white" style={{ width: `${profileWeights.alternatives * 100}%` }}>
                {profileWeights.alternatives >= 0.03 && `${(profileWeights.alternatives * 100).toFixed(0)}%`}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-slate-50 p-3 text-center">
              <div className="text-[10px] font-semibold text-slate-400 uppercase">Cash</div>
              <div className="text-lg font-bold text-slate-700">{(profileWeights.cash * 100).toFixed(0)}%</div>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-center">
              <div className="text-[10px] font-semibold text-blue-500 uppercase">Fixed Income</div>
              <div className="text-lg font-bold text-blue-700">{(profileWeights.fixedIncome * 100).toFixed(0)}%</div>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 text-center">
              <div className="text-[10px] font-semibold text-emerald-500 uppercase">Equity</div>
              <div className="text-lg font-bold text-emerald-700">{(profileWeights.equity * 100).toFixed(0)}%</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3 text-center">
              <div className="text-[10px] font-semibold text-amber-500 uppercase">Alternatives</div>
              <div className="text-lg font-bold text-amber-700">{(profileWeights.alternatives * 100).toFixed(0)}%</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-400">
            <span>CAD Split: {(currencySplit.cad * 100).toFixed(1)}%</span>
            <span>USD Split: {(currencySplit.usd * 100).toFixed(1)}%</span>
            <span className="ml-auto">
              Portfolio Total: <span className={`font-semibold ${Math.abs(portfolioTotal - (profileWeights.fixedIncome + profileWeights.equity + profileWeights.alternatives)) < 0.001 ? "text-emerald-600" : "text-red-500"}`}>
                {pct(portfolioTotal)}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Performance Tracker — only shown for the PIM group */}
      {selectedGroup.id === "pim" && (
        <PimPerformance groupId={selectedGroup.id} groupName={selectedGroup.name} selectedProfile={activeProfile} />
      )}

      {/* Holdings search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input type="text" value={holdingSearch} onChange={(e) => setHoldingSearch(e.target.value)} placeholder="Filter holdings..."
            className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all" />
        </div>
        <span className="text-xs text-slate-400">{computedHoldings.length} holdings</span>
      </div>

      {/* Holdings tables by asset class */}
      {(["fixedIncome", "equity", "alternative"] as PimAssetClass[]).map((ac) => {
        const holdings = sortHoldings(holdingsByClass[ac]);
        if (holdings.length === 0 && profileWeights && (
          (ac === "fixedIncome" && profileWeights.fixedIncome === 0) ||
          (ac === "alternative" && profileWeights.alternatives === 0)
        )) return null;

        const colors = ASSET_CLASS_COLORS[ac];
        const classTotal = checkTotals[ac];

        return (
          <div key={ac} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className={`${colors.header} px-5 py-3 flex items-center justify-between`}>
              <h3 className="text-sm font-bold">
                {ASSET_CLASS_LABELS[ac]}
                <span className="ml-2 font-normal text-xs opacity-70">({holdings.length} holdings)</span>
              </h3>
              <div className="flex items-center gap-4 text-xs">
                <span>
                  Class Weight Check: <span className={`font-semibold ${Math.abs(classTotal - 1) < 0.001 ? "opacity-70" : "text-red-600"}`}>{pct(classTotal)}</span>
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-500">
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
                    <tr key={`${h.symbol}-${i}`} className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${h.weightInPortfolio === 0 ? "opacity-40" : ""}`}>
                      <td className="py-2 pl-5 pr-2 font-medium text-slate-800 truncate max-w-[200px]">
                        <Link href={`/stock/${symbolToTicker(h.symbol).toLowerCase()}?from=pim-model`} className="hover:underline hover:text-blue-600 transition-colors">
                          {h.name}
                        </Link>
                      </td>
                      <td className="py-2 px-2 font-mono text-xs text-slate-600">
                        <span className="inline-flex items-center gap-1.5">
                          <Link href={`/stock/${symbolToTicker(h.symbol).toLowerCase()}?from=pim-model`} className="hover:underline hover:text-blue-600 transition-colors">
                            {h.symbol}
                          </Link>
                          {isLatestBuy(h.symbol) && (
                            <span
                              className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200"
                              title="Purchased on the most recent buy day (firm-wide)"
                            >
                              NEW
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${h.currency === "CAD" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>{h.currency}</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs font-semibold">{pctClean(h.weightInPortfolio)}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{h.cadModelWeight != null ? pctClean(h.cadModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{h.usdModelWeight != null ? pctClean(h.usdModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                      <td className="py-2 px-2 text-center">
                        {isInScoring(h.symbol) ? (
                          <span className="text-[10px] font-semibold text-emerald-500">Added</span>
                        ) : (
                          <button
                            onClick={() => handleAddToScoring(h)}
                            disabled={addingToScoring === h.symbol}
                            className="rounded px-2 py-0.5 text-[10px] font-bold bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
                          >
                            {addingToScoring === h.symbol ? "..." : "+ Add"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr className={`${colors.bg} font-semibold`}>
                    <td className="py-2 pl-5 pr-2 text-xs text-slate-500" colSpan={3}>TOTAL</td>
                    <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(holdings.reduce((s, h) => s + h.weightInPortfolio, 0))}</td>
                    <td className="py-2 px-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.cadModelWeight != null).reduce((s, h) => s + (h.cadModelWeight || 0), 0))}</td>
                    <td className="py-2 px-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.usdModelWeight != null).reduce((s, h) => s + (h.usdModelWeight || 0), 0))}</td>
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
        <details className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <summary className="px-5 py-3 text-sm font-bold text-slate-800 cursor-pointer hover:bg-slate-50 transition-colors">
            Transaction History ({groupState.transactions.length})
          </summary>
          <div className="overflow-x-auto px-5 pb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-500">
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
                  <tr key={t.id} className="border-b border-slate-50">
                    <td className="py-1.5 text-xs text-slate-600">{new Date(t.date).toLocaleDateString()}</td>
                    <td className="py-1.5 text-xs">
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold bg-slate-100 text-slate-600">{t.type}</span>
                    </td>
                    <td className="py-1.5 text-xs font-mono font-semibold">{t.symbol}</td>
                    <td className="py-1.5 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${t.direction === "sell" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-1.5 text-xs text-right font-mono">${t.price.toFixed(2)}</td>
                    <td className="py-1.5 text-xs text-right font-mono">{pct(t.targetWeight)}</td>
                    <td className="py-1.5 text-xs text-slate-400">{t.pairedWith || "—"}</td>
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
