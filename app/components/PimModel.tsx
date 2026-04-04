"use client";

import React, { useState, useMemo } from "react";
import type { PimModelGroup, PimProfileType, PimComputedHolding, PimAssetClass } from "@/app/lib/pim-types";

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

export function PimModel({ groups }: Props) {
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || "");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("balanced");
  const [searchQuery, setSearchQuery] = useState("");
  const [holdingSearch, setHoldingSearch] = useState("");

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

  // Reset profile if current one isn't available
  const activeProfile = availableProfiles.includes(selectedProfile)
    ? selectedProfile
    : availableProfiles[0] || "balanced";

  const profileWeights = selectedGroup?.profiles[activeProfile];

  // Compute holdings with portfolio weights
  const computedHoldings = useMemo<PimComputedHolding[]>(() => {
    if (!selectedGroup || !profileWeights) return [];

    return selectedGroup.holdings.map((h) => {
      let assetClassAllocation = 0;
      if (h.assetClass === "fixedIncome") assetClassAllocation = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") assetClassAllocation = profileWeights.equity;
      else if (h.assetClass === "alternative") assetClassAllocation = profileWeights.alternatives;

      const weightInPortfolio = h.weightInClass * assetClassAllocation;

      // CAD/USD model weights
      const cadModelWeight = h.currency === "CAD"
        ? weightInPortfolio / (selectedGroup.cadSplit || 0.5)
        : null;
      const usdModelWeight = h.currency === "USD"
        ? weightInPortfolio / (selectedGroup.usdSplit || 0.5)
        : null;

      return {
        ...h,
        weightInPortfolio,
        cadModelWeight,
        usdModelWeight,
      };
    });
  }, [selectedGroup, profileWeights]);

  // Filter holdings by search
  const filteredHoldings = useMemo(() => {
    if (!holdingSearch.trim()) return computedHoldings;
    const q = holdingSearch.toLowerCase();
    return computedHoldings.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.symbol.toLowerCase().includes(q)
    );
  }, [computedHoldings, holdingSearch]);

  // Group holdings by asset class
  const holdingsByClass = useMemo(() => {
    const grouped: Record<PimAssetClass, PimComputedHolding[]> = {
      fixedIncome: [],
      equity: [],
      alternative: [],
    };
    filteredHoldings.forEach((h) => {
      grouped[h.assetClass].push(h);
    });
    return grouped;
  }, [filteredHoldings]);

  // Filtered groups for the selector
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groups;
    const q = searchQuery.toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, searchQuery]);

  // Check totals
  const checkTotals = useMemo(() => {
    const totals: Record<PimAssetClass, number> = { fixedIncome: 0, equity: 0, alternative: 0 };
    computedHoldings.forEach((h) => {
      totals[h.assetClass] += h.weightInClass;
    });
    return totals;
  }, [computedHoldings]);

  const portfolioTotal = useMemo(
    () => computedHoldings.reduce((sum, h) => sum + h.weightInPortfolio, 0),
    [computedHoldings]
  );

  if (!selectedGroup) return null;

  return (
    <div className="space-y-5">
      {/* Header row: Model selector + Profile tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {/* Model selector */}
        <div className="flex-1 max-w-md">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
            Model Group
          </label>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
              onFocus={() => setSearchQuery("")}
            />
            {searchQuery === "" && (
              <div className="pointer-events-none absolute inset-0 flex items-center px-4">
                <span className="text-sm font-semibold text-slate-800">{selectedGroup.name}</span>
              </div>
            )}
          </div>
          {searchQuery !== "" && filteredGroups.length > 0 && (
            <div className="absolute z-20 mt-1 w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden">
              {filteredGroups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setSelectedGroupId(g.id);
                    setSearchQuery("");
                  }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition-colors ${
                    g.id === selectedGroupId ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-700"
                  }`}
                >
                  {g.name}
                  <span className="ml-2 text-xs text-slate-400">
                    {Object.keys(g.profiles).length} profiles
                  </span>
                </button>
              ))}
            </div>
          )}
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
              <div
                className="bg-slate-400 flex items-center justify-center text-xs font-semibold text-white"
                style={{ width: `${profileWeights.cash * 100}%` }}
              >
                {profileWeights.cash >= 0.05 && `${(profileWeights.cash * 100).toFixed(0)}%`}
              </div>
            )}
            {profileWeights.fixedIncome > 0 && (
              <div
                className="bg-blue-500 flex items-center justify-center text-xs font-semibold text-white"
                style={{ width: `${profileWeights.fixedIncome * 100}%` }}
              >
                {(profileWeights.fixedIncome * 100).toFixed(0)}%
              </div>
            )}
            <div
              className="bg-emerald-500 flex items-center justify-center text-xs font-semibold text-white"
              style={{ width: `${profileWeights.equity * 100}%` }}
            >
              {(profileWeights.equity * 100).toFixed(0)}%
            </div>
            {profileWeights.alternatives > 0 && (
              <div
                className="bg-amber-500 flex items-center justify-center text-xs font-semibold text-white"
                style={{ width: `${profileWeights.alternatives * 100}%` }}
              >
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
          <div className="mt-3 flex items-center gap-4 text-xs text-slate-400">
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
        <span className="text-xs text-slate-400">
          {computedHoldings.length} holdings
        </span>
      </div>

      {/* Holdings tables by asset class */}
      {(["fixedIncome", "equity", "alternative"] as PimAssetClass[]).map((ac) => {
        const holdings = holdingsByClass[ac];
        if (holdings.length === 0 && profileWeights && (
          (ac === "fixedIncome" && profileWeights.fixedIncome === 0) ||
          (ac === "alternative" && profileWeights.alternatives === 0)
        )) {
          return null;
        }

        const colors = ASSET_CLASS_COLORS[ac];
        const classTotal = checkTotals[ac];

        return (
          <div key={ac} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            {/* Section header */}
            <div className={`${colors.header} px-5 py-3 flex items-center justify-between`}>
              <h3 className="text-sm font-bold">
                {ASSET_CLASS_LABELS[ac]}
                <span className="ml-2 font-normal text-xs opacity-70">
                  ({holdings.length} holdings)
                </span>
              </h3>
              <div className="flex items-center gap-4 text-xs">
                <span>
                  Class Weight Check: <span className={`font-semibold ${Math.abs(classTotal - 1) < 0.001 ? "opacity-70" : "text-red-600"}`}>
                    {pct(classTotal)}
                  </span>
                </span>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-500">
                    <th className="text-left py-2.5 pl-5 pr-2 font-semibold">Name</th>
                    <th className="text-left py-2.5 px-2 font-semibold">Symbol</th>
                    <th className="text-center py-2.5 px-2 font-semibold">Ccy</th>
                    <th className="text-right py-2.5 px-2 font-semibold">Weight (Class)</th>
                    <th className="text-right py-2.5 px-2 font-semibold">Weight (Portfolio)</th>
                    <th className="text-right py-2.5 px-2 font-semibold">CAD Model</th>
                    <th className="text-right py-2.5 pr-5 pl-2 font-semibold">USD Model</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr
                      key={`${h.symbol}-${i}`}
                      className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${
                        h.weightInPortfolio === 0 ? "opacity-40" : ""
                      }`}
                    >
                      <td className="py-2 pl-5 pr-2 font-medium text-slate-800 truncate max-w-[200px]">
                        {h.name}
                      </td>
                      <td className="py-2 px-2 font-mono text-xs text-slate-600">
                        {h.symbol}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          h.currency === "CAD" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
                        }`}>
                          {h.currency}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {pctClean(h.weightInClass)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs font-semibold">
                        {pctClean(h.weightInPortfolio)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {h.cadModelWeight != null ? pctClean(h.cadModelWeight) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">
                        {h.usdModelWeight != null ? pctClean(h.usdModelWeight) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr className={`${colors.bg} font-semibold`}>
                    <td className="py-2 pl-5 pr-2 text-xs text-slate-500" colSpan={3}>
                      TOTAL
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-xs">
                      {pct(holdings.reduce((s, h) => s + h.weightInClass, 0))}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-xs font-bold">
                      {pct(holdings.reduce((s, h) => s + h.weightInPortfolio, 0))}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-xs">
                      {pct(holdings.filter((h) => h.cadModelWeight != null).reduce((s, h) => s + (h.cadModelWeight || 0), 0))}
                    </td>
                    <td className="py-2 pr-5 pl-2 text-right font-mono text-xs">
                      {pct(holdings.filter((h) => h.usdModelWeight != null).reduce((s, h) => s + (h.usdModelWeight || 0), 0))}
                    </td>
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
