"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type {
  PimModelGroup,
  PimProfileType,
  PimProfileWeights,
  PimPortfolioPositions,
  PimPosition,
  PimTransaction,
  PimPortfolioState,
} from "@/app/lib/pim-types";
import type { Stock, InstrumentType, ScoreKey } from "@/app/lib/types";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};
import { useStocks } from "@/app/lib/StockContext";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function symbolToTicker(symbol: string): string {
  if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
  return symbol;
}

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
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

type SortField = "symbol" | "name" | "units" | "price" | "value" | "acb" | "modelPct" | "currentPct" | "drift" | "gainLoss";
type SortDir = "asc" | "desc";

type HoldingRow = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  units: number;
  price: number;        // market price in instrument currency
  priceCad: number;     // market price converted to CAD
  costBasis: number;    // cost per unit in CAD (user inputs in CAD)
  costBasisCad: number; // same as costBasis (no FX conversion needed)
  value: number;        // market value in instrument currency
  valueCad: number;     // market value in CAD (for weight calculation)
  costValue: number;    // total cost in instrument currency
  costValueCad: number; // total cost in CAD (ACB)
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
  const { uiPrefs, setUiPref, stocks, pimPortfolioState, updatePimPortfolioState, getGroupState, addStock, scoredStocks } = useStocks();

  const selectedGroupId = "pim";
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("allEquity");
  const [positions, setPositions] = useState<PimPortfolioPositions[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [prevCloses, setPrevCloses] = useState<Record<string, number>>({});
  const [usdCadRate, setUsdCadRate] = useState<number>(1.0);
  const [pricesLoading, setPricesLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editPositions, setEditPositions] = useState<PimPosition[]>([]);
  const [editCash, setEditCash] = useState(0);
  const [saving, setSaving] = useState(false);

  // Rebalance & Buy/Sell state
  const [showRebalance, setShowRebalance] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const [rebalancePrices, setRebalancePrices] = useState<Record<string, string>>({});
  const [switchSell, setSwitchSell] = useState({ symbol: "", price: "" });
  const [switchBuy, setSwitchBuy] = useState({ symbol: "", price: "", ticker: "", name: "", resolving: false });

  const sortField = (uiPrefs["portfolioSort"] as SortField) || "value";
  const sortDir = (uiPrefs["portfolioSortDir"] as SortDir) || "desc";
  const setSortField = (f: SortField) => setUiPref("portfolioSort", f);
  const setSortDir = (d: SortDir) => setUiPref("portfolioSortDir", d);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || groups[0],
    [groups, selectedGroupId]
  );

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
    : availableProfiles[0] || "allEquity";

  // Alpha profile = virtual 100% equity; otherwise use stored profile weights
  const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = activeProfile === "alpha"
    ? ALPHA_WEIGHTS
    : selectedGroup?.profiles[activeProfile];

  // For alpha: equity-only, keep individual stock weights unchanged,
  // redistribute ineligible/non-equity weight to core ETFs by currency
  const effectiveGroup = useMemo(() => {
    if (!selectedGroup) return selectedGroup;
    if (activeProfile !== "alpha") return selectedGroup;

    const equityHoldings = selectedGroup.holdings.filter((h) => h.assetClass === "equity");

    // Compute excess weight from non-equity holdings (bonds, alternatives)
    const equityTotal = equityHoldings.reduce((s, h) => s + h.weightInClass, 0);
    const excessWeight = Math.max(0, 1 - equityTotal);

    // Split excess by currency of the ineligible holdings
    let cadExcess = 0;
    let usdExcess = 0;
    for (const h of selectedGroup.holdings) {
      if (h.assetClass !== "equity") {
        if (h.currency === "USD") usdExcess += h.weightInClass;
        else cadExcess += h.weightInClass;
      }
    }
    const nonEquityTotal = cadExcess + usdExcess;
    if (nonEquityTotal > 0 && excessWeight > 0) {
      const scale = excessWeight / nonEquityTotal;
      cadExcess *= scale;
      usdExcess *= scale;
    }

    // Identify core ETFs that will absorb excess weight
    const coreEtfs = { cad: [] as typeof equityHoldings, usd: [] as typeof equityHoldings };
    for (const h of equityHoldings) {
      if (coreSymbols.has(symbolToTicker(h.symbol))) {
        if (h.currency === "USD") coreEtfs.usd.push(h);
        else coreEtfs.cad.push(h);
      }
    }

    // Build final holdings: alpha stocks keep original weights, core ETFs absorb excess
    const adjusted = equityHoldings.map((h) => {
      if (!coreSymbols.has(symbolToTicker(h.symbol))) return h;

      const isUsd = h.currency === "USD";
      const bucket = isUsd ? coreEtfs.usd : coreEtfs.cad;
      const bucketExcess = isUsd ? usdExcess : cadExcess;
      if (bucket.length === 0 || bucketExcess <= 0) return h;

      const bucketTotal = bucket.reduce((s, e) => s + e.weightInClass, 0);
      const share = bucketTotal > 0 ? (h.weightInClass / bucketTotal) * bucketExcess : 0;
      return { ...h, weightInClass: h.weightInClass + share };
    });

    return { ...selectedGroup, holdings: adjusted };
  }, [selectedGroup, activeProfile, coreSymbols]);

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

  // Fetch live prices: use StockContext prices first (from Scoring page), then fetch remaining
  const fetchPrices = useCallback(async () => {
    if (!selectedGroup) return;
    setPricesLoading(true);

    const mapped: Record<string, number> = {};
    const needsFetch: string[] = [];

    // First: pull prices from StockContext (already fetched on Scoring page)
    for (const h of selectedGroup.holdings) {
      const ticker = h.symbol.endsWith("-T") ? h.symbol.replace("-T", ".TO") : h.symbol;
      const stock = stocks.find(
        (s) => s.ticker === ticker || s.ticker === h.symbol || s.ticker.replace("-T", ".TO") === ticker
      );
      if (stock?.price != null && stock.price > 0) {
        mapped[h.symbol] = stock.price;
      } else {
        needsFetch.push(h.symbol);
      }
    }

    // Fetch all holdings from /api/prices (for previousClose data + missing prices)
    const allSymbols = selectedGroup.holdings.map((h) => h.symbol);
    const prevCloseMapped: Record<string, number> = {};
    try {
      const tickers = allSymbols.map((s) => {
        if (s.endsWith("-T")) return s.replace("-T", ".TO");
        if (s.endsWith(".U")) return s.replace(".U", "-U.TO");
        return s;
      });
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (res.ok) {
        const data = await res.json();
        for (const h of allSymbols) {
          let yahoo = h;
          if (h.endsWith("-T")) yahoo = h.replace("-T", ".TO");
          else if (h.endsWith(".U")) yahoo = h.replace(".U", "-U.TO");
          // Always use fresh prices from API (override StockContext cache)
          const freshPrice = data.prices?.[yahoo] ?? data.prices?.[h];
          if (freshPrice != null) mapped[h] = freshPrice;
          // Capture previous close
          const pc = data.previousCloses?.[yahoo] ?? data.previousCloses?.[h];
          if (pc != null) prevCloseMapped[h] = pc;
        }
      }
    } catch { /* ignore */ }

    setLivePrices(mapped);
    setPrevCloses(prevCloseMapped);

    // Fetch USD/CAD rate
    try {
      const fxRes = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: ["USDCAD=X"] }),
      });
      if (fxRes.ok) {
        const fxData = await fxRes.json();
        const rate = fxData.prices?.["USDCAD=X"];
        if (rate && rate > 0) setUsdCadRate(rate);
      }
    } catch { /* ignore */ }

    setPricesLoading(false);
  }, [selectedGroup, stocks]);

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

  // Shared costBasis across all profiles in this group
  const sharedCostBasisMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      if (p.groupId !== selectedGroupId) continue;
      for (const pos of p.positions) {
        if (pos.costBasis > 0 && !map.has(pos.symbol)) {
          map.set(pos.symbol, pos.costBasis);
        }
      }
    }
    return map;
  }, [positions, selectedGroupId]);

  // Compute holding rows
  const holdingRows = useMemo<HoldingRow[]>(() => {
    if (!effectiveGroup || !profileWeights) return [];

    const rows: HoldingRow[] = [];
    // Cash is always CAD
    let totalValueCad = currentPositions?.cashBalance || 0;

    // First pass: compute values (all in CAD for weight calculation)
    const rawRows = effectiveGroup.holdings.map((h) => {
      let assetAlloc = 0;
      if (h.assetClass === "fixedIncome") assetAlloc = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") assetAlloc = profileWeights.equity;
      else if (h.assetClass === "alternative") assetAlloc = profileWeights.alternatives;

      const modelPct = h.weightInClass * assetAlloc;
      const pos = positionMap.get(h.symbol);
      const units = pos?.units || 0;
      // ACB shared across profiles: use position's costBasis, fallback to any profile in group
      const costBasis = pos?.costBasis || sharedCostBasisMap.get(h.symbol) || 0;
      const price = livePrices[h.symbol] || 0; // in instrument currency
      const fxRate = h.currency === "USD" ? usdCadRate : 1;
      const priceCad = price * fxRate;
      const costBasisCad = costBasis; // already entered in CAD by user
      const value = units * price; // in instrument currency
      const valueCad = units * priceCad; // in CAD
      const costValue = units * costBasis; // in CAD (input is CAD)
      const costValueCad = units * costBasisCad; // ACB in CAD

      totalValueCad += valueCad;
      return { h, modelPct, units, costBasis, costBasisCad, price, priceCad, value, valueCad, costValue, costValueCad, fxRate };
    });

    // Filter out holdings with 0% model weight for this profile
    const activeRows = rawRows.filter((r) => r.modelPct > 0);

    // Second pass: compute current weights (based on CAD values) and actions
    for (const r of activeRows) {
      const currentPct = totalValueCad > 0 ? r.valueCad / totalValueCad : 0;
      const driftPct = currentPct - r.modelPct;
      const gainLoss = r.costValueCad > 0 ? ((r.valueCad - r.costValueCad) / r.costValueCad) * 100 : 0;

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
        priceCad: r.priceCad,
        costBasis: r.costBasis,
        costBasisCad: r.costBasisCad,
        value: r.value,
        valueCad: r.valueCad,
        costValue: r.costValue,
        costValueCad: r.costValueCad,
        modelPct: r.modelPct,
        currentPct,
        driftPct,
        gainLoss,
        action,
      });
    }

    return rows;
  }, [effectiveGroup, profileWeights, livePrices, positionMap, currentPositions, usdCadRate, sharedCostBasisMap]);

  // Sort
  const sortedRows = useMemo(() => {
    return [...holdingRows].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "symbol": cmp = a.symbol.localeCompare(b.symbol); break;
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "units": cmp = a.units - b.units; break;
        case "price": cmp = a.price - b.price; break;
        case "value": cmp = a.valueCad - b.valueCad; break;
        case "acb": cmp = a.costValueCad - b.costValueCad; break;
        case "modelPct": cmp = a.modelPct - b.modelPct; break;
        case "currentPct": cmp = a.currentPct - b.currentPct; break;
        case "drift": cmp = a.driftPct - b.driftPct; break;
        case "gainLoss": cmp = a.gainLoss - b.gainLoss; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [holdingRows, sortField, sortDir]);

  // Summary (all in CAD)
  const totalValueCadSummary = useMemo(() => {
    const holdingsValue = holdingRows.reduce((s, r) => s + r.valueCad, 0);
    return holdingsValue + (currentPositions?.cashBalance || 0);
  }, [holdingRows, currentPositions]);

  const totalCostCad = useMemo(() => {
    return holdingRows.reduce((s, r) => s + r.costValueCad, 0);
  }, [holdingRows]);

  const cashBalance = currentPositions?.cashBalance || 0;
  const cashPct = totalValueCadSummary > 0 ? cashBalance / totalValueCadSummary : 0;

  // Today's return: weighted sum of each holding's daily % change (prev close → current price)
  const todayReturn = useMemo(() => {
    if (holdingRows.length === 0) return null;
    let prevTotalCad = 0;
    let currTotalCad = 0;
    for (const r of holdingRows) {
      const pc = prevCloses[r.symbol];
      if (pc == null || pc <= 0 || r.units <= 0) continue;
      const fxRate = r.currency === "USD" ? usdCadRate : 1;
      prevTotalCad += r.units * pc * fxRate;
      currTotalCad += r.units * r.price * fxRate;
    }
    if (prevTotalCad <= 0) return null;
    return ((currTotalCad - prevTotalCad) / prevTotalCad) * 100;
  }, [holdingRows, prevCloses, usdCadRate]);

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
    // Build shared costBasis from ALL profiles in this group (ACB is cross-profile)
    const sharedCostBasis = new Map<string, number>();
    for (const p of positions) {
      if (p.groupId !== selectedGroupId) continue;
      for (const pos of p.positions) {
        if (pos.costBasis > 0 && !sharedCostBasis.has(pos.symbol)) {
          sharedCostBasis.set(pos.symbol, pos.costBasis);
        }
      }
    }
    const allSymbols = selectedGroup?.holdings.map((h) => h.symbol) || [];
    const editPos = allSymbols.map((sym) => {
      const ex = existing.find((p) => p.symbol === sym);
      return {
        symbol: sym,
        units: ex?.units || 0,
        costBasis: ex?.costBasis || sharedCostBasis.get(sym) || 0,
      };
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

    // Build costBasis map from saved positions (ACB is shared across profiles)
    const costBasisMap = new Map<string, number>();
    for (const p of updated.positions) {
      if (p.costBasis > 0) costBasisMap.set(p.symbol, p.costBasis);
    }

    // Merge with existing portfolios, syncing costBasis across profiles in same group
    const other = positions.filter(
      (p) => !(p.groupId === selectedGroupId && p.profile === activeProfile)
    );
    // Propagate costBasis to other profiles in the same group
    const synced = other.map((p) => {
      if (p.groupId !== selectedGroupId) return p;
      const syncedPositions = p.positions.map((pos) => {
        const newCost = costBasisMap.get(pos.symbol);
        return newCost != null ? { ...pos, costBasis: newCost } : pos;
      });
      return { ...p, positions: syncedPositions };
    });
    const all = [...synced, updated];
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

  // ── Rebalance & Buy/Sell logic ──
  const groupState = getGroupState(selectedGroupId);

  const computedHoldingsForSwitch = useMemo(() => {
    if (!effectiveGroup || !profileWeights) return [];
    return effectiveGroup.holdings.map((h) => {
      let alloc = 0;
      if (h.assetClass === "fixedIncome") alloc = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") alloc = profileWeights.equity;
      else if (h.assetClass === "alternative") alloc = profileWeights.alternatives;
      return { symbol: h.symbol, name: h.name, weightInPortfolio: h.weightInClass * alloc };
    });
  }, [effectiveGroup, profileWeights]);

  const handleExecuteRebalance = useCallback(async () => {
    if (!selectedGroup || !profileWeights) return;
    const transactions: PimTransaction[] = [];
    const newPrices: Record<string, number> = { ...(groupState.lastRebalance?.prices || {}) };

    // Build updated positions from rebalance deltas
    const updatedPositionMap = new Map<string, { units: number; costBasis: number }>();
    // Start with existing positions
    for (const row of sortedRows) {
      if (row.modelPct <= 0) continue;
      const existing = positionMap.get(row.symbol);
      updatedPositionMap.set(row.symbol, {
        units: existing?.units || 0,
        costBasis: existing?.costBasis || sharedCostBasisMap.get(row.symbol) || 0,
      });
    }

    for (const row of sortedRows) {
      if (row.modelPct <= 0) continue;
      const execPriceStr = rebalancePrices[row.symbol];
      const execPrice = parseFloat(execPriceStr);
      if (!execPrice || isNaN(execPrice)) continue;

      const targetValueCad = totalValueCadSummary * row.modelPct;
      const targetUnits = row.priceCad > 0 ? targetValueCad / row.priceCad : 0;
      const deltaUnits = targetUnits - row.units;
      if (Math.abs(deltaUnits) < 0.5) continue;

      const direction = deltaUnits > 0 ? "buy" as const : "sell" as const;
      const fxRate = row.currency === "USD" ? usdCadRate : 1;
      const execPriceCad = execPrice * fxRate;

      // Update position: new units and weighted average ACB (in CAD)
      const pos = updatedPositionMap.get(row.symbol)!;
      const oldUnits = pos.units;
      const oldCostBasis = pos.costBasis;
      const newUnits = oldUnits + deltaUnits;

      let newCostBasis = oldCostBasis;
      if (direction === "buy" && newUnits > 0) {
        // Weighted average: (oldUnits * oldACB + boughtUnits * execPriceCad) / newUnits
        newCostBasis = (oldUnits * oldCostBasis + Math.abs(deltaUnits) * execPriceCad) / newUnits;
      }
      // For sells, ACB per unit stays the same

      updatedPositionMap.set(row.symbol, { units: Math.max(0, newUnits), costBasis: parseFloat(newCostBasis.toFixed(4)) });

      newPrices[row.symbol] = execPrice;
      transactions.push({
        id: generateId(),
        date: new Date().toISOString(),
        groupId: selectedGroupId,
        type: "rebalance",
        symbol: row.symbol,
        direction,
        price: execPrice,
        targetWeight: row.modelPct,
      });
    }

    // Persist updated positions
    const newPositions: PimPosition[] = [];
    for (const [symbol, data] of updatedPositionMap) {
      newPositions.push({ symbol, units: parseFloat(data.units.toFixed(4)), costBasis: data.costBasis });
    }
    // Merge: keep positions for symbols not in the rebalance
    const existingPositions = currentPositions?.positions || [];
    const rebalancedSymbols = new Set(updatedPositionMap.keys());
    const keptPositions = existingPositions.filter((p) => !rebalancedSymbols.has(p.symbol));
    const mergedPositions = [...keptPositions, ...newPositions];

    const updatedPortfolio: PimPortfolioPositions = {
      groupId: selectedGroupId,
      profile: activeProfile,
      positions: mergedPositions,
      cashBalance: currentPositions?.cashBalance || 0,
      lastUpdated: new Date().toISOString(),
    };
    const otherPortfolios = positions.filter(
      (p) => !(p.groupId === selectedGroupId && p.profile === activeProfile)
    );
    // Sync costBasis across profiles
    const costBasisMap = new Map<string, number>();
    for (const p of newPositions) {
      if (p.costBasis > 0) costBasisMap.set(p.symbol, p.costBasis);
    }
    const synced = otherPortfolios.map((p) => {
      if (p.groupId !== selectedGroupId) return p;
      const syncedPos = p.positions.map((pos) => {
        const newCost = costBasisMap.get(pos.symbol);
        return newCost != null ? { ...pos, costBasis: newCost } : pos;
      });
      return { ...p, positions: syncedPos };
    });
    const allPositions = [...synced, updatedPortfolio];
    setPositions(allPositions);

    try {
      await fetch("/api/kv/pim-positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolios: allPositions }),
      });
    } catch { /* ignore */ }

    // Update portfolio state (rebalance timestamp + transactions)
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
  }, [sortedRows, rebalancePrices, totalValueCadSummary, usdCadRate, positionMap, sharedCostBasisMap,
      positions, currentPositions, activeProfile, selectedGroup, profileWeights,
      pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState, fetchPrices]);

  const handleResolveBuyTicker = useCallback(async (ticker: string) => {
    if (!ticker.trim()) return;
    const t = ticker.trim().toUpperCase();
    setSwitchBuy((s) => ({ ...s, ticker: t, resolving: true, name: "" }));
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(t)}`);
      if (res.ok) {
        const data = await res.json();
        const name = data.names?.[t] || t;
        setSwitchBuy((s) => ({ ...s, name, symbol: t, resolving: false }));
      } else {
        setSwitchBuy((s) => ({ ...s, name: t, symbol: t, resolving: false }));
      }
    } catch {
      setSwitchBuy((s) => ({ ...s, name: t, symbol: t, resolving: false }));
    }
  }, []);

  const handleExecuteSwitch = useCallback(async () => {
    const sellPrice = switchSell.symbol ? parseFloat(switchSell.price) : 0;
    const buyPrice = parseFloat(switchBuy.price);
    const buyTicker = switchBuy.symbol.trim().toUpperCase();
    if (!buyTicker || !buyPrice) return;
    if (switchSell.symbol && !sellPrice) return;

    const existsInPortfolio = scoredStocks.some(
      (s) => s.ticker === buyTicker || s.ticker.replace("-T", ".TO") === buyTicker.replace("-T", ".TO")
    );
    if (!existsInPortfolio) {
      let name = switchBuy.name || buyTicker;
      let instrumentType: InstrumentType = "stock";
      let sector = "";
      try {
        const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(buyTicker)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.names?.[buyTicker]) name = data.names[buyTicker];
          if (data.sectors?.[buyTicker]) sector = data.sectors[buyTicker];
          if (data.types?.[buyTicker]) instrumentType = data.types[buyTicker] as InstrumentType;
        }
      } catch { /* fallback */ }

      const stock: Stock = {
        ticker: buyTicker,
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
    }

    const sellHolding = switchSell.symbol ? computedHoldingsForSwitch.find((h) => h.symbol === switchSell.symbol) : null;
    const transactions: PimTransaction[] = [];
    if (switchSell.symbol && sellPrice) {
      transactions.push({
        id: generateId(), date: new Date().toISOString(), groupId: selectedGroupId,
        type: switchSell.symbol ? "switch" : "buy", symbol: switchSell.symbol, direction: "sell",
        price: sellPrice, targetWeight: sellHolding?.weightInPortfolio || 0, pairedWith: buyTicker,
      });
    }
    transactions.push({
      id: generateId(), date: new Date().toISOString(), groupId: selectedGroupId,
      type: switchSell.symbol ? "switch" : "buy", symbol: buyTicker, direction: "buy",
      price: buyPrice, targetWeight: 0, pairedWith: switchSell.symbol || undefined,
    });

    const newPrices = { ...(groupState.lastRebalance?.prices || {}) };
    if (switchSell.symbol) newPrices[switchSell.symbol] = sellPrice;
    newPrices[buyTicker] = buyPrice;

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
    setSwitchBuy({ symbol: "", price: "", ticker: "", name: "", resolving: false });
    fetchPrices();
  }, [switchSell, switchBuy, computedHoldingsForSwitch, pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState, fetchPrices, scoredStocks, addStock]);

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-bold text-slate-800">PIM</h2>

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
          {!editMode && (
            <button onClick={() => setShowRebalance(!showRebalance)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
              Rebalance
            </button>
          )}
          {!editMode && (
            <button onClick={() => setShowSwitch(!showSwitch)}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors">
              Buy / Sell
            </button>
          )}
          {groupState.lastRebalance && (
            <span className="text-[10px] text-slate-400 ml-1">
              Last rebalance: {new Date(groupState.lastRebalance.date).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Rebalance Panel */}
      {showRebalance && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-3">Rebalance Preview</h3>
          <p className="text-xs text-slate-500 mb-3">
            Shows the units to buy or sell for each holding to match model weights.
            Enter the execution price (in holding currency) to confirm — ACB (CAD) will be recalculated automatically.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-emerald-200 text-xs text-slate-500">
                  <th className="text-left py-2 font-semibold">Symbol</th>
                  <th className="text-right py-2 font-semibold">Target %</th>
                  <th className="text-right py-2 font-semibold">Current %</th>
                  <th className="text-right py-2 font-semibold">Drift</th>
                  <th className="text-center py-2 font-semibold">Action</th>
                  <th className="text-right py-2 font-semibold">Current Units</th>
                  <th className="text-right py-2 font-semibold">Target Units</th>
                  <th className="text-right py-2 font-semibold">Δ Units</th>
                  <th className="text-right py-2 font-semibold">Mkt Price</th>
                  <th className="text-right py-2 font-semibold">Exec Price</th>
                  <th className="text-right py-2 font-semibold">Cost (CAD)</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.filter((r) => r.modelPct > 0).map((r) => {
                  const targetValueCad = totalValueCadSummary * r.modelPct;
                  const targetUnits = r.priceCad > 0 ? targetValueCad / r.priceCad : 0;
                  const deltaUnits = targetUnits - r.units;
                  const absDelta = Math.abs(deltaUnits);
                  const action = absDelta < 0.5 ? "HOLD" : deltaUnits > 0 ? "BUY" : "SELL";
                  const execPrice = parseFloat(rebalancePrices[r.symbol] || "0");
                  const fxRate = r.currency === "USD" ? usdCadRate : 1;
                  const costCad = execPrice > 0 ? absDelta * execPrice * fxRate : 0;

                  return (
                    <tr key={r.symbol} className="border-b border-emerald-100">
                      <td className="py-2 font-mono text-xs font-semibold">
                        <Link href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`} className="hover:underline hover:text-blue-600 transition-colors">
                          {r.symbol}
                        </Link>
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{pct(r.modelPct)}</td>
                      <td className="py-2 text-right font-mono text-xs">{pct(r.currentPct)}</td>
                      <td className={`py-2 text-right font-mono text-xs font-semibold ${r.driftPct > 0 ? "text-emerald-600" : r.driftPct < 0 ? "text-red-500" : "text-slate-400"}`}>
                        {r.driftPct > 0 ? "+" : ""}{(r.driftPct * 10000).toFixed(0)}bp
                      </td>
                      <td className="py-2 text-center">
                        {action !== "HOLD" && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${action === "SELL" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                            {action}
                          </span>
                        )}
                        {action === "HOLD" && <span className="text-[10px] text-slate-400">—</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{r.units > 0 ? r.units.toFixed(2) : "—"}</td>
                      <td className="py-2 text-right font-mono text-xs">{targetUnits.toFixed(2)}</td>
                      <td className={`py-2 text-right font-mono text-xs font-semibold ${action === "BUY" ? "text-emerald-600" : action === "SELL" ? "text-red-500" : "text-slate-400"}`}>
                        {action === "HOLD" ? "—" : `${deltaUnits > 0 ? "+" : ""}${deltaUnits.toFixed(2)}`}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-slate-500">{r.price > 0 ? `$${r.price.toFixed(2)}` : "—"}</td>
                      <td className="py-2 text-right">
                        {action !== "HOLD" ? (
                          <input type="number" step="0.01" placeholder="Price"
                            value={rebalancePrices[r.symbol] || ""}
                            onChange={(e) => setRebalancePrices((p) => ({ ...p, [r.symbol]: e.target.value }))}
                            className="w-20 rounded border border-slate-200 px-2 py-1 text-xs text-right outline-none focus:border-emerald-300" />
                        ) : <span className="text-xs text-slate-400">—</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-slate-600">
                        {costCad > 0 ? `$${costCad.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
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

      {/* Buy/Sell Panel */}
      {showSwitch && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-3">Buy / Sell</h3>
          <p className="text-xs text-slate-500 mb-3">Buy a new position or sell an existing one. Optionally pair as a switch (sell one, buy another).</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-red-600 uppercase">Sell (optional)</label>
              <select value={switchSell.symbol} onChange={(e) => setSwitchSell((s) => ({ ...s, symbol: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300">
                <option value="">None \u2014 buy only</option>
                {computedHoldingsForSwitch.filter((h) => h.weightInPortfolio > 0).map((h) => (
                  <option key={h.symbol} value={h.symbol}>{h.symbol} \u2014 {h.name}</option>
                ))}
              </select>
              {switchSell.symbol && (
                <>
                  <input type="number" step="0.01" placeholder="Sell price"
                    value={switchSell.price} onChange={(e) => setSwitchSell((s) => ({ ...s, price: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-300" />
                  {livePrices[switchSell.symbol] && (
                    <p className="text-[10px] text-slate-400">Market: ${livePrices[switchSell.symbol].toFixed(2)}</p>
                  )}
                </>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-emerald-600 uppercase">Buy</label>
              <div className="relative">
                <input type="text" value={switchBuy.ticker}
                  onChange={(e) => setSwitchBuy((s) => ({ ...s, ticker: e.target.value.toUpperCase() }))}
                  onBlur={() => switchBuy.ticker.trim() && handleResolveBuyTicker(switchBuy.ticker)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleResolveBuyTicker(switchBuy.ticker); }}
                  placeholder="e.g. AAPL, XSP.TO, TDB900"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-300 font-mono" />
                {switchBuy.resolving && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 animate-pulse">Looking up...</span>
                )}
              </div>
              {switchBuy.name && !switchBuy.resolving && (
                <p className="text-xs text-slate-600 truncate">{switchBuy.name}</p>
              )}
              <input type="number" step="0.01" placeholder="Buy price"
                value={switchBuy.price} onChange={(e) => setSwitchBuy((s) => ({ ...s, price: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-300" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleExecuteSwitch}
              disabled={!switchBuy.symbol || !switchBuy.price || switchBuy.resolving || (!!switchSell.symbol && !switchSell.price)}
              className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 transition-colors disabled:opacity-50">
              {switchSell.symbol ? "Execute Switch" : "Execute Buy"}
            </button>
            <button onClick={() => { setShowSwitch(false); setSwitchSell({ symbol: "", price: "" }); setSwitchBuy({ symbol: "", price: "", ticker: "", name: "", resolving: false }); }}
              className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-300 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Portfolio summary (all CAD) */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Total Value (CAD)</div>
          <div className="text-lg font-bold text-slate-800">{fmtCurrency(totalValueCadSummary)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Total ACB (CAD)</div>
          <div className="text-lg font-bold text-slate-700">{fmtCurrency(totalCostCad)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Gain/Loss</div>
          <div className={`text-lg font-bold ${totalValueCadSummary - totalCostCad >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {fmtCurrency(totalValueCadSummary - totalCostCad)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Return</div>
          <div className={`text-lg font-bold ${totalCostCad > 0 && totalValueCadSummary - totalCostCad >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {totalCostCad > 0 ? fmtGainLoss(((totalValueCadSummary - totalCostCad) / totalCostCad) * 100) : "--"}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Today</div>
          <div className={`text-lg font-bold ${todayReturn != null && todayReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {todayReturn != null ? fmtGainLoss(todayReturn) : "--"}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-slate-400 uppercase">Cash</div>
          <div className="text-lg font-bold text-slate-700">{fmtCurrency(cashBalance)}</div>
          <div className="text-[9px] text-slate-400">{pct(cashPct)}</div>
        </div>
      </div>

      {/* USD/CAD rate indicator */}
      {usdCadRate > 1 && (
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-300" />
          USD/CAD: {usdCadRate.toFixed(4)}
        </div>
      )}

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
                  Value (CAD)<SortIcon field="value" />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("acb")}>
                  ACB (CAD)<SortIcon field="acb" />
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
                <td className="py-2.5 px-2 text-right font-mono text-slate-500">-</td>
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

              {sortedRows.map((row) => {
                const currBadge = row.currency === "USD" ? (
                  <span className="ml-1 inline-block rounded bg-blue-50 px-1 py-0 text-[8px] font-bold text-blue-500 align-middle">USD</span>
                ) : null;

                return (
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
                    {/* Price in instrument currency */}
                    <td className="py-2.5 px-2 text-right font-mono text-slate-700">
                      {row.price > 0 ? (
                        <span>${row.price.toFixed(2)}{currBadge}</span>
                      ) : "-"}
                    </td>
                    {/* Market Value in CAD */}
                    <td className="py-2.5 px-2 text-right font-mono font-semibold text-slate-700">
                      {row.valueCad > 0 ? fmtCurrency(row.valueCad) : "-"}
                    </td>
                    {/* ACB (Book Cost) in CAD */}
                    <td className="py-2.5 px-2 text-right font-mono text-slate-600">
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
                            placeholder={`Cost (${row.currency})`}
                          />
                        </div>
                      )}
                      {row.costValueCad > 0 ? fmtCurrency(row.costValueCad) : "-"}
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
                );
              })}
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
