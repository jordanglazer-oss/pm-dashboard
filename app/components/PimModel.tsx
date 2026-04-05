"use client";

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { PimModelGroup, PimProfileType, PimComputedHolding, PimAssetClass, PimTransaction, PimPortfolioState } from "@/app/lib/pim-types";
import { useStocks } from "@/app/lib/StockContext";
import { PimPerformance } from "./PimPerformance";

type Props = {
  groups: PimModelGroup[];
};

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
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

type SortField = "name" | "symbol" | "currency" | "weightInClass" | "weightInPortfolio" | "liveWeight" | "cadModelWeight" | "usdModelWeight";
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

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function PimModel({ groups }: Props) {
  const { getGroupState, pimPortfolioState, updatePimPortfolioState, uiPrefs, setUiPref } = useStocks();
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || "");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("balanced");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState("");
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
  const [showRebalance, setShowRebalance] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const [rebalancePrices, setRebalancePrices] = useState<Record<string, string>>({});
  const [switchSell, setSwitchSell] = useState({ symbol: "", price: "" });
  const [switchBuy, setSwitchBuy] = useState({ symbol: "", price: "" });
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

  const availableProfiles = useMemo<PimProfileType[]>(() => {
    if (!selectedGroup) return [];
    return (["balanced", "growth", "allEquity"] as PimProfileType[]).filter(
      (p) => selectedGroup.profiles[p]
    );
  }, [selectedGroup]);

  const activeProfile = availableProfiles.includes(selectedProfile)
    ? selectedProfile
    : availableProfiles[0] || "balanced";

  const profileWeights = selectedGroup?.profiles[activeProfile];

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
    if (!selectedGroup || !profileWeights) return [];

    const holdings = selectedGroup.holdings;
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
  }, [selectedGroup, profileWeights, livePrices, groupState]);

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

  const hasLiveWeights = computedHoldings.some((h) => h.liveWeight != null);

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
        case "liveWeight": cmp = (a.liveWeight ?? -1) - (b.liveWeight ?? -1); break;
        case "cadModelWeight": cmp = (a.cadModelWeight ?? -1) - (b.cadModelWeight ?? -1); break;
        case "usdModelWeight": cmp = (a.usdModelWeight ?? -1) - (b.usdModelWeight ?? -1); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  };

  // ── Rebalance logic ──
  const rebalanceTrades = useMemo(() => {
    if (!hasLiveWeights) return [];
    return computedHoldings
      .filter((h) => h.liveWeight != null && h.weightInPortfolio > 0)
      .map((h) => ({
        symbol: h.symbol,
        name: h.name,
        target: h.weightInPortfolio,
        live: h.liveWeight!,
        drift: h.driftBps || 0,
        action: (h.driftBps || 0) > 0 ? "sell" as const : "buy" as const,
        currentPrice: h.currentPrice,
      }))
      .filter((t) => Math.abs(t.drift) >= 5) // only show if drift > 5 bps
      .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  }, [computedHoldings, hasLiveWeights]);

  const handleSetRebalance = useCallback(() => {
    // Set initial rebalance snapshot with current prices
    const prices: Record<string, number> = {};
    for (const h of computedHoldings) {
      if (h.currentPrice) prices[h.symbol] = h.currentPrice;
    }
    const updatedState: PimPortfolioState = {
      ...pimPortfolioState,
      groupStates: [
        ...pimPortfolioState.groupStates.filter((gs) => gs.groupId !== selectedGroupId),
        {
          ...groupState,
          lastRebalance: { date: new Date().toISOString(), prices },
          trackingStart: groupState.trackingStart || { date: new Date().toISOString().split("T")[0], prices },
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    updatePimPortfolioState(updatedState);
  }, [computedHoldings, pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState]);

  const handleExecuteRebalance = useCallback(() => {
    const transactions: PimTransaction[] = [];
    const newPrices: Record<string, number> = { ...(groupState.lastRebalance?.prices || {}) };

    for (const trade of rebalanceTrades) {
      const priceStr = rebalancePrices[trade.symbol];
      const price = parseFloat(priceStr);
      if (!price || isNaN(price)) continue;

      newPrices[trade.symbol] = price;
      transactions.push({
        id: generateId(),
        date: new Date().toISOString(),
        groupId: selectedGroupId,
        type: "rebalance",
        symbol: trade.symbol,
        direction: trade.action,
        price,
        targetWeight: trade.target,
      });
    }

    const updatedState: PimPortfolioState = {
      ...pimPortfolioState,
      groupStates: [
        ...pimPortfolioState.groupStates.filter((gs) => gs.groupId !== selectedGroupId),
        {
          ...groupState,
          lastRebalance: { date: new Date().toISOString(), prices: newPrices },
          transactions: [...groupState.transactions, ...transactions],
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    updatePimPortfolioState(updatedState);
    setShowRebalance(false);
    setRebalancePrices({});
    fetchPrices();
  }, [rebalanceTrades, rebalancePrices, pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState, fetchPrices]);

  // ── Buy/Sell Switch logic ──
  const handleExecuteSwitch = useCallback(() => {
    const sellPrice = parseFloat(switchSell.price);
    const buyPrice = parseFloat(switchBuy.price);
    if (!switchSell.symbol || !switchBuy.symbol || !sellPrice || !buyPrice) return;

    const sellHolding = computedHoldings.find((h) => h.symbol === switchSell.symbol);
    const buyHolding = computedHoldings.find((h) => h.symbol === switchBuy.symbol);

    const transactions: PimTransaction[] = [
      {
        id: generateId(),
        date: new Date().toISOString(),
        groupId: selectedGroupId,
        type: "switch",
        symbol: switchSell.symbol,
        direction: "sell",
        price: sellPrice,
        targetWeight: sellHolding?.weightInPortfolio || 0,
        pairedWith: switchBuy.symbol,
      },
      {
        id: generateId(),
        date: new Date().toISOString(),
        groupId: selectedGroupId,
        type: "switch",
        symbol: switchBuy.symbol,
        direction: "buy",
        price: buyPrice,
        targetWeight: buyHolding?.weightInPortfolio || 0,
        pairedWith: switchSell.symbol,
      },
    ];

    const newPrices = { ...(groupState.lastRebalance?.prices || {}) };
    newPrices[switchSell.symbol] = sellPrice;
    newPrices[switchBuy.symbol] = buyPrice;

    const updatedState: PimPortfolioState = {
      ...pimPortfolioState,
      groupStates: [
        ...pimPortfolioState.groupStates.filter((gs) => gs.groupId !== selectedGroupId),
        {
          ...groupState,
          lastRebalance: groupState.lastRebalance
            ? { ...groupState.lastRebalance, prices: newPrices }
            : { date: new Date().toISOString(), prices: newPrices },
          transactions: [...groupState.transactions, ...transactions],
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    updatePimPortfolioState(updatedState);
    setShowSwitch(false);
    setSwitchSell({ symbol: "", price: "" });
    setSwitchBuy({ symbol: "", price: "" });
    fetchPrices();
  }, [switchSell, switchBuy, computedHoldings, pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState, fetchPrices]);

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
          {!groupState.lastRebalance && (
            <button onClick={handleSetRebalance}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors">
              Set Initial Rebalance
            </button>
          )}
          {hasLiveWeights && (
            <button onClick={() => setShowRebalance(!showRebalance)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
              Rebalance
            </button>
          )}
          <button onClick={() => setShowSwitch(!showSwitch)}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors">
            Buy / Sell
          </button>
          {groupState.lastRebalance && (
            <span className="text-[10px] text-slate-400 ml-2">
              Last rebalance: {new Date(groupState.lastRebalance.date).toLocaleDateString()}
            </span>
          )}
        </div>
      )}

      {/* Rebalance Panel */}
      {showRebalance && isPimGroup && rebalanceTrades.length > 0 && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-3">Rebalance Trades</h3>
          <p className="text-xs text-slate-500 mb-3">Enter execution prices for each trade to rebalance back to model weights.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-emerald-200 text-xs text-slate-500">
                  <th className="text-left py-2 font-semibold">Symbol</th>
                  <th className="text-right py-2 font-semibold">Target</th>
                  <th className="text-right py-2 font-semibold">Live</th>
                  <th className="text-right py-2 font-semibold">Drift</th>
                  <th className="text-center py-2 font-semibold">Action</th>
                  <th className="text-right py-2 font-semibold">Mkt Price</th>
                  <th className="text-right py-2 font-semibold">Exec Price</th>
                </tr>
              </thead>
              <tbody>
                {rebalanceTrades.map((t) => (
                  <tr key={t.symbol} className="border-b border-emerald-100">
                    <td className="py-2 font-mono text-xs font-semibold">
                      <Link href={`/stock/${t.symbol.toLowerCase()}`} className="hover:underline hover:text-blue-600 transition-colors">
                        {t.symbol}
                      </Link>
                    </td>
                    <td className="py-2 text-right font-mono text-xs">{pct(t.target)}</td>
                    <td className="py-2 text-right font-mono text-xs">{pct(t.live)}</td>
                    <td className={`py-2 text-right font-mono text-xs font-semibold ${t.drift > 0 ? "text-emerald-600" : "text-red-500"}`}>
                      {t.drift > 0 ? "+" : ""}{t.drift}bp
                    </td>
                    <td className="py-2 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.action === "sell" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {t.action.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono text-xs text-slate-500">{t.currentPrice ? `$${t.currentPrice.toFixed(2)}` : "—"}</td>
                    <td className="py-2 text-right">
                      <input type="number" step="0.01" placeholder="Price"
                        value={rebalancePrices[t.symbol] || ""}
                        onChange={(e) => setRebalancePrices((p) => ({ ...p, [t.symbol]: e.target.value }))}
                        className="w-20 rounded border border-slate-200 px-2 py-1 text-xs text-right outline-none focus:border-emerald-300" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleExecuteRebalance}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
              Execute Rebalance
            </button>
            <button onClick={() => { setShowRebalance(false); setRebalancePrices({}); }}
              className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-300 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Buy/Sell Switch Panel */}
      {showSwitch && isPimGroup && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-3">Buy / Sell</h3>
          <p className="text-xs text-slate-500 mb-3">Sell one position and buy another with the proceeds. Enter execution prices.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-red-600 uppercase">Sell</label>
              <select value={switchSell.symbol} onChange={(e) => setSwitchSell((s) => ({ ...s, symbol: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300">
                <option value="">Select holding to sell...</option>
                {computedHoldings.filter((h) => h.weightInPortfolio > 0).map((h) => (
                  <option key={h.symbol} value={h.symbol}>{h.symbol} — {h.name}</option>
                ))}
              </select>
              <input type="number" step="0.01" placeholder="Sell price"
                value={switchSell.price} onChange={(e) => setSwitchSell((s) => ({ ...s, price: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-300" />
              {switchSell.symbol && livePrices[switchSell.symbol] && (
                <p className="text-[10px] text-slate-400">Market: ${livePrices[switchSell.symbol].toFixed(2)}</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-emerald-600 uppercase">Buy</label>
              <select value={switchBuy.symbol} onChange={(e) => setSwitchBuy((s) => ({ ...s, symbol: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300">
                <option value="">Select holding to buy...</option>
                {computedHoldings.filter((h) => h.weightInPortfolio > 0).map((h) => (
                  <option key={h.symbol} value={h.symbol}>{h.symbol} — {h.name}</option>
                ))}
              </select>
              <input type="number" step="0.01" placeholder="Buy price"
                value={switchBuy.price} onChange={(e) => setSwitchBuy((s) => ({ ...s, price: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-300" />
              {switchBuy.symbol && livePrices[switchBuy.symbol] && (
                <p className="text-[10px] text-slate-400">Market: ${livePrices[switchBuy.symbol].toFixed(2)}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleExecuteSwitch}
              disabled={!switchSell.symbol || !switchBuy.symbol || !switchSell.price || !switchBuy.price}
              className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 transition-colors disabled:opacity-50">
              Execute Trade
            </button>
            <button onClick={() => { setShowSwitch(false); setSwitchSell({ symbol: "", price: "" }); setSwitchBuy({ symbol: "", price: "" }); }}
              className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-300 transition-colors">
              Cancel
            </button>
          </div>
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
            <span>CAD Split: {(selectedGroup.cadSplit * 100).toFixed(1)}%</span>
            <span>USD Split: {(selectedGroup.usdSplit * 100).toFixed(1)}%</span>
            <span className="ml-auto">
              Portfolio Total: <span className={`font-semibold ${Math.abs(portfolioTotal - (profileWeights.fixedIncome + profileWeights.equity + profileWeights.alternatives)) < 0.001 ? "text-emerald-600" : "text-red-500"}`}>
                {pct(portfolioTotal)}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Performance Tracker */}
      <PimPerformance groupId={selectedGroup.id} groupName={selectedGroup.name} />

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
                    {hasLiveWeights && (
                      <th className={`text-right ${thClass}`} onClick={() => handleSort("liveWeight")}>
                        Live Wt<SortIcon field="liveWeight" sortField={sortField} sortDir={sortDir} />
                      </th>
                    )}
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("cadModelWeight")}>
                      CAD Model<SortIcon field="cadModelWeight" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-right pr-5 pl-2 ${thClass}`} onClick={() => handleSort("usdModelWeight")}>
                      USD Model<SortIcon field="usdModelWeight" sortField={sortField} sortDir={sortDir} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr key={`${h.symbol}-${i}`} className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${h.weightInPortfolio === 0 ? "opacity-40" : ""}`}>
                      <td className="py-2 pl-5 pr-2 font-medium text-slate-800 truncate max-w-[200px]">
                        <Link href={`/stock/${h.symbol.toLowerCase()}`} className="hover:underline hover:text-blue-600 transition-colors">
                          {h.name}
                        </Link>
                      </td>
                      <td className="py-2 px-2 font-mono text-xs text-slate-600">
                        <Link href={`/stock/${h.symbol.toLowerCase()}`} className="hover:underline hover:text-blue-600 transition-colors">
                          {h.symbol}
                        </Link>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${h.currency === "CAD" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>{h.currency}</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs font-semibold">{pctClean(h.weightInPortfolio)}</td>
                      {hasLiveWeights && (
                        <td className="py-2 px-2 text-right font-mono text-xs">
                          {h.liveWeight != null ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="font-semibold">{pctClean(h.liveWeight)}</span>
                              {h.driftBps != null && h.driftBps !== 0 && (
                                <span className={`text-[9px] font-bold ${h.driftBps > 0 ? "text-emerald-600" : "text-red-500"}`}>
                                  {h.driftBps > 0 ? "+" : ""}{h.driftBps}bp
                                </span>
                              )}
                            </span>
                          ) : <span className="text-slate-300">&mdash;</span>}
                        </td>
                      )}
                      <td className="py-2 px-2 text-right font-mono text-xs">{h.cadModelWeight != null ? pctClean(h.cadModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                      <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">{h.usdModelWeight != null ? pctClean(h.usdModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                    </tr>
                  ))}
                  <tr className={`${colors.bg} font-semibold`}>
                    <td className="py-2 pl-5 pr-2 text-xs text-slate-500" colSpan={3}>TOTAL</td>
                    <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(holdings.reduce((s, h) => s + h.weightInPortfolio, 0))}</td>
                    {hasLiveWeights && (
                      <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(holdings.filter((h) => h.liveWeight != null).reduce((s, h) => s + (h.liveWeight || 0), 0))}</td>
                    )}
                    <td className="py-2 px-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.cadModelWeight != null).reduce((s, h) => s + (h.cadModelWeight || 0), 0))}</td>
                    <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.usdModelWeight != null).reduce((s, h) => s + (h.usdModelWeight || 0), 0))}</td>
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
