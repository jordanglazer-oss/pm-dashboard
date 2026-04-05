"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import type { PimModelGroup, PimProfileType, PimComputedHolding, PimAssetClass } from "@/app/lib/pim-types";
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
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || "");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("balanced");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState("");
  const [holdingSearch, setHoldingSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
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

  const computedHoldings = useMemo<PimComputedHolding[]>(() => {
    if (!selectedGroup || !profileWeights) return [];

    const holdings = selectedGroup.holdings;

    // Pre-compute sums of weightInClass by (assetClass, currency) for normalization
    const classCurrencyTotals: Record<string, number> = {};
    holdings.forEach((h) => {
      const key = `${h.assetClass}:${h.currency}`;
      classCurrencyTotals[key] = (classCurrencyTotals[key] || 0) + h.weightInClass;
    });

    return holdings.map((h) => {
      let assetClassAllocation = 0;
      if (h.assetClass === "fixedIncome") assetClassAllocation = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") assetClassAllocation = profileWeights.equity;
      else if (h.assetClass === "alternative") assetClassAllocation = profileWeights.alternatives;

      const weightInPortfolio = h.weightInClass * assetClassAllocation;

      // Normalize within each currency: each currency model independently
      // has the full asset class allocation. So within the CAD model,
      // equities always = equityAlloc, regardless of how many CAD vs USD holdings.
      const cadTotal = classCurrencyTotals[`${h.assetClass}:CAD`] || 0;
      const usdTotal = classCurrencyTotals[`${h.assetClass}:USD`] || 0;

      const cadModelWeight = h.currency === "CAD" && cadTotal > 0
        ? (h.weightInClass / cadTotal) * assetClassAllocation
        : null;
      const usdModelWeight = h.currency === "USD" && usdTotal > 0
        ? (h.weightInClass / usdTotal) * assetClassAllocation
        : null;

      return { ...h, weightInPortfolio, cadModelWeight, usdModelWeight };
    });
  }, [selectedGroup, profileWeights]);

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

  // Sort handler
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" || field === "symbol" || field === "currency" ? "asc" : "desc");
    }
  };

  // Sort holdings
  const sortHoldings = (list: PimComputedHolding[]): PimComputedHolding[] => {
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "symbol":
          cmp = a.symbol.localeCompare(b.symbol);
          break;
        case "currency":
          cmp = a.currency.localeCompare(b.currency);
          break;
        case "weightInClass":
          cmp = a.weightInClass - b.weightInClass;
          break;
        case "weightInPortfolio":
          cmp = a.weightInPortfolio - b.weightInPortfolio;
          break;
        case "cadModelWeight":
          cmp = (a.cadModelWeight ?? -1) - (b.cadModelWeight ?? -1);
          break;
        case "usdModelWeight":
          cmp = (a.usdModelWeight ?? -1) - (b.usdModelWeight ?? -1);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  };

  if (!selectedGroup) return null;

  const thClass = "py-2.5 px-2 font-semibold cursor-pointer select-none hover:text-slate-800 transition-colors whitespace-nowrap";

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
                {/* Search within dropdown */}
                <div className="p-2 border-b border-slate-100">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={dropdownSearch}
                    onChange={(e) => setDropdownSearch(e.target.value)}
                    placeholder="Search..."
                    className="w-full rounded-lg border border-slate-100 bg-slate-50 px-3 py-1.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-200 focus:bg-white transition-all"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredDropdownGroups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => {
                        setSelectedGroupId(g.id);
                        setDropdownOpen(false);
                        setDropdownSearch("");
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition-colors flex items-center justify-between ${
                        g.id === selectedGroupId ? "bg-blue-50 text-blue-700" : "text-slate-700"
                      }`}
                    >
                      <span className={g.id === selectedGroupId ? "font-semibold" : ""}>{g.name}</span>
                      <span className="text-[10px] text-slate-400 uppercase">
                        {Object.keys(g.profiles).map((p) => PROFILE_LABELS[p as PimProfileType]?.[0]).join(" / ")}
                      </span>
                    </button>
                  ))}
                  {filteredDropdownGroups.length === 0 && (
                    <div className="px-4 py-3 text-sm text-slate-400 text-center">No models found</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Profile tabs */}
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {availableProfiles.map((p) => (
            <button
              key={p}
              onClick={() => setSelectedProfile(p)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                activeProfile === p
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

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
          <input
            type="text"
            value={holdingSearch}
            onChange={(e) => setHoldingSearch(e.target.value)}
            placeholder="Filter holdings..."
            className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
          />
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
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("weightInClass")}>
                      Weight (Class)<SortIcon field="weightInClass" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("weightInPortfolio")}>
                      Weight (Portfolio)<SortIcon field="weightInPortfolio" sortField={sortField} sortDir={sortDir} />
                    </th>
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
                      <td className="py-2 pl-5 pr-2 font-medium text-slate-800 truncate max-w-[200px]">{h.name}</td>
                      <td className="py-2 px-2 font-mono text-xs text-slate-600">{h.symbol}</td>
                      <td className="py-2 px-2 text-center">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${h.currency === "CAD" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>{h.currency}</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{pctClean(h.weightInClass)}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs font-semibold">{pctClean(h.weightInPortfolio)}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{h.cadModelWeight != null ? pctClean(h.cadModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                      <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">{h.usdModelWeight != null ? pctClean(h.usdModelWeight) : <span className="text-slate-300">&mdash;</span>}</td>
                    </tr>
                  ))}
                  <tr className={`${colors.bg} font-semibold`}>
                    <td className="py-2 pl-5 pr-2 text-xs text-slate-500" colSpan={3}>TOTAL</td>
                    <td className="py-2 px-2 text-right font-mono text-xs">{pct(holdings.reduce((s, h) => s + h.weightInClass, 0))}</td>
                    <td className="py-2 px-2 text-right font-mono text-xs font-bold">{pct(holdings.reduce((s, h) => s + h.weightInPortfolio, 0))}</td>
                    <td className="py-2 px-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.cadModelWeight != null).reduce((s, h) => s + (h.cadModelWeight || 0), 0))}</td>
                    <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">{pct(holdings.filter((h) => h.usdModelWeight != null).reduce((s, h) => s + (h.usdModelWeight || 0), 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
