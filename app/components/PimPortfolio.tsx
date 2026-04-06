"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import type {
  PimModelGroup,
  PimProfileType,
  PimProfileWeights,
  PimPortfolioPositions,
  PimPosition,
} from "@/app/lib/pim-types";
import { useStocks } from "@/app/lib/StockContext";

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
};

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function fmtCurrency(v: number): string {
  return v.toLocaleString("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2 });
}

function fmtUnits(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtGainLoss(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

type SortField = "symbol" | "name" | "units" | "price" | "value" | "modelPct" | "currentPct" | "drift" | "gainLoss";
type SortDir = "asc" | "desc";

type HoldingRow = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  units: number;
  price: number;
  costBasis: number;
  value: number;
  costValue: number;
  modelPct: number;
  currentPct: number;
  driftPct: number;
  gainLoss: number;
  action: "BUY" | "SELL" | "HOLD";
};

type Props = {
  groups: PimModelGroup[];
};

export function PimPortfolio({ groups }: Props) {
  const { uiPrefs, setUiPref } = useStocks();

  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || "");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("allEquity");
  const [positions, setPositions] = useState<PimPortfolioPositions[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editPositions, setEditPositions] = useState<PimPosition[]>([]);
  const [editCash, setEditCash] = useState(0);
  const [saving, setSaving] = useState(false);

  const sortField = (uiPrefs["portfolioSort"] as SortField) || "value";
  const sortDir = (uiPrefs["portfolioSortDir"] as SortDir) || "desc";
  const setSortField = (f: SortField) => setUiPref("portfolioSort", f);
  const setSortDir = (d: SortDir) => setUiPref("portfolioSortDir", d);

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
    : availableProfiles[0] || "allEquity";

  const profileWeights = selectedGroup?.profiles[activeProfile];

  // Load positions from KV
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/kv/pim-positions");
        if (res.ok) {
          const data = await res.json();
          setPositions(data.portfolios || []);
        }
      } catch { /* ignore */ }
    }
    load();
  }, []);

  // Fetch live prices
  const fetchPrices = useCallback(async () => {
    if (!selectedGroup) return;
    setPricesLoading(true);
    const symbols = selectedGroup.holdings.map((h) => {
      if (h.symbol.endsWith("-T")) return h.symbol.replace("-T", ".TO");
      if (h.symbol.endsWith(".U")) return h.symbol.replace(".U", "-U.TO");
      return h.symbol;
    });
    try {
      const res = await fetch(`/api/prices?symbols=${encodeURIComponent(symbols.join(","))}`);
      if (res.ok) {
        const data = await res.json();
        const mapped: Record<string, number> = {};
        for (const h of selectedGroup.holdings) {
          let yahoo = h.symbol;
          if (h.symbol.endsWith("-T")) yahoo = h.symbol.replace("-T", ".TO");
          else if (h.symbol.endsWith(".U")) yahoo = h.symbol.replace(".U", "-U.TO");
          if (data.prices?.[yahoo]) mapped[h.symbol] = data.prices[yahoo];
          else if (data.prices?.[h.symbol]) mapped[h.symbol] = data.prices[h.symbol];
        }
        setLivePrices(mapped);
      }
    } catch { /* ignore */ }
    setPricesLoading(false);
  }, [selectedGroup]);

  useEffect(() => { fetchPrices(); }, [selectedGroupId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get positions for current group + profile
  const currentPositions = useMemo(() => {
    return positions.find(
      (p) => p.groupId === selectedGroupId && p.profile === activeProfile
    );
  }, [positions, selectedGroupId, activeProfile]);

  const positionMap = useMemo(() => {
    const map = new Map<string, PimPosition>();
    if (currentPositions) {
      for (const p of currentPositions.positions) {
        map.set(p.symbol, p);
      }
    }
    return map;
  }, [currentPositions]);

  // Compute holding rows
  const holdingRows = useMemo<HoldingRow[]>(() => {
    if (!selectedGroup || !profileWeights) return [];

    const rows: HoldingRow[] = [];
    let totalValue = currentPositions?.cashBalance || 0;

    // First pass: compute values
    const rawRows = selectedGroup.holdings.map((h) => {
      let assetAlloc = 0;
      if (h.assetClass === "fixedIncome") assetAlloc = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") assetAlloc = profileWeights.equity;
      else if (h.assetClass === "alternative") assetAlloc = profileWeights.alternatives;

      const modelPct = h.weightInClass * assetAlloc;
      const pos = positionMap.get(h.symbol);
      const units = pos?.units || 0;
      const costBasis = pos?.costBasis || 0;
      const price = livePrices[h.symbol] || 0;
      const value = units * price;
      const costValue = units * costBasis;

      totalValue += value;
      return { h, modelPct, units, costBasis, price, value, costValue };
    });

    // Second pass: compute current weights and actions
    for (const r of rawRows) {
      const currentPct = totalValue > 0 ? r.value / totalValue : 0;
      const driftPct = currentPct - r.modelPct;
      const gainLoss = r.costValue > 0 ? ((r.value - r.costValue) / r.costValue) * 100 : 0;

      let action: "BUY" | "SELL" | "HOLD" = "HOLD";
      const driftBps = Math.abs(driftPct * 10000);
      if (driftBps > 25) {
        action = driftPct < 0 ? "BUY" : "SELL";
      }

      rows.push({
        symbol: r.h.symbol,
        name: r.h.name,
        currency: r.h.currency,
        units: r.units,
        price: r.price,
        costBasis: r.costBasis,
        value: r.value,
        costValue: r.costValue,
        modelPct: r.modelPct,
        currentPct,
        driftPct,
        gainLoss,
        action,
      });
    }

    return rows;
  }, [selectedGroup, profileWeights, livePrices, positionMap, currentPositions]);

  // Sort
  const sortedRows = useMemo(() => {
    return [...holdingRows].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "symbol": cmp = a.symbol.localeCompare(b.symbol); break;
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "units": cmp = a.units - b.units; break;
        case "price": cmp = a.price - b.price; break;
        case "value": cmp = a.value - b.value; break;
        case "modelPct": cmp = a.modelPct - b.modelPct; break;
        case "currentPct": cmp = a.currentPct - b.currentPct; break;
        case "drift": cmp = a.driftPct - b.driftPct; break;
        case "gainLoss": cmp = a.gainLoss - b.gainLoss; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [holdingRows, sortField, sortDir]);

  // Summary
  const totalValue = useMemo(() => {
    const holdingsValue = holdingRows.reduce((s, r) => s + r.value, 0);
    return holdingsValue + (currentPositions?.cashBalance || 0);
  }, [holdingRows, currentPositions]);

  const totalCost = useMemo(() => {
    return holdingRows.reduce((s, r) => s + r.costValue, 0);
  }, [holdingRows]);

  const cashBalance = currentPositions?.cashBalance || 0;
  const cashPct = totalValue > 0 ? cashBalance / totalValue : 0;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "symbol" || field === "name" ? "asc" : "desc");
    }
  };

  // Edit mode: enter positions
  const startEdit = () => {
    const existing = currentPositions?.positions || [];
    const allSymbols = selectedGroup?.holdings.map((h) => h.symbol) || [];
    const editPos = allSymbols.map((sym) => {
      const ex = existing.find((p) => p.symbol === sym);
      return { symbol: sym, units: ex?.units || 0, costBasis: ex?.costBasis || 0 };
    });
    setEditPositions(editPos);
    setEditCash(currentPositions?.cashBalance || 0);
    setEditMode(true);
  };

  const savePositions = async () => {
    setSaving(true);
    const updated: PimPortfolioPositions = {
      groupId: selectedGroupId,
      profile: activeProfile,
      positions: editPositions.filter((p) => p.units > 0),
      cashBalance: editCash,
      lastUpdated: new Date().toISOString(),
    };

    // Merge with existing portfolios
    const other = positions.filter(
      (p) => !(p.groupId === selectedGroupId && p.profile === activeProfile)
    );
    const all = [...other, updated];
    setPositions(all);

    try {
      await fetch("/api/kv/pim-positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolios: all }),
      });
    } catch { /* ignore */ }

    setEditMode(false);
    setSaving(false);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="ml-0.5 text-slate-300">↕</span>;
    return <span className="ml-0.5 text-slate-600">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const hasPositions = holdingRows.some((r) => r.units > 0);
  const thClass = "py-2 px-2 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-bold uppercase tracking-wider text-slate-500 select-none whitespace-nowrap";

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Group selector */}
        {groups.length > 1 && (
          <select
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}

        {/* Profile tabs */}
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {availableProfiles.map((p) => (
            <button
              key={p}
              onClick={() => setSelectedProfile(p)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                activeProfile === p ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={fetchPrices}
            disabled={pricesLoading}
            className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-50"
          >
            <svg className={`w-3.5 h-3.5 ${pricesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
            Refresh Prices
          </button>
          <button
            onClick={editMode ? savePositions : startEdit}
            disabled={saving}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
              editMode ? "bg-emerald-500 text-white hover:bg-emerald-600" : "bg-blue-500 text-white hover:bg-blue-600"
            }`}
          >
            {editMode ? (saving ? "Saving..." : "Save Positions") : "Edit Positions"}
          </button>
          {editMode && (
            <button
              onClick={() => setEditMode(false)}
              className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-300 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Portfolio summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Total Value</div>
          <div className="text-lg font-bold text-slate-800">{fmtCurrency(totalValue)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Total Cost</div>
          <div className="text-lg font-bold text-slate-700">{fmtCurrency(totalCost)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Gain/Loss</div>
          <div className={`text-lg font-bold ${totalValue - totalCost >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {fmtCurrency(totalValue - totalCost)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Return</div>
          <div className={`text-lg font-bold ${totalCost > 0 && totalValue - totalCost >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {totalCost > 0 ? fmtGainLoss(((totalValue - totalCost) / totalCost) * 100) : "--"}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Cash</div>
          <div className="text-lg font-bold text-slate-700">{fmtCurrency(cashBalance)}</div>
          <div className="text-[9px] text-slate-400">{pct(cashPct)}</div>
        </div>
      </div>

      {/* Holdings table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className={`text-left ${thClass}`} onClick={() => handleSort("symbol")}>
                  Symbol<SortIcon field="symbol" />
                </th>
                <th className={`text-left ${thClass}`} onClick={() => handleSort("name")}>
                  Name<SortIcon field="name" />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("units")}>
                  Units<SortIcon field="units" />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("price")}>
                  Price<SortIcon field="price" />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("value")}>
                  Value<SortIcon field="value" />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("modelPct")}>
                  Model %<SortIcon field="modelPct" />
                </th>
                {hasPositions && (
                  <>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("currentPct")}>
                      Current %<SortIcon field="currentPct" />
                    </th>
                    <th className={`text-center ${thClass}`} onClick={() => handleSort("drift")}>
                      Action<SortIcon field="drift" />
                    </th>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("gainLoss")}>
                      Gain/Loss<SortIcon field="gainLoss" />
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {/* Cash row */}
              <tr className="border-b border-slate-50 bg-slate-25">
                <td className="py-2.5 px-2 font-semibold text-slate-700">Cash</td>
                <td className="py-2.5 px-2 text-slate-500">Cash &amp; Dividends</td>
                <td className="py-2.5 px-2 text-right" />
                <td className="py-2.5 px-2 text-right" />
                <td className="py-2.5 px-2 text-right font-mono font-semibold text-slate-700">
                  {editMode ? (
                    <input
                      type="number"
                      value={editCash || ""}
                      onChange={(e) => setEditCash(parseFloat(e.target.value) || 0)}
                      className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-xs font-mono"
                      step="0.01"
                    />
                  ) : (
                    fmtCurrency(cashBalance)
                  )}
                </td>
                <td className="py-2.5 px-2 text-right font-mono text-slate-500">{pct(cashPct)}</td>
                {hasPositions && (
                  <>
                    <td className="py-2.5 px-2 text-right font-mono text-slate-500">{pct(cashPct)}</td>
                    <td className="py-2.5 px-2 text-center">
                      <span className="inline-block rounded px-2 py-0.5 text-[9px] font-bold bg-slate-100 text-slate-500">HOLD</span>
                    </td>
                    <td className="py-2.5 px-2 text-right">-</td>
                  </>
                )}
              </tr>

              {sortedRows.map((row) => (
                <tr key={row.symbol} className="border-b border-slate-50 hover:bg-slate-25 transition-colors">
                  <td className="py-2.5 px-2 font-semibold text-slate-700">{row.symbol}</td>
                  <td className="py-2.5 px-2 text-slate-600 max-w-[200px] truncate">{row.name}</td>
                  <td className="py-2.5 px-2 text-right font-mono text-slate-700">
                    {editMode ? (
                      <input
                        type="number"
                        value={editPositions.find((p) => p.symbol === row.symbol)?.units || ""}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          setEditPositions((prev) =>
                            prev.map((p) => p.symbol === row.symbol ? { ...p, units: val } : p)
                          );
                        }}
                        className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-xs font-mono"
                        step="0.0001"
                      />
                    ) : (
                      row.units > 0 ? fmtUnits(row.units) : "-"
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono text-slate-700">
                    {row.price > 0 ? `$${row.price.toFixed(2)}` : "-"}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono font-semibold text-slate-700">
                    {editMode && (
                      <div className="mb-1">
                        <input
                          type="number"
                          value={editPositions.find((p) => p.symbol === row.symbol)?.costBasis || ""}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setEditPositions((prev) =>
                              prev.map((p) => p.symbol === row.symbol ? { ...p, costBasis: val } : p)
                            );
                          }}
                          className="w-20 rounded border border-slate-200 px-2 py-1 text-right text-xs font-mono"
                          step="0.01"
                          placeholder="Cost"
                        />
                      </div>
                    )}
                    {row.value > 0 ? fmtCurrency(row.value) : "-"}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono text-slate-600">{pct(row.modelPct)}</td>
                  {hasPositions && (
                    <>
                      <td className="py-2.5 px-2 text-right font-mono text-slate-700">{row.units > 0 ? pct(row.currentPct) : "-"}</td>
                      <td className="py-2.5 px-2 text-center">
                        {row.units > 0 ? (
                          <span className={`inline-block rounded px-2 py-0.5 text-[9px] font-bold ${
                            row.action === "BUY" ? "bg-emerald-50 text-emerald-600" :
                            row.action === "SELL" ? "bg-red-50 text-red-500" :
                            "bg-slate-100 text-slate-500"
                          }`}>
                            {row.action}
                          </span>
                        ) : (
                          <span className="inline-block rounded px-2 py-0.5 text-[9px] font-bold bg-emerald-50 text-emerald-600">BUY</span>
                        )}
                      </td>
                      <td className={`py-2.5 px-2 text-right font-mono font-semibold ${row.gainLoss >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                        {row.units > 0 ? fmtGainLoss(row.gainLoss) : "-"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* No positions prompt */}
      {!hasPositions && !editMode && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <p className="text-sm text-slate-500 mb-2">No position data entered yet.</p>
          <p className="text-xs text-slate-400 mb-4">
            Enter your current holdings (units and cost basis) to see current weights, drift, and rebalance actions.
          </p>
          <button
            onClick={startEdit}
            className="rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors"
          >
            Enter Positions
          </button>
        </div>
      )}
    </div>
  );
}
