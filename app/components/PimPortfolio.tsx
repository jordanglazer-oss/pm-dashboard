"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import type {
  PimModelGroup,
  PimProfileType,
  PimProfileWeights,
  PimPortfolioPositions,
  PimPosition,
  PimTransaction,
  PimPortfolioState,
  PimHolding,
  PimModelGroupState,
} from "@/app/lib/pim-types";
import type { Stock, InstrumentType, ScoreKey } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
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

/** Queue entry shape for the Buy / Sell multi-trade panel. Defined at
 *  module scope so the useCallback in executeAllTrades doesn't need
 *  newTrade in its dep array (newTrade closes over generateId only). */
type QueuedTrade = {
  id: string;
  sellSymbol: string;
  sellPrice: string;
  sellPercent: string;
  buyTicker: string;
  buyPrice: string;
  buyName: string;
  /** Model group ids the bought ticker is INELIGIBLE for. Defaults to the
   *  auto-rule exclusion (No US Situs when the buy is US-listed/USD). The user
   *  can override per-model via the eligibility checkboxes in the buy ticket.
   *  Excluded models that held the sold ticker get the freed weight
   *  redistributed to their Core ETFs (NOT a formal rebalance). */
  excludedGroupIds: string[];
};
function newTrade(): QueuedTrade {
  return {
    id: generateId(),
    sellSymbol: "",
    sellPrice: "",
    sellPercent: "100",
    buyTicker: "",
    buyPrice: "",
    buyName: "",
    excludedGroupIds: [],
  };
}

/** US-situs detection for the No-US-Situs tax mandate. A security is US-situs
 *  (and therefore ineligible for the No US Situs model) when it is US-listed:
 *  priced in USD with no Canadian listing suffix (.TO/-T/.NE/.U) and not a
 *  FUNDSERV mutual-fund code. Canadian USD ETFs (.U) and FUNDSERV funds are
 *  NOT US-situs. Used to seed the auto-exclusion in the buy ticket. */
function isUsSitusTicker(ticker: string, currency?: string): boolean {
  const t = (ticker || "").trim().toUpperCase();
  if (!t) return false;
  // Canadian listing suffixes → never US-situs
  if (/\.TO$/.test(t) || /-T$/.test(t) || /\.NE$/.test(t) || /\.U$/.test(t)) return false;
  // FUNDSERV codes (Canadian mutual funds) → never US-situs
  if (isFundservCode(t)) return false;
  // Anything left that is USD-denominated is US-listed → US-situs.
  // If currency is unknown, treat a plain (suffix-less, non-FUNDSERV) symbol
  // as US-listed since that's the dominant case for bare tickers here.
  return currency ? currency.toUpperCase() === "USD" : true;
}

const NO_US_SITUS_GROUP_ID = "no-us-situs";

/** Compact "Xm ago" / "Xh ago" relative-time formatter for tile freshness
 *  labels. Falls back to a full date+time string past 24 hours so the
 *  number doesn't grow unwieldy. Returns "" on invalid input so callers
 *  can gate rendering on truthy. */
function formatRelTimeShort(iso: string | undefined | null): string {
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

function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

function symbolToTicker(symbol: string): string {
  if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
  return symbol;
}

const PROFILE_LABELS: Record<PimProfileType, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
  core: "Core",
};

// Asset-allocation pie for the active model profile. Driven directly by the
// profile's PimProfileWeights (equity / fixedIncome / alternatives / cash),
// so it updates live as the profile tab changes. Same SVG geometry as the
// client-report AllocationPie (200×200 viewBox, r=80, rotated -90° so the
// first slice starts at 12 o'clock).
const ALLOC_COLORS: Record<"equity" | "fixedIncome" | "alternatives" | "cash", string> = {
  equity: "#2563eb",       // blue
  fixedIncome: "#0d9488",  // teal
  alternatives: "#d97706", // amber
  cash: "#94a3b8",         // slate
};

type ClassWeights = { equity: number; fixedIncome: number; alternatives: number; cash: number };

