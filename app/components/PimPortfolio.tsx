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
import { isMarketOpenOrAfterET } from "@/app/lib/market-hours";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
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
  const [prevCloseUsdCad, setPrevCloseUsdCad] = useState<number>(1.0);
  const [pricesLoading, setPricesLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editPositions, setEditPositions] = useState<PimPosition[]>([]);
  const [editCash, setEditCash] = useState(0);
  const [saving, setSaving] = useState(false);

  // Rebalance & Buy/Sell state
  const [showRebalance, setShowRebalance] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  // Rebalance prices are shared across profiles (cross-model price sharing)
  const [rebalancePrices, setRebalancePrices] = useState<Record<string, string>>({});
  const [switchSell, setSwitchSell] = useState({ symbol: "", price: "" });
  const [switchBuy, setSwitchBuy] = useState({ symbol: "", price: "", ticker: "", name: "", resolving: false });

  // Pending trades settlement
  const [showSettlement, setShowSettlement] = useState(false);
  const [settlementPrices, setSettlementPrices] = useState<Record<string, string>>({});
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settling, setSettling] = useState(false);

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
          const pimW = pimWeightMap.get(h.symbol);
          if (!coreSymbols.has(symbolToTicker(h.symbol))) {
            return pimW != null ? { ...h, weightInClass: pimW } : h;
          }
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

    // Fetch USD/CAD rate (live + previous close for rebalance math)
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
        const pcFx = fxData.previousCloses?.["USDCAD=X"];
        if (pcFx && pcFx > 0) setPrevCloseUsdCad(pcFx);
        else if (rate && rate > 0) setPrevCloseUsdCad(rate); // fallback
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
      if (Math.abs(driftPct) > 0.0001) {
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

  // Total portfolio value using PREVIOUS CLOSE prices (for rebalance math).
  // Rebalance quantities should match the trading desk which runs off prior close.
  const prevCloseTotalCad = useMemo(() => {
    if (!effectiveGroup || !profileWeights) return 0;
    let total = currentPositions?.cashBalance || 0;
    for (const h of effectiveGroup.holdings) {
      let alloc = 0;
      if (h.assetClass === "fixedIncome") alloc = profileWeights.fixedIncome;
      else if (h.assetClass === "equity") alloc = profileWeights.equity;
      else if (h.assetClass === "alternative") alloc = profileWeights.alternatives;
      if (h.weightInClass * alloc <= 0) continue;
      const pos = positionMap.get(h.symbol);
      const units = pos?.units || 0;
      const pc = prevCloses[h.symbol] || livePrices[h.symbol] || 0;
      const fxRate = h.currency === "USD" ? prevCloseUsdCad : 1;
      total += units * pc * fxRate;
    }
    return total;
  }, [effectiveGroup, profileWeights, prevCloses, livePrices, positionMap, currentPositions, prevCloseUsdCad]);

  const cashBalance = currentPositions?.cashBalance || 0;
  const cashPct = totalValueCadSummary > 0 ? cashBalance / totalValueCadSummary : 0;

  // Today's return: weighted sum of each holding's daily % change (prev close → current price).
  // USD holdings use yesterday's USDCAD for the prev side and today's USDCAD
  // for the curr side so that FX translation gain/loss is reflected in the
  // CAD return — matching the methodology used by /api/update-daily-value
  // (the Appendix ledger). Using the same rate on both sides cancels FX out
  // entirely and makes this tile disagree with the Appendix by the amount
  // of the day's USDCAD move scaled by the portfolio's USD weight.
  const todayReturn = useMemo(() => {
    // Pre-market data is unreliable: Yahoo's regularMarketPrice still
    // reports yesterday's close before 9:30 AM ET, so the computed return
    // would actually be yesterday's return mislabeled as today's.
    if (!isMarketOpenOrAfterET()) return null;
    if (holdingRows.length === 0) return null;
    let prevTotalCad = 0;
    let currTotalCad = 0;
    for (const r of holdingRows) {
      const pc = prevCloses[r.symbol];
      if (pc == null || pc <= 0 || r.units <= 0) continue;
      const prevFx = r.currency === "USD" ? prevCloseUsdCad : 1;
      const currFx = r.currency === "USD" ? usdCadRate : 1;
      prevTotalCad += r.units * pc * prevFx;
      currTotalCad += r.units * r.price * currFx;
    }
    if (prevTotalCad <= 0) return null;
    return ((currTotalCad - prevTotalCad) / prevTotalCad) * 100;
  }, [holdingRows, prevCloses, usdCadRate, prevCloseUsdCad]);

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

  // Execute rebalance for a specific profile. Two-phase: stocks/ETFs settle
  // immediately; mutual funds (FUNDSERV codes) become "pending" trades that
  // settle the next morning when NAV is known.
  const executeRebalanceForProfile = useCallback(async (
    profile: PimProfileType,
    priceOverrides: Record<string, string>,
  ) => {
    if (!selectedGroup) return { transactions: [] as PimTransaction[], positionUpdates: [] as PimPosition[] };

    // Resolve profile weights
    const pWeights = profile === "alpha"
      ? { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 }
      : selectedGroup.profiles[profile];
    if (!pWeights) return { transactions: [] as PimTransaction[], positionUpdates: [] as PimPosition[] };

    // Get profile positions
    const profPortfolio = positions.find(
      (p) => p.groupId === selectedGroupId && p.profile === profile
    );
    const profPositionMap = new Map<string, PimPosition>();
    for (const pos of profPortfolio?.positions || []) {
      profPositionMap.set(pos.symbol, pos);
    }

    // Build effective group for this profile (handle alpha filtering)
    let profGroup = selectedGroup;
    if (profile === "alpha") {
      const alphaHoldings = selectedGroup.holdings.filter(
        (h) => h.assetClass === "equity" && !coreSymbols.has(symbolToTicker(h.symbol))
      );
      const totalW = alphaHoldings.reduce((s, h) => s + h.weightInClass, 0);
      profGroup = {
        ...selectedGroup,
        holdings: totalW > 0 ? alphaHoldings.map((h) => ({ ...h, weightInClass: h.weightInClass / totalW })) : alphaHoldings,
      };
    }

    // Compute total value for this profile using PREVIOUS CLOSE prices.
    // Rebalance quantities must match the trading desk which runs off prior close.
    let totalValCad = profPortfolio?.cashBalance || 0;
    const holdingInfo: { symbol: string; modelPct: number; units: number; priceCad: number; currency: "CAD" | "USD"; costBasis: number }[] = [];
    for (const h of profGroup.holdings) {
      let alloc = 0;
      if (h.assetClass === "fixedIncome") alloc = pWeights.fixedIncome;
      else if (h.assetClass === "equity") alloc = pWeights.equity;
      else if (h.assetClass === "alternative") alloc = pWeights.alternatives;
      const modelPct = h.weightInClass * alloc;
      if (modelPct <= 0) continue;

      const pos = profPositionMap.get(h.symbol);
      const units = pos?.units || 0;
      const costBasis = pos?.costBasis || sharedCostBasisMap.get(h.symbol) || 0;
      // Use previous close for rebalance math; fall back to live if unavailable
      const price = prevCloses[h.symbol] || livePrices[h.symbol] || 0;
      const fxRate = h.currency === "USD" ? prevCloseUsdCad : 1;
      const priceCad = price * fxRate;
      totalValCad += units * priceCad;
      holdingInfo.push({ symbol: h.symbol, modelPct, units, priceCad, currency: h.currency, costBasis });
    }

    const transactions: PimTransaction[] = [];
    const updatedPositionMap = new Map<string, { units: number; costBasis: number }>();
    for (const hi of holdingInfo) {
      const pos = profPositionMap.get(hi.symbol);
      updatedPositionMap.set(hi.symbol, {
        units: pos?.units || 0,
        costBasis: pos?.costBasis || sharedCostBasisMap.get(hi.symbol) || 0,
      });
    }

    for (const hi of holdingInfo) {
      const execPriceStr = priceOverrides[hi.symbol];
      const execPrice = parseFloat(execPriceStr);
      const isMutualFund = isFundservCode(hi.symbol);

      // Mutual funds: we don't need an exec price — we record dollar amount
      // Stocks/ETFs: need an exec price
      if (!isMutualFund && (!execPrice || isNaN(execPrice))) continue;

      const targetValueCad = totalValCad * hi.modelPct;
      const deltaValueCad = targetValueCad - (hi.units * hi.priceCad);

      if (!isMutualFund) {
        // Stocks/ETFs: settle immediately
        const targetUnits = hi.priceCad > 0 ? targetValueCad / hi.priceCad : 0;
        const deltaUnits = targetUnits - hi.units;
        if (Math.abs(deltaUnits) < 0.001) continue; // skip only rounding noise

        const direction = deltaUnits > 0 ? "buy" as const : "sell" as const;
        const fxRate = hi.currency === "USD" ? usdCadRate : 1;
        const execPriceCad = execPrice * fxRate;

        const pos = updatedPositionMap.get(hi.symbol)!;
        const oldUnits = pos.units;
        const oldCostBasis = pos.costBasis;
        const newUnits = oldUnits + deltaUnits;

        let newCostBasis = oldCostBasis;
        if (direction === "buy" && newUnits > 0) {
          newCostBasis = (oldUnits * oldCostBasis + Math.abs(deltaUnits) * execPriceCad) / newUnits;
        }

        updatedPositionMap.set(hi.symbol, { units: Math.max(0, newUnits), costBasis: parseFloat(newCostBasis.toFixed(4)) });

        transactions.push({
          id: generateId(),
          date: new Date().toISOString(),
          groupId: selectedGroupId,
          type: "rebalance",
          symbol: hi.symbol,
          direction,
          price: execPrice,
          targetWeight: hi.modelPct,
          status: "settled",
          profile,
        });
      } else {
        // Mutual funds: pending — record dollar amount, settle when NAV is known
        if (Math.abs(deltaValueCad) < 0.01) continue; // skip only rounding noise
        const direction = deltaValueCad > 0 ? "buy" as const : "sell" as const;

        transactions.push({
          id: generateId(),
          date: new Date().toISOString(),
          groupId: selectedGroupId,
          type: "rebalance",
          symbol: hi.symbol,
          direction,
          price: 0, // unknown until settlement
          targetWeight: hi.modelPct,
          status: "pending",
          targetAmount: parseFloat(Math.abs(deltaValueCad).toFixed(2)),
          profile,
        });
      }
    }

    // Build updated position list (only for settled trades)
    const newPositions: PimPosition[] = [];
    for (const [symbol, data] of updatedPositionMap) {
      newPositions.push({ symbol, units: parseFloat(data.units.toFixed(4)), costBasis: data.costBasis });
    }

    return { transactions, positionUpdates: newPositions };
  }, [selectedGroup, positions, selectedGroupId, prevCloses, livePrices, usdCadRate, prevCloseUsdCad, sharedCostBasisMap, coreSymbols]);

  // Compute pending trades across all profiles
  const pendingTrades = useMemo(() => {
    return groupState.transactions.filter((t) => t.status === "pending");
  }, [groupState.transactions]);

  const handleExecuteRebalance = useCallback(async () => {
    if (!selectedGroup || !profileWeights) return;

    // Execute for active profile
    const { transactions, positionUpdates } = await executeRebalanceForProfile(activeProfile, rebalancePrices);
    if (transactions.length === 0) return;

    const newPrices: Record<string, number> = { ...(groupState.lastRebalance?.prices || {}) };
    for (const t of transactions) {
      if (t.price > 0) newPrices[t.symbol] = t.price;
    }

    // Merge positions
    const existingPositions = currentPositions?.positions || [];
    const rebalancedSymbols = new Set(positionUpdates.map((p) => p.symbol));
    const keptPositions = existingPositions.filter((p) => !rebalancedSymbols.has(p.symbol));
    const mergedPositions = [...keptPositions, ...positionUpdates];

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
    for (const p of positionUpdates) {
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

    // Update portfolio state
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
    // Don't clear rebalancePrices — they're shared across profiles for cross-model use
    fetchPrices();
  }, [sortedRows, rebalancePrices, totalValueCadSummary, usdCadRate, positionMap, sharedCostBasisMap,
      positions, currentPositions, activeProfile, selectedGroup, profileWeights,
      pimPortfolioState, selectedGroupId, groupState, updatePimPortfolioState, fetchPrices,
      executeRebalanceForProfile]);

  // Execute rebalance across ALL profiles at once (cross-model price sharing)
  const handleExecuteAllProfiles = useCallback(async () => {
    if (!selectedGroup) return;

    let allNewTransactions: PimTransaction[] = [];
    let allPositionsList = [...positions];
    const newPrices: Record<string, number> = { ...(groupState.lastRebalance?.prices || {}) };

    for (const profile of availableProfiles) {
      const { transactions, positionUpdates } = await executeRebalanceForProfile(profile, rebalancePrices);
      if (transactions.length === 0) continue;

      for (const t of transactions) {
        if (t.price > 0) newPrices[t.symbol] = t.price;
      }
      allNewTransactions = [...allNewTransactions, ...transactions];

      // Get existing portfolio for this profile
      const existingPortfolio = allPositionsList.find(
        (p) => p.groupId === selectedGroupId && p.profile === profile
      );
      const existingPos = existingPortfolio?.positions || [];
      const updatedSymbols = new Set(positionUpdates.map((p) => p.symbol));
      const keptPos = existingPos.filter((p) => !updatedSymbols.has(p.symbol));
      const mergedPos = [...keptPos, ...positionUpdates];

      const updatedPortfolio: PimPortfolioPositions = {
        groupId: selectedGroupId,
        profile,
        positions: mergedPos,
        cashBalance: existingPortfolio?.cashBalance || 0,
        lastUpdated: new Date().toISOString(),
      };

      allPositionsList = [
        ...allPositionsList.filter((p) => !(p.groupId === selectedGroupId && p.profile === profile)),
        updatedPortfolio,
      ];
    }

    // Sync costBasis across all profiles
    const costBasisMap = new Map<string, number>();
    for (const p of allPositionsList) {
      if (p.groupId !== selectedGroupId) continue;
      for (const pos of p.positions) {
        if (pos.costBasis > 0 && !costBasisMap.has(pos.symbol)) {
          costBasisMap.set(pos.symbol, pos.costBasis);
        }
      }
    }
    allPositionsList = allPositionsList.map((p) => {
      if (p.groupId !== selectedGroupId) return p;
      return {
        ...p,
        positions: p.positions.map((pos) => {
          const synced = costBasisMap.get(pos.symbol);
          return synced != null ? { ...pos, costBasis: synced } : pos;
        }),
      };
    });

    setPositions(allPositionsList);
    try {
      await fetch("/api/kv/pim-positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolios: allPositionsList }),
      });
    } catch { /* ignore */ }

    const updatedState: PimPortfolioState = {
      ...pimPortfolioState,
      groupStates: [
        ...pimPortfolioState.groupStates.filter((gs) => gs.groupId !== selectedGroupId),
        {
          ...groupState,
          lastRebalance: { date: new Date().toISOString(), prices: newPrices },
          transactions: [...groupState.transactions, ...allNewTransactions],
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    updatePimPortfolioState(updatedState);
    setShowRebalance(false);
    setRebalancePrices({});
    fetchPrices();
  }, [selectedGroup, availableProfiles, rebalancePrices, positions, pimPortfolioState,
      selectedGroupId, groupState, updatePimPortfolioState, fetchPrices, executeRebalanceForProfile]);

  // Fetch NAV prices for pending mutual fund trades using the same /api/prices
  // route that the rest of the app uses for live fund pricing (Barchart EOD).
  const handleFetchSettlementPrices = useCallback(async () => {
    const fundSymbols = [...new Set(pendingTrades.map((t) => t.symbol))];
    if (fundSymbols.length === 0) return;

    setSettlementLoading(true);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: fundSymbols }),
      });
      if (res.ok) {
        const data = await res.json();
        const prices: Record<string, string> = {};
        for (const sym of fundSymbols) {
          const price = data.prices?.[sym];
          if (price != null && price > 0) {
            prices[sym] = price.toFixed(4);
          }
        }
        setSettlementPrices((prev) => ({ ...prev, ...prices }));
      }
    } catch { /* ignore */ }
    setSettlementLoading(false);
  }, [pendingTrades]);

  // Open settlement panel and auto-fetch prices
  const handleOpenSettlement = useCallback(() => {
    setShowSettlement(true);
    handleFetchSettlementPrices();
  }, [handleFetchSettlementPrices]);

  // Settle pending mutual fund trades: calculate units from targetAmount / NAV
  const handleSettlePending = useCallback(async () => {
    if (pendingTrades.length === 0) return;
    setSettling(true);

    let updatedPositionsList = [...positions];
    const settledTransactions: PimTransaction[] = [];
    const now = new Date().toISOString();

    for (const trade of pendingTrades) {
      const navStr = settlementPrices[trade.symbol];
      const nav = parseFloat(navStr);
      if (!nav || isNaN(nav) || nav <= 0) continue;

      const profile = trade.profile || activeProfile;
      const targetAmount = trade.targetAmount || 0;
      if (targetAmount <= 0) continue;

      const units = targetAmount / nav;

      // Find the portfolio for this profile
      const portfolioIdx = updatedPositionsList.findIndex(
        (p) => p.groupId === selectedGroupId && p.profile === profile
      );
      if (portfolioIdx === -1) continue;

      const portfolio = updatedPositionsList[portfolioIdx];
      const existingPos = portfolio.positions.find((p) => p.symbol === trade.symbol);
      const oldUnits = existingPos?.units || 0;
      const oldCostBasis = existingPos?.costBasis || sharedCostBasisMap.get(trade.symbol) || 0;

      let newUnits: number;
      let newCostBasis: number;

      if (trade.direction === "buy") {
        newUnits = oldUnits + units;
        newCostBasis = newUnits > 0
          ? (oldUnits * oldCostBasis + units * nav) / newUnits
          : nav;
      } else {
        newUnits = Math.max(0, oldUnits - units);
        newCostBasis = oldCostBasis; // ACB per unit stays same on sell
      }

      // Update position in portfolio
      const updatedPos = portfolio.positions.map((p) =>
        p.symbol === trade.symbol
          ? { ...p, units: parseFloat(newUnits.toFixed(4)), costBasis: parseFloat(newCostBasis.toFixed(4)) }
          : p
      );
      // If position didn't exist, add it
      if (!existingPos) {
        updatedPos.push({
          symbol: trade.symbol,
          units: parseFloat(units.toFixed(4)),
          costBasis: parseFloat(nav.toFixed(4)),
        });
      }

      updatedPositionsList[portfolioIdx] = {
        ...portfolio,
        positions: updatedPos,
        lastUpdated: now,
      };

      // Mark transaction as settled
      settledTransactions.push({
        ...trade,
        status: "settled",
        price: nav,
        settledAt: now,
      });
    }

    // Sync costBasis across profiles
    const costBasisMap = new Map<string, number>();
    for (const p of updatedPositionsList) {
      if (p.groupId !== selectedGroupId) continue;
      for (const pos of p.positions) {
        if (pos.costBasis > 0 && !costBasisMap.has(pos.symbol)) {
          costBasisMap.set(pos.symbol, pos.costBasis);
        }
      }
    }
    updatedPositionsList = updatedPositionsList.map((p) => {
      if (p.groupId !== selectedGroupId) return p;
      return {
        ...p,
        positions: p.positions.map((pos) => {
          const synced = costBasisMap.get(pos.symbol);
          return synced != null ? { ...pos, costBasis: synced } : pos;
        }),
      };
    });

    setPositions(updatedPositionsList);
    try {
      await fetch("/api/kv/pim-positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolios: updatedPositionsList }),
      });
    } catch { /* ignore */ }

    // Update transactions: replace pending with settled
    const settledIds = new Set(settledTransactions.map((t) => t.id));
    const updatedTransactions = [
      ...groupState.transactions.filter((t) => !settledIds.has(t.id)),
      ...settledTransactions,
    ];

    const updatedState: PimPortfolioState = {
      ...pimPortfolioState,
      groupStates: [
        ...pimPortfolioState.groupStates.filter((gs) => gs.groupId !== selectedGroupId),
        { ...groupState, transactions: updatedTransactions },
      ],
      lastUpdated: now,
    };
    updatePimPortfolioState(updatedState);
    setShowSettlement(false);
    setSettlementPrices({});
    setSettling(false);
    fetchPrices();
  }, [pendingTrades, settlementPrices, positions, activeProfile, selectedGroupId,
      sharedCostBasisMap, groupState, pimPortfolioState, updatePimPortfolioState, fetchPrices]);

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
        <div className="flex flex-wrap items-center gap-2">
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
          {/* Client Report — opens the one-pager preview in a new tab,
              seeded with the currently-selected profile. Disabled for
              Alpha because the one-pager is only built for the three
              full-model profiles (Balanced / Growth / All-Equity). */}
          {!editMode && activeProfile !== "alpha" && (
            <Link
              href={`/client-report?group=${encodeURIComponent(selectedGroupId)}&profile=${encodeURIComponent(activeProfile)}`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-semibold !text-white hover:bg-[#003b7a] transition-colors"
            >
              Client Report
            </Link>
          )}
          {!editMode && pendingTrades.length > 0 && (
            <button onClick={handleOpenSettlement}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 transition-colors relative">
              Settle Pending
              <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
                {pendingTrades.length}
              </span>
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
          <h3 className="text-sm font-bold text-slate-800 mb-3">
            Rebalance Preview
            <span className="ml-2 text-[10px] font-normal text-slate-400">({PROFILE_LABELS[activeProfile]})</span>
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Target units are calculated from <strong>previous close</strong> prices to match the trading desk.
            Enter the actual execution price for ACB tracking. Mutual funds are recorded as pending and settled when NAV is available.
            Prices are shared across profiles.
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
                  <th className="text-right py-2 font-semibold">Prev Close</th>
                  <th className="text-right py-2 font-semibold">Exec Price</th>
                  <th className="text-right py-2 font-semibold">Cost (CAD)</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.filter((r) => r.modelPct > 0).map((r) => {
                  // Rebalance math uses PREVIOUS CLOSE to match trading desk
                  const pcPrice = prevCloses[r.symbol] || r.price;
                  const pcFx = r.currency === "USD" ? prevCloseUsdCad : 1;
                  const pcPriceCad = pcPrice * pcFx;
                  const pcValueCad = r.units * pcPriceCad;
                  const targetValueCad = prevCloseTotalCad * r.modelPct;
                  const targetUnits = pcPriceCad > 0 ? targetValueCad / pcPriceCad : 0;
                  const deltaUnits = targetUnits - r.units;
                  const absDelta = Math.abs(deltaUnits);
                  const isMF = isFundservCode(r.symbol);
                  const deltaValueCad = targetValueCad - pcValueCad;
                  const action = isMF
                    ? (Math.abs(deltaValueCad) < 0.01 ? "HOLD" : deltaValueCad > 0 ? "BUY" : "SELL")
                    : (absDelta < 0.001 ? "HOLD" : deltaUnits > 0 ? "BUY" : "SELL");
                  const execPrice = parseFloat(rebalancePrices[r.symbol] || "0");
                  const fxRate = r.currency === "USD" ? usdCadRate : 1;
                  const costCad = isMF
                    ? Math.abs(deltaValueCad)
                    : (execPrice > 0 ? absDelta * execPrice * fxRate : 0);

                  return (
                    <tr key={r.symbol} className={`border-b border-emerald-100 ${isMF ? "bg-violet-50/30" : ""}`}>
                      <td className="py-2 font-mono text-xs font-semibold">
                        <Link href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`} className="hover:underline hover:text-blue-600 transition-colors">
                          {r.symbol}
                        </Link>
                        {isMF && (
                          <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[8px] font-bold text-violet-600">FUND</span>
                        )}
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{pct(r.modelPct)}</td>
                      <td className="py-2 text-right font-mono text-xs" title="Based on previous close">
                        {prevCloseTotalCad > 0 ? pct(pcValueCad / prevCloseTotalCad) : pct(r.currentPct)}
                      </td>
                      {(() => {
                        const pcDrift = prevCloseTotalCad > 0 ? (pcValueCad / prevCloseTotalCad) - r.modelPct : r.driftPct;
                        return (
                          <td className={`py-2 text-right font-mono text-xs font-semibold ${pcDrift > 0 ? "text-emerald-600" : pcDrift < 0 ? "text-red-500" : "text-slate-400"}`}>
                            {pcDrift > 0 ? "+" : ""}{(pcDrift * 10000).toFixed(0)}bp
                          </td>
                        );
                      })()}
                      <td className="py-2 text-center">
                        {action !== "HOLD" && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${action === "SELL" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                            {action}
                          </span>
                        )}
                        {action === "HOLD" && <span className="text-[10px] text-slate-400">{"\u2014"}</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{r.units > 0 ? r.units.toFixed(2) : "\u2014"}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {isMF ? (
                          <span className="text-violet-500" title="Units calculated at settlement">{"\u2014"}</span>
                        ) : targetUnits.toFixed(2)}
                      </td>
                      <td className={`py-2 text-right font-mono text-xs font-semibold ${action === "BUY" ? "text-emerald-600" : action === "SELL" ? "text-red-500" : "text-slate-400"}`}>
                        {action === "HOLD" ? "\u2014" : isMF ? (
                          <span title="Dollar amount — units determined at settlement">${Math.abs(deltaValueCad).toFixed(0)}</span>
                        ) : `${deltaUnits > 0 ? "+" : ""}${deltaUnits.toFixed(2)}`}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-slate-500">{pcPrice > 0 ? `$${pcPrice.toFixed(2)}` : "\u2014"}</td>
                      <td className="py-2 text-right">
                        {isMF ? (
                          <span className="text-[10px] text-violet-500 italic">Pending</span>
                        ) : action !== "HOLD" ? (
                          <input type="number" step="0.01" placeholder="Price"
                            value={rebalancePrices[r.symbol] || ""}
                            onChange={(e) => setRebalancePrices((p) => ({ ...p, [r.symbol]: e.target.value }))}
                            className="w-20 rounded border border-slate-200 px-2 py-1 text-xs text-right outline-none focus:border-emerald-300" />
                        ) : <span className="text-xs text-slate-400">{"\u2014"}</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-slate-600">
                        {costCad > 0 ? `$${costCad.toFixed(2)}` : "\u2014"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button onClick={handleExecuteRebalance}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
              Execute ({PROFILE_LABELS[activeProfile]})
            </button>
            {availableProfiles.length > 1 && (
              <button onClick={handleExecuteAllProfiles}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors">
                Execute All Profiles
              </button>
            )}
            <button onClick={() => { setShowRebalance(false); setRebalancePrices({}); }}
              className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-300 transition-colors">
              Cancel
            </button>
            {sortedRows.some((r) => r.modelPct > 0 && isFundservCode(r.symbol)) && (
              <span className="text-[10px] text-violet-500 ml-2">
                Mutual fund trades will be recorded as pending — settle tomorrow when NAV is available.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Settle Pending Trades Panel */}
      {showSettlement && pendingTrades.length > 0 && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-1">Settle Pending Mutual Fund Trades</h3>
          <p className="text-xs text-slate-500 mb-3">
            Enter the settlement NAV for each mutual fund. NAV is auto-fetched from Barchart — verify and adjust if needed.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-violet-200 text-xs text-slate-500">
                  <th className="text-left py-2 font-semibold">Symbol</th>
                  <th className="text-left py-2 font-semibold hidden sm:table-cell">Profile</th>
                  <th className="text-center py-2 font-semibold">Direction</th>
                  <th className="text-right py-2 font-semibold">Amount (CAD)</th>
                  <th className="text-right py-2 font-semibold">NAV Price</th>
                  <th className="text-right py-2 font-semibold">Units</th>
                  <th className="text-left py-2 font-semibold hidden md:table-cell">Trade Date</th>
                </tr>
              </thead>
              <tbody>
                {pendingTrades.map((t) => {
                  const nav = parseFloat(settlementPrices[t.symbol] || "0");
                  const units = nav > 0 && t.targetAmount ? t.targetAmount / nav : 0;
                  return (
                    <tr key={t.id} className="border-b border-violet-100">
                      <td className="py-2 font-mono text-xs font-semibold text-violet-700">{t.symbol}</td>
                      <td className="py-2 text-xs text-slate-600 hidden sm:table-cell">{PROFILE_LABELS[(t.profile || activeProfile) as PimProfileType]}</td>
                      <td className="py-2 text-center">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.direction === "sell" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                          {t.direction.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono text-xs">${(t.targetAmount || 0).toFixed(2)}</td>
                      <td className="py-2 text-right">
                        <input type="number" step="0.0001" placeholder="NAV"
                          value={settlementPrices[t.symbol] || ""}
                          onChange={(e) => setSettlementPrices((p) => ({ ...p, [t.symbol]: e.target.value }))}
                          className="w-24 rounded border border-slate-200 px-2 py-1 text-xs text-right outline-none focus:border-violet-300" />
                      </td>
                      <td className="py-2 text-right font-mono text-xs font-semibold text-violet-700">
                        {units > 0 ? units.toFixed(4) : "\u2014"}
                      </td>
                      <td className="py-2 text-xs text-slate-400 hidden md:table-cell">
                        {new Date(t.date).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button onClick={handleSettlePending}
              disabled={settling || !pendingTrades.some((t) => parseFloat(settlementPrices[t.symbol] || "0") > 0)}
              className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-700 transition-colors disabled:opacity-50">
              {settling ? "Settling..." : "Settle All"}
            </button>
            <button onClick={handleFetchSettlementPrices}
              disabled={settlementLoading}
              className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-50">
              {settlementLoading ? "Fetching..." : "Refresh NAV"}
            </button>
            <button onClick={() => { setShowSettlement(false); setSettlementPrices({}); }}
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
                  <option key={h.symbol} value={h.symbol}>{symbolToTicker(h.symbol)} — {h.name}</option>
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
          USD/CAD: {usdCadRate.toFixed(4)} (live)
          {prevCloseUsdCad > 1 && prevCloseUsdCad !== usdCadRate && (
            <span className="ml-1">| {prevCloseUsdCad.toFixed(4)} (prev close)</span>
          )}
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