function AssetAllocationPie({ live, target, profileLabel }: { live: ClassWeights; target: ClassWeights; profileLabel: string }) {
  // Each row carries the LIVE (drifted) weight and the TARGET weight, both as
  // percentages. The pie renders from live weights; the legend shows
  // live vs target vs drift so the PM can see where the book has drifted.
  const rows = ([
    { key: "equity", label: "Equity", color: ALLOC_COLORS.equity },
    { key: "fixedIncome", label: "Fixed Income", color: ALLOC_COLORS.fixedIncome },
    { key: "alternatives", label: "Alternatives", color: ALLOC_COLORS.alternatives },
    { key: "cash", label: "Cash", color: ALLOC_COLORS.cash },
  ] as const).map((c) => ({
    ...c,
    liveW: (live[c.key] ?? 0) * 100,
    targetW: (target[c.key] ?? 0) * 100,
  })).filter((s) => s.liveW > 0.01 || s.targetW > 0.01);

  const liveTotal = rows.reduce((acc, s) => acc + s.liveW, 0);
  const targetTotal = rows.reduce((acc, s) => acc + s.targetW, 0);
  // Render the pie from live weights once they've loaded; before prices come
  // back (live all 0) fall back to target so the chart isn't blank.
  const usingLive = liveTotal > 0.01;
  const pieField: "liveW" | "targetW" = usingLive ? "liveW" : "targetW";
  const pieTotal = usingLive ? liveTotal : targetTotal;

  if (!rows.length || pieTotal <= 0) {
    return (
      <div className="rounded-card border border-line bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold text-ink">Asset Allocation <span className="ml-2 text-[11px] font-normal text-ink-3">({profileLabel})</span></h3>
        <div className="mt-2 text-xs text-ink-3 italic">No allocation data for this model.</div>
      </div>
    );
  }

  const cx = 100, cy = 100, r = 80;
  const fractions = rows.map((s) => s[pieField] / pieTotal);
  const cumulative: number[] = [];
  fractions.reduce((sum, f) => { const next = sum + f; cumulative.push(next); return next; }, 0);

  const paths = rows.map((slice, idx) => {
    const frac = fractions[idx];
    const startAngle = (idx === 0 ? 0 : cumulative[idx - 1]) * 2 * Math.PI;
    const endAngle = cumulative[idx] * 2 * Math.PI;
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const d = frac >= 0.9999
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { slice, d };
  });

  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold text-ink">
        Asset Allocation
        <span className="ml-2 text-[11px] font-normal text-ink-3">({profileLabel})</span>
        <span className="ml-2 text-[10px] font-medium text-ink-3">{usingLive ? "Live — current market weights" : "Target (awaiting live prices)"}</span>
      </h3>
      <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-5">
        <svg
          viewBox="0 0 200 200"
          width="150"
          height="150"
          style={{ transform: "rotate(-90deg)" }}
          aria-label={`${profileLabel} live asset allocation pie chart`}
          className="shrink-0 self-center"
        >
          {paths.map(({ slice, d }) => (
            <path key={slice.key} d={d} fill={slice.color} stroke="#fff" strokeWidth={1.5} />
          ))}
        </svg>
        <div className="flex-1 text-xs">
          {/* Header row */}
          <div className="flex items-center justify-between gap-3 pb-1 mb-1 border-b border-line-soft text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
            <span>Class</span>
            <span className="flex gap-4">
              <span className="w-12 text-right">Live</span>
              <span className="w-12 text-right">Target</span>
              <span className="w-12 text-right">Drift</span>
            </span>
          </div>
          {rows.map((s) => {
            const drift = s.liveW - s.targetW;
            const driftColor = Math.abs(drift) < 0.05 ? "text-ink-3" : drift > 0 ? "text-pos" : "text-neg";
            return (
              <div key={s.key} className="flex items-center justify-between gap-3 py-0.5">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
                  <span className="text-ink">{s.label}</span>
                </span>
                <span className="flex gap-4 tabular-nums">
                  <span className="w-12 text-right font-semibold text-ink">{s.liveW.toFixed(1)}%</span>
                  <span className="w-12 text-right text-ink-3">{s.targetW.toFixed(1)}%</span>
                  <span className={`w-12 text-right font-medium ${driftColor}`}>
                    {Math.abs(drift) < 0.05 ? "—" : `${drift > 0 ? "+" : ""}${drift.toFixed(1)}`}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

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

/** Sort-direction chevron for the holdings table header. Defined at module
 *  scope (not inside the component) so it isn't re-created every render —
 *  takes the active sortField/sortDir as props. */
function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (sortField !== field) return <span className="ml-0.5 text-ink-faint">↕</span>;
  return <span className="ml-0.5 text-ink-2">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

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
  const { uiPrefs, setUiPref, stocks, pimPortfolioState, updatePimPortfolioState, getGroupState, addStock, scoredStocks, pimModels, updatePimModels, moveBucket, rebalanceStockWeights, updateStockFields } = useStocks();

  const selectedGroupId = "pim";
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("allEquity");
  const [positions, setPositions] = useState<PimPortfolioPositions[]>([]);
  // Refs that mirror the live state for use inside the Buy / Sell
  // multi-trade loop. React's setState is async — back-to-back trades
  // inside one Execute All click otherwise read stale closure values
  // and clobber each other's writes. These refs are updated
  // SYNCHRONOUSLY alongside each setState call so the next trade in
  // the queue sees the post-previous-trade state.
  const pimModelsRef = useRef(pimModels);
  const positionsRef = useRef<PimPortfolioPositions[]>([]);
  const pimPortfolioStateRef = useRef(pimPortfolioState);
  useEffect(() => { pimModelsRef.current = pimModels; }, [pimModels]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { pimPortfolioStateRef.current = pimPortfolioState; }, [pimPortfolioState]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  // Tracks when the most recent price fetch completed so the Positioning
  // summary tiles can surface a "Prices · Xm ago" indicator. Pure UI
  // signal — not persisted, not used for any math.
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);
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
  // ── Buy / Sell trade queue ───────────────────────────────────────
  // The Buy / Sell panel supports queueing multiple (sell, buy) pairs
  // and executing them together. Each row is an independent trade:
  //
  //   - sellSymbol="" + buyTicker set     → buy only (cash deployment)
  //   - sellSymbol set + buyTicker=""     → sell only (raise cash)
  //   - sellSymbol set + buyTicker set    → switch (sell + buy paired)
  //
  // sellPercent defaults to "100" — full position liquidation, which
  // routes through the original atomic-swap logic in pim-models. A
  // value <100 is a partial sell: only pm:pim-positions is touched
  // (reduce sold units by X%, increase bought units proportionally),
  // pm:pim-models stays as-is, and the sold ticker remains in Portfolio.
  const [trades, setTrades] = useState<QueuedTrade[]>(() => [newTrade()]);
  const [executingTrades, setExecutingTrades] = useState(false);
  const [tradeExecProgress, setTradeExecProgress] = useState("");

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
    const base = (["conservative", "balanced", "growth", "allEquity"] as PimProfileType[]).filter(
      (p) => selectedGroup.profiles[p]
    );
    // Alpha + Core are firm-wide standalone models — PIM group only.
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
    : availableProfiles[0] || "allEquity";

  // Keyboard navigation: ← / → cycle through available profiles
  // (balanced ↔ growth ↔ allEquity ↔ alpha). Mirrors the PimModel
  // shortcut so the two screens behave identically. PimPortfolio is
  // hardcoded to the PIM group (line 95), so up/down for group nav
  // doesn't apply here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (availableProfiles.length <= 1) return;
      const idx = availableProfiles.indexOf(activeProfile);
      const nextIdx = e.key === "ArrowRight"
        ? (idx + 1) % availableProfiles.length
        : (idx - 1 + availableProfiles.length) % availableProfiles.length;
      setSelectedProfile(availableProfiles[nextIdx]);
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [availableProfiles, activeProfile]);

  // Alpha + Core profiles = virtual 100% equity; otherwise use stored
  // profile weights. Both are equity-only standalone models.
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

    // Alpha: equity-only, EXCLUDE core ETFs, re-normalize proportionally
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

    // Core: equity-only, ONLY core ETFs (inverse of alpha filter),
    // re-normalize proportionally to sum to 100%. Mirror of Alpha.
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
    setPricesFetchedAt(new Date().toISOString());

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

  // fetchPrices flips a loading flag synchronously then resolves async — the
  // standard "refetch when the group changes" pattern, not a cascading-render
  // bug. Disable both exhaustive-deps and set-state-in-effect here.
  useEffect(() => { fetchPrices(); }, [selectedGroupId]); // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

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

      return { h, modelPct, units, costBasis, costBasisCad, price, priceCad, value, valueCad, costValue, costValueCad, fxRate };
    });

    // Total CAD value = cash + every holding's CAD value. Computed via reduce
    // AFTER the map (rather than mutating an outer `let` inside the map) so we
    // don't reassign a variable mid-render. Same value as before: the old
    // accumulator summed valueCad across ALL holdings, which is exactly this.
    const totalValueCad = (currentPositions?.cashBalance || 0)
      + rawRows.reduce((sum, r) => sum + r.valueCad, 0);

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

  // Live (drifted) asset-allocation vs target, for the active profile.
  // Aggregates each holding's live currentPct by asset class; cash is its
  // own slice (cashBalance / total). The live weights are real market
  // weights and drift from target as prices move. Returns fractions (0-1).
  const allocationBreakdown = useMemo(() => {
    if (!profileWeights || !effectiveGroup) return null;
    const classBySymbol = new Map(effectiveGroup.holdings.map((h) => [h.symbol, h.assetClass]));
    let equity = 0, fixedIncome = 0, alternatives = 0;
    for (const r of holdingRows) {
      const cls = classBySymbol.get(r.symbol);
      if (cls === "equity") equity += r.currentPct;
      else if (cls === "fixedIncome") fixedIncome += r.currentPct;
      else if (cls === "alternative") alternatives += r.currentPct;
    }
    const cash = totalValueCadSummary > 0
      ? (currentPositions?.cashBalance || 0) / totalValueCadSummary
      : 0;
    return {
      live: { equity, fixedIncome, alternatives, cash },
      target: {
        equity: profileWeights.equity ?? 0,
        fixedIncome: profileWeights.fixedIncome ?? 0,
        alternatives: profileWeights.alternatives ?? 0,
        cash: profileWeights.cash ?? 0,
      },
    };
  }, [holdingRows, effectiveGroup, profileWeights, currentPositions, totalValueCadSummary]);

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

  // Live blended MER across the positioning view. Uses the SAME priority
  // chain the Client Report audit page uses (Dashboard manual override →
  // Dashboard auto-fetch), with suffix-tolerant matching for -T / .TO
  // variants so model holdings stored as `FID5982` still match a
  // Dashboard entry at `FID5982-T`. A 0 from any source is treated as
  // "no credible MER" since funds/ETFs essentially never have a 0% fee.
  // Cash weight is treated as fully covered at 0% — it dilutes the
  // blended identically to a direct stock, which is correct for a PM's
  // all-in fee view. Recomputes whenever positions or prices change,
  // so the tile reflects live portfolio drift in real time.
  const blendedMerTile = useMemo(() => {
    const canon = (t: string): string => {
      const up = t.toUpperCase().trim();
      if (up.endsWith(".TO")) return up.slice(0, -3);
      if (up.endsWith("-T")) return up.slice(0, -2);
      return up;
    };
    const dashByCanon = new Map<string, (typeof stocks)[number]>();
    for (const s of stocks) dashByCanon.set(canon(s.ticker), s);
    const validEr = (v: number | null | undefined) =>
      typeof v === "number" && Number.isFinite(v) && v > 0;

    // Denominator includes cash + every holding row (whether or not we
    // can price its MER). Cash always lands in the "covered at 0%" pool.
    if (totalValueCadSummary <= 0) {
      return { blended: null as number | null, coveragePct: 0 };
    }
    let weightedSum = 0; // Σ (weightPct × MER%)
    let coveredWeightPct = 0;
    let totalWeightPct = 0;
    for (const r of holdingRows) {
      const weightPct = (r.valueCad / totalValueCadSummary) * 100;
      if (weightPct <= 0) continue;
      totalWeightPct += weightPct;
      const dash = dashByCanon.get(canon(r.symbol));
      const manual = dash?.manualExpenseRatio;
      const auto = dash?.fundData?.expenseRatio;
      const isStock =
        !dash || !dash.instrumentType || dash.instrumentType === "stock";
      if (validEr(manual)) {
        weightedSum += weightPct * (manual as number);
        coveredWeightPct += weightPct;
      } else if (validEr(auto)) {
        weightedSum += weightPct * (auto as number);
        coveredWeightPct += weightPct;
      } else if (isStock) {
        // Direct equity (or unknown ticker that isn't a Dashboard fund)
        // contributes 0% with full coverage.
        coveredWeightPct += weightPct;
      }
      // else: Dashboard fund with no credible MER on file → uncovered.
    }
    // Cash slice: treat as covered at 0%.
    const cashWeightPct = (cashBalance / totalValueCadSummary) * 100;
    if (cashWeightPct > 0) {
      totalWeightPct += cashWeightPct;
      coveredWeightPct += cashWeightPct;
    }
    const blended =
      coveredWeightPct > 0 ? weightedSum / coveredWeightPct : null;
    const coveragePct =
      totalWeightPct > 0 ? (coveredWeightPct / totalWeightPct) * 100 : 0;
    return { blended, coveragePct };
  }, [holdingRows, totalValueCadSummary, cashBalance, stocks]);

  // Per-symbol "fund missing its MER" check for the positioning table's
  // warning badge. A holding flags ⚠ when it's a fund/ETF (FUNDSERV code,
  // or instrumentType etf/mutual-fund on its Dashboard stock) AND has no
  // credible MER (neither a manual override nor a valid auto-fetched
  // expense ratio > 0). Individual stocks never flag — they have no MER.
  // Mirrors the canon/validEr logic in the blended-MER tile so the two
  // always agree on what counts as a missing MER.
  const fundMissingMer = useCallback((symbol: string): boolean => {
    const canon = (t: string): string => {
      const up = t.toUpperCase().trim();
      if (up.endsWith(".TO")) return up.slice(0, -3);
      if (up.endsWith("-T")) return up.slice(0, -2);
      return up;
    };
    const target = canon(symbol);
    const stock = stocks.find((s) => canon(s.ticker) === target);
    const isFund =
      isFundservCode(symbol) ||
      stock?.instrumentType === "etf" ||
      stock?.instrumentType === "mutual-fund";
    if (!isFund) return false;
    const validEr = (v: number | null | undefined) =>
      typeof v === "number" && Number.isFinite(v) && v > 0;
    return !(validEr(stock?.manualExpenseRatio) || validEr(stock?.fundData?.expenseRatio));
  }, [stocks]);

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

  const hasPositions = holdingRows.some((r) => r.units > 0);
  const thClass = "py-2 px-2 cursor-pointer hover:bg-surface-2 transition-colors text-[10px] font-bold uppercase tracking-wider text-ink-3 select-none whitespace-nowrap";

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

  // handleResolveBuyTicker (free-text ticker name lookup) was removed
  // when the Buy input switched to a Watchlist-only dropdown — the name
  // is now read directly from the picked Stock instead of being
  // resolved via /api/company-name on blur.

  /**
   * Execute a single trade from the Buy / Sell queue.
   *
   * Three shapes a trade can take:
   *   - Buy-only:     sellSymbol="", buyTicker set      → deploy cash
   *   - Sell-only:    sellSymbol set,  buyTicker=""     → raise cash
   *   - Switch:       both set                          → sell then buy
   *
   * Partial sell (sellPercent < 100):
   *   - pm:pim-positions: reduce sold units by X%, route proceeds into
   *     the bought position. Per-unit cost basis on the residual sold
   *     position is preserved.
   *   - pm:stocks: sold STAYS in Portfolio (not demoted to Watchlist).
   *   - pm:pim-models: NOT touched — target model weights are a
   *     separate concern from realized positions.
   *
   * Full sell (sellPercent === 100, the default):
   *   - All of the above plus the original atomic pim-models swap and
   *     Portfolio → Watchlist demotion for the sold ticker.
   *
   * Returns { ok, error } so the multi-trade caller can surface per-row
   * results.
   */
  const executeTrade = useCallback(async (trade: QueuedTrade): Promise<{ ok: boolean; error?: string; warning?: string }> => {
    const sellPrice = trade.sellSymbol ? parseFloat(trade.sellPrice) : 0;
    const buyPrice = trade.buyTicker ? parseFloat(trade.buyPrice) : 0;
    const buyTicker = trade.buyTicker.trim().toUpperCase();
    const sellPercentRaw = parseFloat(trade.sellPercent);
    const sellPercent = Number.isFinite(sellPercentRaw)
      ? Math.max(1, Math.min(100, sellPercentRaw))
      : 100;
    const isPartialSell = !!trade.sellSymbol && sellPercent < 100;
    const sellOnly = !!trade.sellSymbol && !buyTicker;
    const buyOnly = !trade.sellSymbol && !!buyTicker;

    // Validation per trade.
    if (!buyTicker && !trade.sellSymbol) {
      return { ok: false, error: "Empty trade — pick a sell, a buy, or both" };
    }
    if (buyTicker && !buyPrice) {
      return { ok: false, error: `${buyTicker}: buy price required` };
    }
    if (trade.sellSymbol && !sellPrice) {
      return { ok: false, error: `${trade.sellSymbol}: sell price required` };
    }

    // Local ticker-matcher (mirrors the one in StockContext).
    const tickerEq = (a: string, b: string) =>
      a === b || a.replace("-T", ".TO") === b.replace("-T", ".TO");

    // ── Capture PRE-mutation pim-models snapshot for the atomic swap.
    // A single Execute Switch action is treated as ONE firm-wide position
    // change: the bought ticker replaces the sold ticker in EVERY group
    // that currently holds the sold ticker, inheriting each group's own
    // weightInClass and rebalance-price drift. Groups that already hold
    // the bought ticker are skipped (to avoid double-holding) and surfaced
    // to the user. Groups without the sold ticker are untouched.
    // Read from refs so back-to-back trades in Execute All see the
    // post-previous-trade state. Reading from `pimModels` directly
    // would close over the pre-loop snapshot for every iteration.
    const originalPim = pimModelsRef.current;
    const nowIso = new Date().toISOString();

    type SwapPlan = {
      groupId: string;
      groupName: string;
      soldHolding: PimHolding;
    };
    const swapPlan: SwapPlan[] = [];
    const skippedDueToBoughtPresent: string[] = [];
    if (trade.sellSymbol) {
      for (const g of originalPim.groups) {
        const sold = g.holdings.find((h) => tickerEq(h.symbol, trade.sellSymbol));
        if (!sold) continue;
        const boughtAlreadyPresent = g.holdings.some((h) => tickerEq(h.symbol, buyTicker));
        if (boughtAlreadyPresent) {
          skippedDueToBoughtPresent.push(g.name);
          continue;
        }
        swapPlan.push({ groupId: g.id, groupName: g.name, soldHolding: sold });
      }
    }
    const affectedGroupIds = new Set(swapPlan.map((p) => p.groupId));

    // ── Resolve buy-side metadata up front so the atomic swap and the
    // addStock call share the same name / instrumentType / sector.
    // Only relevant when there IS a buy side — sell-only trades skip
    // this whole block.
    // ── Per-model eligibility for the bought ticker.
    // `trade.excludedGroupIds` is the set of model groups the user (or the
    // No-US-Situs auto-rule) has marked the buy INELIGIBLE for. Build the
    // full eligibility map so it can be persisted on pm:stocks (stock-page
    // display + future ops) and consulted by addToPimModels on pure buys.
    const excludedSet = new Set(trade.excludedGroupIds || []);
    const eligibilityMap: Record<string, boolean> = {};
    for (const g of originalPim.groups) {
      eligibilityMap[g.id] = !excludedSet.has(g.id);
    }

    let buyName = trade.buyName || buyTicker;
    let buyInstrumentType: InstrumentType = "stock";
    let buySector = "";
    if (buyTicker) {
      // Important distinction:
      //   - existingStock — stock exists in ANY bucket (Portfolio OR Watchlist).
      //   - isOnWatchlist — stock exists but bucket === "Watchlist" today.
      // The Buy/Sell flow needs to promote a held-on-Watchlist name to
      // Portfolio so the Dashboard + stock pages reflect that it's now owned.
      // Previous version checked `scoredStocks.some(...)` and called the
      // result `existsInPortfolio`, but scoredStocks includes BOTH buckets —
      // so buying a Watchlist name silently left the bucket unchanged while
      // pim-models / positions were updated correctly. That mismatch is what
      // left AVGO + ORCL stuck on the Watchlist after the last trade.
      const existingStock = stocks.find((s) => tickerEq(s.ticker, buyTicker));
      const isOnWatchlist = existingStock?.bucket === "Watchlist";
      try {
        const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(buyTicker)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.names?.[buyTicker]) buyName = data.names[buyTicker];
          if (data.sectors?.[buyTicker]) buySector = data.sectors[buyTicker];
          if (data.types?.[buyTicker]) buyInstrumentType = data.types[buyTicker] as InstrumentType;
        }
      } catch { /* fallback to defaults */ }

      if (!existingStock) {
        const stock: Stock = {
          ticker: buyTicker,
          name: buyName,
          instrumentType: buyInstrumentType,
          bucket: "Portfolio",
          sector: buyInstrumentType === "etf" || buyInstrumentType === "mutual-fund" ? "" : buySector,
          beta: 1.0,
          weights: { portfolio: 0 },
          scores: { ...ZERO_SCORES },
          notes: "",
          ...(excludedSet.size > 0 ? { modelEligibility: eligibilityMap } : {}),
        };
        addStock(stock);
      } else {
        // Persist any user-set eligibility BEFORE the bucket flip so the
        // addToPimModels triggered by moveBucket (Watchlist → Portfolio)
        // respects the choice. (For switches the atomic swap below
        // overrides pim-models membership anyway, but eligibility still
        // needs to land on the stock for stock-page consistency.)
        if (excludedSet.size > 0) {
          updateStockFields(buyTicker, { modelEligibility: eligibilityMap });
        }
        // Promote Watchlist → Portfolio. Synchronously flips bucket on
        // pm:stocks; the atomic swap below then overrides the pim-models
        // state (which moveBucket touches via addToPimModels). Order is
        // safe: the atomic swap runs last and `updatePimModels(nextPim)`
        // is built from pimModelsRef.current, so it wins.
        if (isOnWatchlist) {
          moveBucket(existingStock.ticker);
        }
      }
    }

    // ── Move sold ticker Portfolio → Watchlist (operates on pm:stocks,
    // which is not per-group). moveBucket triggers removeFromPimModels
    // which rebalances; that's overwritten below by the atomic swap so
    // the intermediate state doesn't survive.
    //
    // SKIPPED for partial sells — the position is being reduced, not
    // closed out, so the stock stays in Portfolio.
    if (trade.sellSymbol && !isPartialSell) {
      const soldStock = stocks.find((s) => tickerEq(s.ticker, trade.sellSymbol));
      if (soldStock?.bucket === "Portfolio") {
        moveBucket(soldStock.ticker);
      }
    }

    // ── Atomic firm-wide swap in pm:pim-models.
    // SKIPPED for partial sells — target model weights stay as
    // designed; only the realized position shifts.
    if (swapPlan.length > 0 && !isPartialSell && buyTicker) {
      const buyCurrency: "CAD" | "USD" =
        buyTicker.endsWith(".U")
          ? "USD"
          : buyTicker.endsWith("-T") || buyTicker.endsWith(".TO")
            ? "CAD"
            : swapPlan[0].soldHolding.currency; // inherit when suffix is silent
      const updatedGroups = originalPim.groups.map((g) => {
        const plan = swapPlan.find((p) => p.groupId === g.id);
        if (!plan) return g;
        if (excludedSet.has(g.id)) {
          // Buy is INELIGIBLE for this model (e.g. No US Situs + US-listed
          // buy). Remove the sold holding and redistribute its freed weight
          // to this group's Core ETFs via rebalanceStockWeights. This is NOT
          // the formal Rebalance feature — no transaction log, no rebalance
          // prices, no drift reset; just a weight redistribution so the
          // class still sums to 100%.
          const sold = plan.soldHolding;
          const remaining = g.holdings.filter((h) => h !== sold);
          // Prefer same-currency Core ETFs so the 50/50 CAD/USD balance is
          // preserved (e.g. a freed USD weight flows to XUU.U / XUS.U, not
          // the CAD Core ETFs). Distribute proportional to current weight.
          const sameCcyCore = remaining.filter(
            (h) => h.assetClass === "equity" && h.currency === sold.currency &&
              coreSymbols.has(symbolToTicker(h.symbol)),
          );
          if (sameCcyCore.length === 0) {
            // No same-currency Core ETF in this group (e.g. PC USA's CAD
            // sleeve is stocks-only) — fall back to the generic Core
            // redistribution so the class still sums to 100%.
            return { ...g, holdings: rebalanceStockWeights(remaining, undefined, g.id) };
          }
          const coreTotal = sameCcyCore.reduce((s, h) => s + h.weightInClass, 0);
          const freed = sold.weightInClass;
          const redistributed = remaining.map((h) => {
            if (!sameCcyCore.includes(h)) return h;
            const share = coreTotal > 0 ? h.weightInClass / coreTotal : 1 / sameCcyCore.length;
            return { ...h, weightInClass: h.weightInClass + freed * share };
          });
          return { ...g, holdings: redistributed };
        }
        return {
          ...g,
          holdings: g.holdings.map((h) =>
            h === plan.soldHolding
              ? {
                  name: buyName.toUpperCase(),
                  symbol: buyTicker,
                  currency: buyCurrency,
                  assetClass: plan.soldHolding.assetClass,
                  weightInClass: plan.soldHolding.weightInClass,
                }
              : h
          ),
        };
      });

      // ── Hard abort-guard: every touched group's per-asset-class
      // weightInClass must still sum to ~100%. The eligible-group swap
      // preserves weights exactly and rebalanceStockWeights preserves the
      // invariant by construction, so this should never fire — but if it
      // ever did, persisting would corrupt model weights. Abort instead
      // and persist NOTHING from the swap. (The pre-trade snapshot taken
      // by Execute All covers rollback of the earlier addStock/moveBucket.)
      const ASSET_CLASSES: PimHolding["assetClass"][] = ["equity", "fixedIncome", "alternative"];
      for (const g of updatedGroups) {
        if (!affectedGroupIds.has(g.id)) continue;
        for (const ac of ASSET_CLASSES) {
          const inClass = g.holdings.filter((h) => h.assetClass === ac);
          if (inClass.length === 0) continue;
          const sum = inClass.reduce((s, h) => s + h.weightInClass, 0);
          if (Math.abs(sum - 1.0) > 0.005) {
            return {
              ok: false,
              error: `Aborted: ${g.name} ${ac} weights sum to ${(sum * 100).toFixed(2)}% (expected 100%). No model changes persisted.`,
            };
          }
        }
      }

      const nextPim = { ...originalPim, groups: updatedGroups, lastUpdated: nowIso };
      updatePimModels(nextPim);
      // Sync the ref so the next trade in the queue sees this update.
      pimModelsRef.current = nextPim;
    }

    // ── Transaction log + price snapshot — propagated to EVERY affected
    // group's state so each group's Appendix shows the swap. Drift
    // inheritance is computed per-group using that group's own prior
    // rebalance price for the sold ticker. If the sold ticker wasn't in
    // any group (weird but possible), we fall back to writing just the
    // selectedGroup entry so the transaction row still lands somewhere.
    // Read from the ref so back-to-back trades see the post-previous-
    // trade transaction log + price snapshots.
    const currentPortfolioState = pimPortfolioStateRef.current;
    const existingStates = currentPortfolioState.groupStates;
    const statesToUpdateMap = new Map<string, PimModelGroupState>();

    // Seed: keep unaffected states as-is.
    for (const gs of existingStates) {
      if (!affectedGroupIds.has(gs.groupId)) {
        statesToUpdateMap.set(gs.groupId, gs);
      }
    }

    // For each affected group, build/patch its state. Three branches:
    //   - Full sell + buy:  swapPlan drives it (one entry per affected group)
    //   - Partial sell:     swapPlan is empty; log to every group that
    //                       actually holds the sold position so each
    //                       group's transaction tape reflects the reduce
    //   - Pure buy:         fallback to selectedGroupId (single txn row)
    const groupsToWrite: { groupId: string; soldWeightInClass: number }[] =
      swapPlan.length > 0
        ? swapPlan.map((p) => ({ groupId: p.groupId, soldWeightInClass: p.soldHolding.weightInClass }))
        : isPartialSell
          ? Array.from(
              new Set(
                // Read from the ref (not the `positions` closure) so back-to-
                // back partial sells pick groups from the post-previous-trade
                // state — consistent with the position math below.
                positionsRef.current
                  .filter((pp) => pp.positions.some((p) => tickerEq(p.symbol, trade.sellSymbol) && p.units > 0))
                  .map((pp) => pp.groupId),
              )
            ).map((gid) => ({ groupId: gid, soldWeightInClass: 0 }))
          : [{ groupId: selectedGroupId, soldWeightInClass: 0 }]; // fallback for pure buy / ticker-not-in-any-model

    for (const { groupId, soldWeightInClass } of groupsToWrite) {
      const existing: PimModelGroupState = existingStates.find((gs) => gs.groupId === groupId)
        ?? { groupId, lastRebalance: null, trackingStart: null, transactions: [] };
      const prices = { ...(existing.lastRebalance?.prices || {}) };

      // Update lastRebalance.prices map ONLY for full-sell + buy paths.
      // Partial sells leave model weights alone and shouldn't pollute the
      // drift-inheritance basis with a sub-position price.
      // Sell-only trades update the sold ticker's price but don't add a
      // bought-ticker entry.
      if (!isPartialSell) {
        const oldSellRebalancePrice = trade.sellSymbol ? prices[trade.sellSymbol] : undefined;
        if (trade.sellSymbol) prices[trade.sellSymbol] = sellPrice;
        if (buyTicker) {
          if (trade.sellSymbol && oldSellRebalancePrice && sellPrice > 0) {
            // Drift inheritance per-group using THIS group's prior rebalance price.
            prices[buyTicker] = buyPrice * (oldSellRebalancePrice / sellPrice);
          } else {
            prices[buyTicker] = buyPrice;
          }
        }
      }

      const txns: PimTransaction[] = [];
      const txnType: "switch" | "buy" | "sell" =
        isPartialSell ? (buyTicker ? "switch" : "sell")
          : trade.sellSymbol && buyTicker ? "switch"
          : trade.sellSymbol ? "sell"
          : "buy";
      if (trade.sellSymbol && sellPrice) {
        // Partial-sell txns include the percent in the targetWeight as a
        // convenience signal — readers (Appendix, Audit) can detect
        // partial vs full by checking the % alongside the type.
        txns.push({
          id: generateId(), date: nowIso, groupId,
          type: txnType, symbol: trade.sellSymbol, direction: "sell",
          price: sellPrice,
          targetWeight: isPartialSell ? soldWeightInClass * (sellPercent / 100) : soldWeightInClass,
          pairedWith: buyTicker || undefined,
        });
      }
      if (buyTicker && buyPrice) {
        txns.push({
          id: generateId(), date: nowIso, groupId,
          type: txnType, symbol: buyTicker, direction: "buy",
          price: buyPrice,
          targetWeight: isPartialSell ? soldWeightInClass * (sellPercent / 100) : soldWeightInClass,
          pairedWith: trade.sellSymbol || undefined,
        });
      }

      statesToUpdateMap.set(groupId, {
        ...existing,
        lastRebalance: existing.lastRebalance
          ? { ...existing.lastRebalance, prices }
          : { date: nowIso, prices },
        transactions: [...existing.transactions, ...txns],
      });
    }

    const updatedState: PimPortfolioState = {
      ...currentPortfolioState,
      groupStates: Array.from(statesToUpdateMap.values()),
      lastUpdated: nowIso,
    };
    updatePimPortfolioState(updatedState);
    // Sync the ref so the next trade sees this transaction log update.
    pimPortfolioStateRef.current = updatedState;

    // ── pm:pim-positions — rewrite each affected (group, profile)
    // combo's positions to reflect the sell + buy. Three branches
    // depending on the trade shape:
    //
    //   Full sell + buy (isPartialSell=false, buyTicker set):
    //     - Remove sold entirely; add bought sized from proceeds.
    //
    //   Partial sell + buy (isPartialSell=true, buyTicker set):
    //     - Reduce sold units by sellPercent; keep its per-unit costBasis.
    //     - Add bought sized from the partial proceeds (or merge).
    //
    //   Buy-only / sell-only:
    //     - Existing behavior: position math is skipped (the trade
    //       logs to the transaction tape, but pm:pim-positions isn't
    //       re-derived from a cash side). The PM updates positions
    //       manually for cash-only trades.
    //
    // Math:
    //   soldUnitsToTrade = soldPos.units × (sellPercent / 100)
    //   proceeds_cad     = soldUnitsToTrade × sellPrice × sellFx
    //   boughtUnits      = proceeds_cad / (buyPrice × buyFx)
    //   buyCostBasisCad  = buyPrice × buyFx  (per-unit CAD cost)
    //   When sellPercent === 100 and currencies match this reduces to the
    //   prior soldUnits × (sellPrice / buyPrice).
    if (trade.sellSymbol && buyTicker && sellPrice > 0 && buyPrice > 0) {
      const sellCurrency: "CAD" | "USD" =
        trade.sellSymbol.endsWith(".U")
          ? "USD"
          : trade.sellSymbol.endsWith("-T") || trade.sellSymbol.endsWith(".TO")
            ? "CAD"
            : "USD";
      const buyCurrencyForPos: "CAD" | "USD" =
        buyTicker.endsWith(".U")
          ? "USD"
          : buyTicker.endsWith("-T") || buyTicker.endsWith(".TO")
            ? "CAD"
            : swapPlan[0]?.soldHolding.currency ?? sellCurrency;
      const sellFx = sellCurrency === "USD" ? usdCadRate : 1;
      const buyFx = buyCurrencyForPos === "USD" ? usdCadRate : 1;
      const buyCostBasisCad = buyPrice * buyFx;
      const sellFraction = sellPercent / 100;

      // For partial sells the swapPlan is empty (we skip pim-models), so
      // affectedGroupIds is also empty. Fall back to every group whose
      // positions actually hold the sold ticker so the partial trade
      // applies wherever the position exists.
      // Read positions from the ref so back-to-back trades see the
      // post-previous-trade unit counts. Reading from `positions`
      // directly would close over the pre-loop snapshot for every
      // iteration, and trade 2's write would overwrite trade 1's.
      const currentPositions = positionsRef.current;
      const positionGroupsToTouch = isPartialSell
        ? new Set(
            currentPositions
              .filter((pp) => pp.positions.some((p) => tickerEq(p.symbol, trade.sellSymbol) && p.units > 0))
              .map((pp) => pp.groupId)
          )
        : affectedGroupIds;

      const updatedPositions = currentPositions.map((pp) => {
        if (!positionGroupsToTouch.has(pp.groupId)) return pp;
        const soldPos = pp.positions.find((p) => tickerEq(p.symbol, trade.sellSymbol));
        if (!soldPos || soldPos.units <= 0) return pp;

        const soldUnitsToTrade = soldPos.units * sellFraction;
        const remainingSoldUnits = soldPos.units - soldUnitsToTrade;
        const proceedsCad = soldUnitsToTrade * sellPrice * sellFx;
        const boughtUnits = buyCostBasisCad > 0 ? proceedsCad / buyCostBasisCad : 0;

        // Build the residual position list: optionally keep a reduced
        // sold position (partial sell), then add/merge the bought.
        const withoutSold = pp.positions.filter((p) => !tickerEq(p.symbol, trade.sellSymbol));
        const carryResidualSold = isPartialSell && remainingSoldUnits > 0
          ? [{ symbol: soldPos.symbol, units: remainingSoldUnits, costBasis: soldPos.costBasis }]
          : [];
        const baseList = [...withoutSold, ...carryResidualSold];
        const existingBought = baseList.find((p) => tickerEq(p.symbol, buyTicker));
        let nextPositions;
        if (existingBought) {
          const mergedUnits = existingBought.units + boughtUnits;
          const mergedCostBasis =
            mergedUnits > 0
              ? (existingBought.units * existingBought.costBasis + boughtUnits * buyCostBasisCad) / mergedUnits
              : buyCostBasisCad;
          nextPositions = baseList.map((p) =>
            tickerEq(p.symbol, buyTicker)
              ? { ...p, units: mergedUnits, costBasis: mergedCostBasis }
              : p
          );
        } else {
          nextPositions = [
            ...baseList,
            { symbol: buyTicker, units: boughtUnits, costBasis: buyCostBasisCad },
          ];
        }
        return { ...pp, positions: nextPositions, lastUpdated: nowIso };
      });

      setPositions(updatedPositions);
      // Sync the ref so the next trade in the queue sees this update.
      positionsRef.current = updatedPositions;
      try {
        await fetch("/api/kv/pim-positions", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portfolios: updatedPositions }),
        });
      } catch { /* non-fatal; local state is correct */ }
    }

    // Surface skipped-group warnings via the return value rather than
    // alert() — the multi-trade caller aggregates them into the
    // tradeExecProgress label so one alert popup per queue execution
    // is shown at the end (not per trade).
    const warning = skippedDueToBoughtPresent.length > 0
      ? `${buyTicker} was already held in these models — swap was NOT applied there: ${skippedDueToBoughtPresent.join(", ")}.`
      : undefined;
    return { ok: true, warning };
  }, [pimPortfolioState, selectedGroupId, updatePimPortfolioState, scoredStocks, addStock, pimModels, updatePimModels, moveBucket, stocks, positions, usdCadRate, rebalanceStockWeights, updateStockFields, coreSymbols]);

  /**
   * Run every valid trade in the queue sequentially. Skips invalid rows
   * (e.g. empty trade, missing price) and surfaces a summary at the end.
   * Each trade goes through the existing internally-consistent atomic
   * logic; if one fails, prior trades stay committed (no cross-trade
   * rollback — would need a working-state refactor).
   */
  const executeAllTrades = useCallback(async () => {
    if (executingTrades) return;
    setExecutingTrades(true);
    setTradeExecProgress("");

    // Pre-trade snapshot: freeze pm:pim-models, pm:pim-positions,
    // pm:pim-portfolio-state, pm:stocks BEFORE any mutation so we have an
    // instant-rollback point if the queue corrupts something. Fire-and-
    // forget — a snapshot failure must not block the trade itself (the
    // daily backup cron is still the long-term safety net), but we await
    // the response anyway so the snapshot finishes before pm:* keys start
    // changing under us. Non-blocking on network errors.
    try {
      await fetch("/api/admin/pre-trade-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: `executeAllTrades from PimPortfolio (${trades.filter((t) => t.sellSymbol || t.buyTicker).length} trade(s))`,
        }),
      });
    } catch (e) {
      console.warn("[PimPortfolio] pre-trade snapshot failed (continuing anyway):", e);
    }

    let executed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      // Skip trades with no sell + no buy (empty rows).
      if (!t.sellSymbol && !t.buyTicker) {
        skipped++;
        continue;
      }
      setTradeExecProgress(`Executing trade ${i + 1} of ${trades.length}...`);
      const res = await executeTrade(t);
      if (!res.ok) {
        errors.push(`Trade ${i + 1}: ${res.error || "unknown error"}`);
      } else {
        executed++;
        if (res.warning) warnings.push(`Trade ${i + 1}: ${res.warning}`);
      }
    }
    setTradeExecProgress(
      `${executed} of ${trades.length} executed${skipped > 0 ? ` · ${skipped} skipped (empty)` : ""}${errors.length > 0 ? ` · ${errors.length} failed` : ""}`
    );
    if (warnings.length > 0) {
      alert("Warnings:\n\n" + warnings.join("\n\n"));
    }
    if (errors.length > 0) {
      alert("Errors:\n\n" + errors.join("\n\n"));
    } else {
      // Clean close on full success.
      setShowSwitch(false);
      setTrades([newTrade()]);
      setTradeExecProgress("");
    }
    fetchPrices();
    setExecutingTrades(false);
  }, [trades, executingTrades, executeTrade, fetchPrices]);

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-bold text-ink">PIM</h2>

        {/* Profile tabs — horizontally scrollable so the 5-6 profiles
            (Conservative … Core) don't overflow on mobile. */}
        <div className="flex gap-1 rounded-control bg-surface-2 p-1 overflow-x-auto max-w-full">
          {availableProfiles.map((p) => (
            <button
              key={p}
              onClick={() => setSelectedProfile(p)}
              className={`shrink-0 rounded-lg px-3 sm:px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeProfile === p ? "bg-white text-ink shadow-sm" : "text-ink-3 hover:text-ink"
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
            className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-line transition-colors disabled:opacity-50"
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
              editMode ? "bg-pos text-white hover:bg-pos" : "bg-accent text-white hover:bg-accent"
            }`}
          >
            {editMode ? (saving ? "Saving..." : "Save Positions") : "Edit Positions"}
          </button>
          {editMode && (
            <button
              onClick={() => setEditMode(false)}
              className="rounded-lg bg-line px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-line transition-colors"
            >
              Cancel
            </button>
          )}
          {!editMode && (
            <button onClick={() => setShowRebalance(!showRebalance)}
              className="rounded-lg bg-pos px-3 py-1.5 text-xs font-semibold text-white hover:bg-pos transition-colors">
              Rebalance
            </button>
          )}
          {!editMode && (
            <button onClick={() => setShowSwitch(!showSwitch)}
              className="rounded-lg bg-warn px-3 py-1.5 text-xs font-semibold text-white hover:bg-warn transition-colors">
              Buy / Sell
            </button>
          )}
          {/* Client Report — opens the one-pager preview in a new tab,
              seeded with the currently-selected profile. Hidden for
              Alpha and Core because the one-pager is only built for
              the three full-model profiles (Balanced / Growth /
              All-Equity); the server-side route ALSO validates and
              falls back to Balanced if those profiles are passed. */}
          {!editMode && activeProfile !== "alpha" && activeProfile !== "core" && (
            <Link
              href={`/client-report?group=${encodeURIComponent(selectedGroupId)}&profile=${encodeURIComponent(activeProfile)}`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center leading-5 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-semibold !text-white hover:bg-[#003b7a] transition-colors"
            >
              Client Report
            </Link>
          )}
          {!editMode && pendingTrades.length > 0 && (
            <button onClick={handleOpenSettlement}
              className="rounded-lg bg-violet px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet transition-colors relative">
              Settle Pending
              <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neg text-[9px] font-bold text-white">
                {pendingTrades.length}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Last rebalance — rendered as a dedicated sub-row so its
          position doesn't shift between profiles. Previously it was
          inside the actions flex-wrap, which left it inline when
          Client Report was hidden (Alpha/Core) but pushed it onto a
          second line when Client Report was visible (Balanced /
          Growth / All-Equity). Now consistent everywhere. */}
      {groupState.lastRebalance && (
        <div className="flex justify-end -mt-2">
          <span className="text-[10px] text-ink-3">
            Last rebalance: {new Date(groupState.lastRebalance.date).toLocaleDateString()}
          </span>
        </div>
      )}

      {/* Live (drifted) asset-allocation pie for the active profile, with
          target + drift in the legend. Re-renders whenever prices refresh
          or the profile tab changes. */}
      {allocationBreakdown && (
        <AssetAllocationPie
          live={allocationBreakdown.live}
          target={allocationBreakdown.target}
          profileLabel={PROFILE_LABELS[activeProfile]}
        />
      )}

      {/* Rebalance Panel */}
      {showRebalance && (
        <div className="rounded-card border border-pos-border bg-pos-soft/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-ink mb-3">
            Rebalance Preview
            <span className="ml-2 text-[10px] font-normal text-ink-3">({PROFILE_LABELS[activeProfile]})</span>
          </h3>
          <p className="text-xs text-ink-3 mb-3">
            Target units are calculated from <strong>previous close</strong> prices to match the trading desk.
            Enter the actual execution price for ACB tracking. Mutual funds are recorded as pending and settled when NAV is available.
            Prices are shared across profiles.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-pos-border text-xs text-ink-3">
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
                    <tr key={r.symbol} className={`border-b border-emerald-100 ${isMF ? "bg-violet-soft/30" : ""}`}>
                      <td className="py-2 font-mono text-xs font-semibold">
                        <Link href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`} className="hover:underline hover:text-accent transition-colors">
                          {displayTicker(r.symbol)}
                        </Link>
                        {isMF && (
                          <span className="ml-1 rounded bg-violet-soft px-1 py-0.5 text-[8px] font-bold text-violet">FUND</span>
                        )}
                        {fundMissingMer(r.symbol) && (
                          <Link
                            href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`}
                            title="No MER on file for this fund/ETF — click to add a manual override. Missing MERs are treated as 0% in the blended-fee calc, understating total fees."
                            className="ml-1 inline-block rounded bg-warn-soft px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider text-warn hover:bg-warn transition-colors"
                          >
                            ⚠ No MER
                          </Link>
                        )}
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{pct(r.modelPct)}</td>
                      <td className="py-2 text-right font-mono text-xs" title="Based on previous close">
                        {prevCloseTotalCad > 0 ? pct(pcValueCad / prevCloseTotalCad) : pct(r.currentPct)}
                      </td>
                      {(() => {
                        const pcDrift = prevCloseTotalCad > 0 ? (pcValueCad / prevCloseTotalCad) - r.modelPct : r.driftPct;
                        return (
                          <td className={`py-2 text-right font-mono text-xs font-semibold ${pcDrift > 0 ? "text-pos" : pcDrift < 0 ? "text-neg" : "text-ink-3"}`}>
                            {pcDrift > 0 ? "+" : ""}{(pcDrift * 10000).toFixed(0)}bp
                          </td>
                        );
                      })()}
                      <td className="py-2 text-center">
                        {action !== "HOLD" && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${action === "SELL" ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"}`}>
                            {action}
                          </span>
                        )}
                        {action === "HOLD" && <span className="text-[10px] text-ink-3">{"\u2014"}</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs">{r.units > 0 ? r.units.toFixed(2) : "\u2014"}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {isMF ? (
                          <span className="text-violet" title="Units calculated at settlement">{"\u2014"}</span>
                        ) : targetUnits.toFixed(2)}
                      </td>
                      <td className={`py-2 text-right font-mono text-xs font-semibold ${action === "BUY" ? "text-pos" : action === "SELL" ? "text-neg" : "text-ink-3"}`}>
                        {action === "HOLD" ? "\u2014" : isMF ? (
                          <span title="Dollar amount — units determined at settlement">${Math.abs(deltaValueCad).toFixed(0)}</span>
                        ) : `${deltaUnits > 0 ? "+" : ""}${deltaUnits.toFixed(2)}`}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-ink-3">{pcPrice > 0 ? `$${pcPrice.toFixed(2)}` : "\u2014"}</td>
                      <td className="py-2 text-right">
                        {isMF ? (
                          <span className="text-[10px] text-violet italic">Pending</span>
                        ) : action !== "HOLD" ? (
                          <input type="number" step="0.01" placeholder="Price"
                            value={rebalancePrices[r.symbol] || ""}
                            onChange={(e) => setRebalancePrices((p) => ({ ...p, [r.symbol]: e.target.value }))}
                            className="w-20 rounded border border-line px-2 py-1 text-xs text-right outline-none focus:border-pos-border" />
                        ) : <span className="text-xs text-ink-3">{"\u2014"}</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-ink-2">
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
              className="rounded-lg bg-pos px-4 py-2 text-xs font-semibold text-white hover:bg-pos transition-colors">
              Execute ({PROFILE_LABELS[activeProfile]})
            </button>
            {availableProfiles.length > 1 && (
              <button onClick={handleExecuteAllProfiles}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent transition-colors">
                Execute All Profiles
              </button>
            )}
            <button onClick={() => { setShowRebalance(false); setRebalancePrices({}); }}
              className="rounded-lg bg-line px-4 py-2 text-xs font-semibold text-ink-2 hover:bg-line transition-colors">
              Cancel
            </button>
            {sortedRows.some((r) => r.modelPct > 0 && isFundservCode(r.symbol)) && (
              <span className="text-[10px] text-violet ml-2">
                Mutual fund trades will be recorded as pending — settle tomorrow when NAV is available.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Settle Pending Trades Panel */}
      {showSettlement && pendingTrades.length > 0 && (
        <div className="rounded-card border border-violet bg-violet-soft/50 p-5 shadow-sm">
          <h3 className="text-sm font-bold text-ink mb-1">Settle Pending Mutual Fund Trades</h3>
          <p className="text-xs text-ink-3 mb-3">
            Enter the settlement NAV for each mutual fund. NAV is auto-fetched from Barchart — verify and adjust if needed.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-violet text-xs text-ink-3">
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
                      <td className="py-2 font-mono text-xs font-semibold text-violet">{displayTicker(t.symbol)}</td>
                      <td className="py-2 text-xs text-ink-2 hidden sm:table-cell">{PROFILE_LABELS[(t.profile || activeProfile) as PimProfileType]}</td>
                      <td className="py-2 text-center">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.direction === "sell" ? "bg-neg-soft text-neg" : "bg-pos-soft text-pos"}`}>
                          {t.direction.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono text-xs">${(t.targetAmount || 0).toFixed(2)}</td>
                      <td className="py-2 text-right">
                        <input type="number" step="0.0001" placeholder="NAV"
                          value={settlementPrices[t.symbol] || ""}
                          onChange={(e) => setSettlementPrices((p) => ({ ...p, [t.symbol]: e.target.value }))}
                          className="w-24 rounded border border-line px-2 py-1 text-xs text-right outline-none focus:border-violet" />
                      </td>
                      <td className="py-2 text-right font-mono text-xs font-semibold text-violet">
                        {units > 0 ? units.toFixed(4) : "\u2014"}
                      </td>
                      <td className="py-2 text-xs text-ink-3 hidden md:table-cell">
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
              className="rounded-lg bg-violet px-4 py-2 text-xs font-semibold text-white hover:bg-violet transition-colors disabled:opacity-50">
              {settling ? "Settling..." : "Settle All"}
            </button>
            <button onClick={handleFetchSettlementPrices}
              disabled={settlementLoading}
              className="rounded-lg bg-surface-2 px-4 py-2 text-xs font-semibold text-ink-2 hover:bg-line transition-colors disabled:opacity-50">
              {settlementLoading ? "Fetching..." : "Refresh NAV"}
            </button>
            <button onClick={() => { setShowSettlement(false); setSettlementPrices({}); }}
              className="rounded-lg bg-line px-4 py-2 text-xs font-semibold text-ink-2 hover:bg-line transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Buy/Sell Panel \u2014 supports a queue of trades, each independently
          configurable as buy-only / sell-only / switch. Sell % defaults
          to 100; lower values run a partial-sell that only touches
          pm:pim-positions, not pm:pim-models (target weights stay as
          designed). Execute All runs the queue sequentially. */}
      {showSwitch && (() => {
        const watchlistStocks = stocks
          .filter((s) => s.bucket === "Watchlist")
          .slice()
          .sort((a, b) => a.ticker.localeCompare(b.ticker));
        const updateTrade = (id: string, patch: Partial<QueuedTrade>) => {
          setTrades((arr) => arr.map((t) => (t.id === id ? { ...t, ...patch } : t)));
        };
        const removeTrade = (id: string) => {
          setTrades((arr) => arr.length > 1 ? arr.filter((t) => t.id !== id) : arr);
        };
        const addTrade = () => setTrades((arr) => [...arr, newTrade()]);
        const closeAndReset = () => {
          setShowSwitch(false);
          setTrades([newTrade()]);
          setTradeExecProgress("");
        };
        const anyValid = trades.some((t) => {
          if (!t.sellSymbol && !t.buyTicker) return false;
          if (t.sellSymbol && !parseFloat(t.sellPrice)) return false;
          if (t.buyTicker && !parseFloat(t.buyPrice)) return false;
          return true;
        });
        return (
        <div className="rounded-card border border-warn-border bg-warn-soft/50 p-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h3 className="text-sm font-bold text-ink">Buy / Sell</h3>
              <p className="text-xs text-ink-3 mt-0.5">
                Queue one or more trades. Sell % defaults to 100 (full position); lower it for a partial sell \u2014 only the positions table is touched, model weights stay as designed.
              </p>
            </div>
            <button onClick={addTrade}
              className="rounded-lg bg-white border border-warn-border text-warn hover:bg-warn-soft px-3 py-1.5 text-xs font-semibold transition-colors">
              + Add another trade
            </button>
          </div>
          <div className="space-y-3">
            {trades.map((t, idx) => {
              const sellPctParsed = parseFloat(t.sellPercent);
              const isPartial = !!t.sellSymbol && Number.isFinite(sellPctParsed) && sellPctParsed > 0 && sellPctParsed < 100;
              return (
                <div key={t.id} className="rounded-control border border-line bg-white p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-3">
                      Trade {idx + 1}{isPartial ? " \u00b7 partial" : t.sellSymbol && t.buyTicker ? " \u00b7 switch" : t.sellSymbol ? " \u00b7 sell" : t.buyTicker ? " \u00b7 buy" : ""}
                    </span>
                    {trades.length > 1 && (
                      <button onClick={() => removeTrade(t.id)}
                        className="text-ink-3 hover:text-neg text-xs"
                        title="Remove this trade from the queue">
                        \u00d7 Remove
                      </button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold text-neg uppercase">Sell (optional)</label>
                      <select value={t.sellSymbol}
                        onChange={(e) => updateTrade(t.id, { sellSymbol: e.target.value, sellPrice: e.target.value ? t.sellPrice : "" })}
                        className="w-full rounded-lg border border-line bg-white text-ink px-3 py-2 text-sm outline-none focus:border-warn-border">
                        <option value="">None \u2014 buy only</option>
                {computedHoldingsForSwitch.filter((h) => h.weightInPortfolio > 0).map((h) => (
                          <option key={h.symbol} value={h.symbol}>{symbolToTicker(h.symbol)} — {h.name}</option>
                        ))}
                      </select>
                      {t.sellSymbol && (
                        <>
                          <div className="grid grid-cols-[1fr_88px] gap-2">
                            <input type="number" step="0.01" placeholder="Sell price"
                              value={t.sellPrice}
                              onChange={(e) => updateTrade(t.id, { sellPrice: e.target.value })}
                              className="w-full rounded-lg border border-line bg-white text-ink px-3 py-2 text-sm outline-none focus:border-neg-border" />
                            <div className="relative">
                              <input type="number" step="1" min="1" max="100"
                                value={t.sellPercent}
                                onChange={(e) => updateTrade(t.id, { sellPercent: e.target.value })}
                                aria-label="Percent of position to sell"
                                title="Percent of the position to sell. 100 = full liquidation (touches model weights); <100 = partial sell (positions only)."
                                className="w-full rounded-lg border border-line bg-white text-ink px-3 pr-6 py-2 text-sm outline-none focus:border-neg-border" />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-3 pointer-events-none">%</span>
                            </div>
                          </div>
                          {livePrices[t.sellSymbol] && (
                            <p className="text-[10px] text-ink-3">Market: ${livePrices[t.sellSymbol].toFixed(2)}</p>
                          )}
                          {isPartial && (
                            <p className="text-[10px] text-warn">
                              Partial sell — pim-models weights unchanged; only the realized position shifts.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold text-pos uppercase">Buy (from Watchlist)</label>
                      {watchlistStocks.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-line bg-surface-2 p-2.5 text-[11px] text-ink-3">
                          Watchlist is empty. Press <kbd className="rounded border border-line bg-white px-1 py-px text-[10px] font-mono">Shift + A</kbd> to add a research candidate first.
                        </div>
                      ) : (
                        <select value={t.buyTicker}
                          onChange={(e) => {
                            const picked = watchlistStocks.find((s) => s.ticker === e.target.value);
                            // Auto-rule: a US-listed/USD buy is US-situs → ineligible
                            // for the No US Situs tax-mandate model. Pre-checks that
                            // exclusion; user can still override via the checkboxes.
                            const autoExcluded =
                              e.target.value && isUsSitusTicker(e.target.value) &&
                              pimModels.groups.some((g) => g.id === NO_US_SITUS_GROUP_ID)
                                ? [NO_US_SITUS_GROUP_ID]
                                : [];
                            updateTrade(t.id, {
                              buyTicker: e.target.value,
                              buyName: picked?.name || e.target.value,
                              buyPrice: e.target.value ? t.buyPrice : "",
                              excludedGroupIds: autoExcluded,
                            });
                          }}
                          className="w-full rounded-lg border border-line bg-white text-ink px-3 py-2 text-sm outline-none focus:border-pos-border font-mono">
                          <option value="">— None — sell only —</option>
                          {watchlistStocks.map((s) => (
                            <option key={s.ticker} value={s.ticker}>
                              {s.ticker}{s.name && s.name !== s.ticker ? ` · ${s.name}` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      {t.buyTicker && (
                        <input type="number" step="0.01" placeholder="Buy price"
                          value={t.buyPrice}
                          onChange={(e) => updateTrade(t.id, { buyPrice: e.target.value })}
                          className="w-full rounded-lg border border-line bg-white text-ink px-3 py-2 text-sm outline-none focus:border-pos-border" />
                      )}
                    </div>
                  </div>
                  {t.buyTicker && (
                    <div className="mt-3 rounded-lg border border-line bg-surface-2 p-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-3">
                          Eligible models for {t.buyTicker}
                        </span>
                        {t.excludedGroupIds.includes(NO_US_SITUS_GROUP_ID) &&
                          isUsSitusTicker(t.buyTicker) && (
                          <span className="text-[10px] text-warn">
                            No US Situs auto-excluded (US-listed)
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {pimModels.groups.map((g) => {
                          const eligible = !t.excludedGroupIds.includes(g.id);
                          return (
                            <label key={g.id} className="inline-flex items-center gap-1.5 text-xs text-ink cursor-pointer">
                              <input
                                type="checkbox"
                                checked={eligible}
                                onChange={(e) => {
                                  const next = new Set(t.excludedGroupIds);
                                  if (e.target.checked) next.delete(g.id);
                                  else next.add(g.id);
                                  updateTrade(t.id, { excludedGroupIds: [...next] });
                                }}
                                className="h-3.5 w-3.5 rounded border-line"
                              />
                              {g.name}
                            </label>
                          );
                        })}
                      </div>
                      {t.sellSymbol && t.excludedGroupIds.length > 0 && (
                        <p className="mt-1.5 text-[10px] text-ink-3">
                          For excluded models that hold {symbolToTicker(t.sellSymbol)}, the freed weight is redistributed to that model&apos;s Core ETFs (not a formal rebalance).
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {tradeExecProgress && (
            <p className="mt-3 text-xs text-warn">{tradeExecProgress}</p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => void executeAllTrades()}
              disabled={!anyValid || executingTrades}
              className="rounded-lg bg-warn px-4 py-2 text-xs font-semibold text-white hover:bg-warn transition-colors disabled:opacity-50">
              {executingTrades ? "Executing..." : `Execute All (${trades.length})`}
            </button>
            <button onClick={closeAndReset}
              disabled={executingTrades}
              className="rounded-lg bg-line px-4 py-2 text-xs font-semibold text-ink-2 hover:bg-line transition-colors disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
        );
      })()}

      {/* Portfolio summary (all CAD) */}
      {pricesFetchedAt && (
        <div className="flex justify-end text-[11px] text-ink-3">
          <span title="When live prices and FX were last fetched from Yahoo. Refreshes when the page mounts or the group changes.">
            Prices updated {formatRelTimeShort(pricesFetchedAt)}
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="rounded-control border border-line bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Total Value (CAD)</div>
          <div className="text-lg font-bold text-ink">{fmtCurrency(totalValueCadSummary)}</div>
        </div>
        <div className="rounded-control border border-line bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Total ACB (CAD)</div>
          <div className="text-lg font-bold text-ink">{fmtCurrency(totalCostCad)}</div>
        </div>
        <div className="rounded-control border border-line bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Gain/Loss</div>
          <div className={`text-lg font-bold ${totalValueCadSummary - totalCostCad >= 0 ? "text-pos" : "text-neg"}`}>
            {fmtCurrency(totalValueCadSummary - totalCostCad)}
          </div>
        </div>
        <div className="rounded-control border border-line bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Return</div>
          <div className={`text-lg font-bold ${totalCostCad > 0 && totalValueCadSummary - totalCostCad >= 0 ? "text-pos" : "text-neg"}`}>
            {totalCostCad > 0 ? fmtGainLoss(((totalValueCadSummary - totalCostCad) / totalCostCad) * 100) : "--"}
          </div>
        </div>
        <div className="rounded-control border border-line bg-white p-4 text-center">
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Today</div>
          <div className={`text-lg font-bold ${todayReturn != null && todayReturn >= 0 ? "text-pos" : "text-neg"}`}>
            {todayReturn != null ? fmtGainLoss(todayReturn) : "--"}
          </div>
        </div>
        <div
          className="rounded-control border border-line bg-white p-4 text-center"
          title="Weighted-average management expense ratio across the current positions. Updates live as weights drift. Cash and direct equities contribute 0%. Funds without an MER on the Dashboard are excluded from the denominator — check the coverage % if the number looks low."
        >
          <div className="text-[10px] font-semibold text-ink-3 uppercase">Blended MER</div>
          <div className="text-lg font-bold text-ink">
            {blendedMerTile.blended != null
              ? `${blendedMerTile.blended.toFixed(2)}%`
              : "--"}
          </div>
          <div className="text-[9px] text-ink-3">
            {blendedMerTile.coveragePct >= 99.5
              ? `Cash ${pct(cashPct)}`
              : `${blendedMerTile.coveragePct.toFixed(0)}% covered · Cash ${pct(cashPct)}`}
          </div>
        </div>
      </div>

      {/* USD/CAD rate indicator */}
      {usdCadRate > 1 && (
        <div className="flex items-center gap-2 text-[10px] text-ink-3">
          <span className="inline-block w-2 h-2 rounded-full bg-accent" />
          USD/CAD: {usdCadRate.toFixed(4)} (live)
          {prevCloseUsdCad > 1 && prevCloseUsdCad !== usdCadRate && (
            <span className="ml-1">| {prevCloseUsdCad.toFixed(4)} (prev close)</span>
          )}
        </div>
      )}

      {/* Holdings table */}
      <div className="rounded-card border border-line bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2 shadow-[0_1px_0_0_rgb(226_232_240)]">
              <tr className="border-b border-line-soft bg-surface-2">
                <th className={`text-left ${thClass}`} onClick={() => handleSort("symbol")}>
                  Symbol<SortIcon field="symbol" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-left ${thClass}`} onClick={() => handleSort("name")}>
                  Name<SortIcon field="name" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("units")}>
                  Units<SortIcon field="units" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("price")}>
                  Price<SortIcon field="price" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("value")}>
                  Value (CAD)<SortIcon field="value" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("acb")}>
                  ACB (CAD)<SortIcon field="acb" sortField={sortField} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("modelPct")}>
                  Model %<SortIcon field="modelPct" sortField={sortField} sortDir={sortDir} />
                </th>
                {hasPositions && (
                  <>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("currentPct")}>
                      Current %<SortIcon field="currentPct" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-center ${thClass}`} onClick={() => handleSort("drift")}>
                      Action<SortIcon field="drift" sortField={sortField} sortDir={sortDir} />
                    </th>
                    <th className={`text-right ${thClass}`} onClick={() => handleSort("gainLoss")}>
                      Gain/Loss<SortIcon field="gainLoss" sortField={sortField} sortDir={sortDir} />
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {/* Cash row removed from UI — cashBalance is still tracked in
                  pm:pim-positions and feeds total value + MER coverage. To
                  expose an edit affordance for cash again, re-add this row
                  or surface an inline input elsewhere. */}

              {sortedRows.map((row) => {
                const currBadge = row.currency === "USD" ? (
                  <span className="ml-1 inline-block rounded bg-accent-soft px-1 py-0 text-[8px] font-bold text-accent align-middle">USD</span>
                ) : null;

                return (
                  <tr key={row.symbol} className="border-b border-line-soft hover:bg-slate-25 transition-colors">
                    <td className="py-2.5 px-2 font-semibold text-ink">{displayTicker(row.symbol)}</td>
                    <td className="py-2.5 px-2 text-ink-2 max-w-[200px] truncate">{row.name}</td>
                    <td className="py-2.5 px-2 text-right font-mono text-ink">
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
                          className="w-24 rounded border border-line px-2 py-1 text-right text-xs font-mono"
                          step="0.0001"
                        />
                      ) : (
                        row.units > 0 ? fmtUnits(row.units) : "-"
                      )}
                    </td>
                    {/* Price in instrument currency */}
                    <td className="py-2.5 px-2 text-right font-mono text-ink">
                      {row.price > 0 ? (
                        <span>${row.price.toFixed(2)}{currBadge}</span>
                      ) : "-"}
                    </td>
                    {/* Market Value in CAD */}
                    <td className="py-2.5 px-2 text-right font-mono font-semibold text-ink">
                      {row.valueCad > 0 ? fmtCurrency(row.valueCad) : "-"}
                    </td>
                    {/* ACB (Book Cost) in CAD */}
                    <td className="py-2.5 px-2 text-right font-mono text-ink-2">
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
                            className="w-20 rounded border border-line px-2 py-1 text-right text-xs font-mono"
                            step="0.01"
                            placeholder={`Cost (${row.currency})`}
                          />
                        </div>
                      )}
                      {row.costValueCad > 0 ? fmtCurrency(row.costValueCad) : "-"}
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono text-ink-2">{pct(row.modelPct)}</td>
                    {hasPositions && (
                      <>
                        <td className="py-2.5 px-2 text-right font-mono text-ink">{row.units > 0 ? pct(row.currentPct) : "-"}</td>
                        <td className="py-2.5 px-2 text-center">
                          {row.units > 0 ? (
                            <span className={`inline-block rounded px-2 py-0.5 text-[9px] font-bold ${
                              row.action === "BUY" ? "bg-pos-soft text-pos" :
                              row.action === "SELL" ? "bg-neg-soft text-neg" :
                              "bg-surface-2 text-ink-3"
                            }`}>
                              {row.action}
                            </span>
                          ) : (
                            <span className="inline-block rounded px-2 py-0.5 text-[9px] font-bold bg-pos-soft text-pos">BUY</span>
                          )}
                        </td>
                        <td className={`py-2.5 px-2 text-right font-mono font-semibold ${row.gainLoss >= 0 ? "text-pos" : "text-neg"}`}>
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
        <div className="rounded-control border border-dashed border-line bg-surface-2 p-6 text-center">
          <p className="text-sm text-ink-3 mb-2">No position data entered yet.</p>
          <p className="text-xs text-ink-3 mb-4">
            Enter your current holdings (units and cost basis) to see current weights, drift, and rebalance actions.
          </p>
          <button
            onClick={startEdit}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent transition-colors"
          >
            Enter Positions
          </button>
        </div>
      )}
    </div>
  );
}
