"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
  PimAssetClass,
  PimModelData,
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
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { SkeletonTable } from "@/app/components/Skeleton";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { StatStrip } from "@/app/components/StatStrip";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { isMarketOpenOrAfterET } from "@/app/lib/market-hours";
import { apportionColumn, fmtPct2, sameAtDisplay } from "@/app/lib/display-weights";
import { planTrade } from "@/app/lib/trade-plan";

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
  /** Model group ids this trade does NOT apply to. Defaults to the auto-rule
   *  exclusion (No US Situs when the buy is US-listed/USD); user-overridable
   *  via the checkboxes in the buy ticket. An unticked model is left
   *  COMPLETELY untouched — no sell, no buy, no position change, no
   *  transaction row. (The old semantics executed the sell leg there and
   *  redistributed the freed weight, skewing sleeves the PM had opted out
   *  of.) */
  excludedGroupIds: string[];
  /** Which model sleeve the bought security belongs to. Defaults from the
   *  sold holding's class (switches) or a name heuristic (pure buys); shown
   *  as an explicit selector in the buy ticket so a bond fund can never be
   *  silently filed under equity. The executor REQUIRES buy class === sold
   *  class on a switch — a cross-class switch is an asset-mix change, which
   *  profile allocations own, not weightInClass. */
  buyAssetClass: PimAssetClass;
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
    buyAssetClass: "equity",
  };
}

/** Default sleeve for a bought security, from its name/ticker. Mirrors the
 *  keyword set in StockContext.detectAssetClass. Only a DEFAULT — the buy
 *  ticket shows the result as an editable selector. */
function guessAssetClass(name: string, ticker: string): PimAssetClass {
  const s = `${name || ""} ${ticker || ""}`.toLowerCase();
  if (/bond|fixed income|aggregate|treasur/.test(s)) return "fixedIncome";
  if (/premium yield|premium incom|covered call|option income|option writing|alternative|hedge/.test(s)) return "alternative";
  return "equity";
}

/** Redistribute weight freed inside a NON-EQUITY sleeve to that sleeve's
 *  remaining holdings, proportional to their current weights. Equity has the
 *  Core-absorbs-residual rule (rebalanceStockWeights); fixed income and
 *  alternatives have no Core sleeve, so the sleeve must rebalance itself or
 *  the class sum breaks and the trade guard aborts.
 *
 *  `holdings` is the FULL group holdings list with the sold holding already
 *  trimmed/removed. Returns the adjusted list, or null when no sibling in the
 *  sleeve can absorb the weight (sole-holding sleeve) — callers must treat
 *  null as "cannot be expressed in the model" and either warn or abort. */
function redistributeWithinClass(
  holdings: PimHolding[],
  assetClass: PimAssetClass,
  excludeSymbol: string,
  freed: number,
): PimHolding[] | null {
  if (freed <= 0) return holdings;
  const siblings = holdings.filter(
    (h) => h.assetClass === assetClass && !symbolEq(h.symbol, excludeSymbol) && h.weightInClass > 0,
  );
  const siblingTotal = siblings.reduce((s, h) => s + h.weightInClass, 0);
  if (siblings.length === 0 || siblingTotal <= 0) return null;
  return holdings.map((h) =>
    siblings.includes(h)
      ? { ...h, weightInClass: h.weightInClass + freed * (h.weightInClass / siblingTotal) }
      : h,
  );
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

/** Symbol comparison tolerant of the -T / .TO Canadian listing variants, which
 *  are NOT normalized at the storage layer (see CLAUDE.md). */
const symbolEq = (a: string, b: string): boolean => {
  const n = (x: string) => (x || "").toUpperCase().replace(/-T$/, ".TO");
  return n(a) === n(b);
};

/** Currency of a bare symbol, matching the rule used by the trade executor:
 *  .U is a Canadian-listed USD class, .TO/-T/.NE are CAD, anything else USD. */
const tickerIsUsd = (sym: string): boolean => {
  const t = (sym || "").toUpperCase();
  if (t.endsWith(".U")) return true;
  if (t.endsWith(".TO") || t.endsWith("-T") || t.endsWith(".NE")) return false;
  return true;
};

/**
 * Abort-guard shared by both model-write paths (full switch and partial sell).
 *
 * Every touched group's per-asset-class weightInClass must still sum to ~100%.
 * Both paths preserve the invariant by construction, so this should never
 * fire — but if it ever did, persisting would corrupt model weights, so the
 * trade aborts and persists NOTHING.
 *
 * Compared against the PRE-trade sums, not against 100% in the absolute. The
 * absolute check once turned a pre-existing problem into a permanent block on
 * all trading: a switch was aborted because an untouched fixed-income sleeve
 * in another group already summed to 150%, which the trade neither caused nor
 * could fix. The guard exists to stop a trade CORRUPTING weights, so it asks
 * whether this trade made things worse — a sleeve already broken and no worse
 * for the trade is reported, not blocked.
 *
 * Returns an error string to abort with, or null when it is safe to persist.
 */
function assertClassSumsSafe(
  beforeGroups: PimModelGroup[],
  afterGroups: PimModelGroup[],
  affectedGroupIds: Set<string>,
): string | null {
  const ASSET_CLASSES: PimHolding["assetClass"][] = ["equity", "fixedIncome", "alternative"];
  const TOL = 0.005;
  const classSum = (holdings: PimHolding[], ac: PimHolding["assetClass"]) => {
    const inClass = holdings.filter((h) => h.assetClass === ac);
    return inClass.length === 0 ? null : inClass.reduce((s, h) => s + h.weightInClass, 0);
  };
  const preExisting: string[] = [];
  for (const g of afterGroups) {
    if (!affectedGroupIds.has(g.id)) continue;
    const before = beforeGroups.find((x) => x.id === g.id);
    for (const ac of ASSET_CLASSES) {
      const after = classSum(g.holdings, ac);
      if (after == null) continue;
      const beforeSum = before ? (classSum(before.holdings, ac) ?? 1) : 1;
      const wasOff = Math.abs(beforeSum - 1) > TOL;
      if (Math.abs(after - 1) <= TOL) continue;
      if (!wasOff) {
        return `Aborted: this trade would leave ${g.name} ${ac} at ${(after * 100).toFixed(2)}% (expected 100%). No model changes persisted.`;
      }
      if (Math.abs(after - 1) > Math.abs(beforeSum - 1) + 1e-9) {
        return `Aborted: ${g.name} ${ac} was already at ${(beforeSum * 100).toFixed(2)}% and this trade would push it to ${(after * 100).toFixed(2)}%. No model changes persisted.`;
      }
      preExisting.push(`${g.name} ${ac} ${(after * 100).toFixed(2)}%`);
    }
  }
  if (preExisting.length > 0) {
    // Not fatal to this trade, but it must not pass unnoticed — the sleeve is
    // genuinely wrong and needs repairing.
    console.warn(
      "[buy/sell] pre-existing model weight problems, untouched by this trade:",
      preExisting.join("; "),
    );
  }
  return null;
}

/**
 * Post-write reconciliation: does the book agree with the model?
 *
 * Run after every executed trade against the state that was just persisted.
 * The recurring failure in this feature is not a bad number, it is a SILENT
 * divergence between pm:pim-models and pm:pim-positions — a position with no
 * model holding (invisible on Positioning, which iterates model holdings) or
 * a model holding with no units (contributes nothing to performance). Both
 * have shipped to production undetected more than once. Neither is allowed to
 * pass quietly again.
 *
 * Only groups that actually carry position records are checked; the models
 * that aren't position-tracked would otherwise report every holding as
 * unitless.
 */
function reconcileModelsVsPositions(
  models: PimModelData,
  positions: PimPortfolioPositions[],
  tickerEq: (a: string, b: string) => boolean,
): string[] {
  const problems: string[] = [];
  const trackedGroupIds = new Set(positions.map((p) => p.groupId));

  for (const pp of positions) {
    const group = models.groups.find((g) => g.id === pp.groupId);
    if (!group) continue;
    for (const pos of pp.positions) {
      if (pos.units <= 0) continue;
      if (!group.holdings.some((h) => tickerEq(h.symbol, pos.symbol))) {
        problems.push(
          `${pos.symbol}: ${pos.units.toFixed(2)} units in ${group.name}/${pp.profile} but it is NOT a holding in that model — it will not appear on Positioning.`,
        );
      }
    }
  }

  for (const group of models.groups) {
    if (!trackedGroupIds.has(group.id)) continue;
    for (const h of group.holdings) {
      if (h.weightInClass <= 0) continue;
      const anyUnits = positions.some(
        (pp) => pp.groupId === group.id && pp.positions.some((p) => tickerEq(p.symbol, h.symbol) && p.units > 0),
      );
      if (!anyUnits) {
        problems.push(
          `${h.symbol}: ${group.name} targets ${(h.weightInClass * 100).toFixed(2)}% of class but holds 0 units — it contributes nothing to performance.`,
        );
      }
    }
  }
  return problems;
}

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

// ── Workspace control vocabulary (see design-pro/BUILD-BRIEF.md) ──
const BTN_SECONDARY = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const BTN_PRIMARY = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2 disabled:opacity-50";
const BTN_ICON = "grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent-border";
const MENU_ITEM = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-50";

/** Positions table views (persisted in pm:ui-prefs as `positioning.view`). */
type PosView = "drift" | "value" | "gain";
const POS_VIEWS: { id: PosView; label: string }[] = [
  { id: "drift", label: "Drift" },
  { id: "value", label: "Value" },
  { id: "gain", label: "Gain" },
];

/** Display threshold for "outside tolerance" (0.5pp of portfolio weight):
 *  colours the drift bar/figure warn and feeds the footer count. Render-only —
 *  no rebalance or trade path reads it. */
const DRIFT_TOLERANCE = 0.005;

/** One row of the rebalance preview (previous-close basis). */
type RebalanceRow = {
  symbol: string;
  currency: "CAD" | "USD";
  isMF: boolean;
  action: "BUY" | "SELL" | "HOLD";
  modelPct: number;
  pcCurrentPct: number;
  pcDrift: number;
  units: number;
  targetUnits: number;
  deltaUnits: number;
  deltaValueCad: number;
  pcPrice: number;
  costCad: number;
};

/** "C$1,284,410" — whole dollars for meta text. */
function fmtCad0(v: number): string {
  return `${v < 0 ? "−" : ""}C$${Math.abs(Math.round(v)).toLocaleString("en-CA")}`;
}
/** "1,284,410" — whole dollars for table cells (currency lives in the header). */
function fmtN0(v: number): string {
  return Math.round(v).toLocaleString("en-CA");
}

/** Centre-ticked drift bar: fill grows right for overweight, left for under.
 *  `drift` is in percentage points; `scalePp` fills half the track. */
function DriftBar({ drift, scalePp, warn }: { drift: number | null; scalePp: number; warn: boolean }) {
  const w = drift == null ? 0 : Math.min(50, (Math.abs(drift) / scalePp) * 50);
  return (
    // Fluid rather than a hard 120px: a fixed width set the column's minimum
    // and pushed the whole table sideways in the narrow two-up column.
    <div className="relative h-1.5 w-full min-w-[64px] max-w-[120px] rounded-[3px] bg-surface-2">
      <span className="absolute -top-0.5 left-1/2 h-2.5 w-px bg-ink-faint" aria-hidden />
      {drift != null && w > 0 && (
        <i
          className={`absolute top-0 block h-1.5 rounded-[3px] ${warn ? "bg-warn" : "bg-ink-3"}`}
          style={drift > 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
        />
      )}
    </div>
  );
}

type ClassWeights = { equity: number; fixedIncome: number; alternatives: number; cash: number };

/** Allocation panel — target vs live per sleeve (bars + figures). Replaces the
 *  donut: same data, read as a table. Class weights carry the same 2dp contract
 *  as the tables (apportioned to 100.00%) so the figures agree with the
 *  per-holding columns instead of being rounded apart from them. */
function AllocationPanel({ live, target }: { live: ClassWeights; target: ClassWeights }) {
  const rows = ([
    { key: "equity", label: "Equity", bar: "bg-ink-2" },
    { key: "fixedIncome", label: "Fixed income", bar: "bg-ink-3" },
    { key: "alternatives", label: "Alternatives", bar: "bg-warn" },
    { key: "cash", label: "Cash", bar: "bg-ink-faint" },
  ] as const)
    .map((c) => ({ ...c, liveW: live[c.key] ?? 0, targetW: target[c.key] ?? 0 }))
    .filter((s) => s.liveW > 0.0001 || s.targetW > 0.0001);
  const liveTotal = rows.reduce((acc, s) => acc + s.liveW, 0);
  // Render live weights once prices are in; before that fall back to target
  // so the panel isn't blank.
  const usingLive = liveTotal > 0.0001;

  if (rows.length === 0) {
    return (
      <section className="panel animate-panel-in">
        <div className="panel-h">
          <span className="t-mark bg-hub-portfolio" aria-hidden />
          <span className="t">Allocation</span>
        </div>
        <div className="px-3.5 py-3 text-[12px] text-ink-3">No allocation data for this model.</div>
      </section>
    );
  }

  const dLive = apportionColumn(rows.map((r) => r.liveW), 1);
  const dTgt = apportionColumn(rows.map((r) => r.targetW), 1);

  return (
    <section className="panel animate-panel-in">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t-mark bg-hub-portfolio" aria-hidden />
        <span className="t">Allocation</span>
        <span className="m min-w-0 break-words">{usingLive ? "target vs live" : "target · awaiting prices"}</span>
      </div>
      <div className="stagger grid grid-cols-[minmax(0,92px)_minmax(24px,1fr)_minmax(0,52px)_minmax(0,52px)_minmax(0,56px)] items-center gap-x-2.5 gap-y-2 px-3.5 pb-3 pt-2 text-[12px]">
        <span /><span />
        <span className="text-right text-[11px] text-ink-3">Target</span>
        <span className="text-right text-[11px] text-ink-3">Live</span>
        <span className="text-right text-[11px] text-ink-3">Drift</span>
        {rows.map((s, i) => {
          const liveV = dLive.values[i] ?? 0;
          const tgtV = dTgt.values[i] ?? 0;
          const drift = liveV - tgtV;
          const flat = sameAtDisplay(liveV, tgtV);
          const barW = (usingLive ? liveV : tgtV) * 100;
          const st = { "--i": Math.min(i + 1, 8) } as React.CSSProperties;
          return (
            <React.Fragment key={s.key}>
              <span style={st} className="min-w-0 break-words text-ink-2">{s.label}</span>
              <div style={st} className="h-1 min-w-0 overflow-hidden rounded-[2px] bg-surface-2">
                <i className={`block h-full ${s.bar}`} style={{ width: `${Math.max(0, Math.min(100, barW))}%` }} />
              </div>
              <span style={st} className="text-right font-mono text-ink-3">{fmtPct2(tgtV)}</span>
              <span style={st} className="text-right font-mono text-ink">{usingLive ? fmtPct2(liveV) : "—"}</span>
              <span style={st} className={`text-right font-mono ${!usingLive || flat ? "text-ink-3" : drift > 0 ? "text-pos" : "text-neg"}`}>
                {!usingLive || flat ? "—" : `${drift > 0 ? "+" : ""}${fmtPct2(drift)}`}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}

function pct(v: number): string {
  return fmtPct2(v);
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
  if (sortField !== field) return <AppIcon name="sortAsc" size={11} className="text-ink-faint" />;
  return <AppIcon name={sortDir === "asc" ? "sortAsc" : "sortDesc"} size={11} className="text-ink-2" />;
}

const POS_CLASS_LABELS: Record<PimAssetClass, string> = {
  fixedIncome: "Fixed Income",
  equity: "Equities",
  alternative: "Alternatives",
};

/** Same header colours as the Models tab so the two pages read as one system. */
const POS_CLASS_COLORS: Record<PimAssetClass, { header: string }> = {
  fixedIncome: { header: "bg-accent-soft text-accent" },
  equity: { header: "bg-pos-soft text-pos" },
  alternative: { header: "bg-warn-soft text-warn" },
};

type HoldingRow = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  assetClass: PimAssetClass;
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
  /** Units are held but the group's model has no holding for this symbol.
   *  Such a row has no model target and would not exist at all before the
   *  orphan pass was added — it was simply invisible. */
  isOrphan?: boolean;
};

type Props = {
  groups: PimModelGroup[];
};

export function PimPortfolio({ groups }: Props) {
  const { uiPrefs, setUiPref, stocks, pimPortfolioState, updatePimPortfolioState, getGroupState, addStock, scoredStocks, pimModels, updatePimModels, moveBucket, rebalanceStockWeights, updateStockFields, loading } = useStocks();

  const selectedGroupId = "pim";
  // Version (profile) is shared via the URL (?version=) so the header selector
  // in PortfolioTabs drives the Positioning tab too. Falls back to allEquity.
  const searchParams = useSearchParams();
  const urlVersion = searchParams.get("version");
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>(
    (urlVersion as PimProfileType) || "allEquity",
  );
  useEffect(() => {
    if (urlVersion && urlVersion !== selectedProfile) {
      setSelectedProfile(urlVersion as PimProfileType);
    }
  }, [urlVersion]); // eslint-disable-line react-hooks/exhaustive-deps
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
  /** Tickers bought in the last executed batch that still owe a thesis
   *  (cleared when dismissed; the Dashboard banner keeps following them). */
  const [thesisOwed, setThesisOwed] = useState<string[]>([]);

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
      // Shift + ← / → is reserved for switching Portfolio segments (PortfolioTabs);
      // plain ← / → toggle the profile here.
      if (e.shiftKey) return;
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

    // ── Orphan positions: units held with NO holding in the group's model.
    // The rows above are built by walking MODEL holdings, so a position the
    // model does not know about cannot render at all — and its value is
    // missing from the denominator every other weight is divided by, quietly
    // overstating all of them. That is exactly how a partial switch hid an
    // entire position. Matched against the UNFILTERED group holdings, since
    // effectiveGroup is profile-filtered and would call every Core ETF an
    // orphan on the Alpha profile.
    const modelSymbols = selectedGroup?.holdings ?? [];
    const orphanRaw = (currentPositions?.positions ?? [])
      .filter((p) => p.units > 0 && !modelSymbols.some((h) => symbolEq(h.symbol, p.symbol)))
      .map((p) => {
        const price = livePrices[p.symbol] || 0;
        const currency: "CAD" | "USD" = tickerIsUsd(p.symbol) ? "USD" : "CAD";
        const fxRate = currency === "USD" ? usdCadRate : 1;
        const priceCad = price * fxRate;
        return {
          h: {
            symbol: p.symbol,
            name: p.symbol,
            currency,
            assetClass: "equity" as PimAssetClass,
            weightInClass: 0,
          },
          modelPct: 0,
          units: p.units,
          costBasis: p.costBasis,
          costBasisCad: p.costBasis,
          price,
          priceCad,
          value: p.units * price,
          valueCad: p.units * priceCad,
          costValue: p.units * p.costBasis,
          costValueCad: p.units * p.costBasis,
          fxRate,
          isOrphan: true,
        };
      });

    // Total CAD value = cash + every holding's CAD value, INCLUDING orphans —
    // they are real money and belong in the denominator.
    const totalValueCad = (currentPositions?.cashBalance || 0)
      + rawRows.reduce((sum, r) => sum + r.valueCad, 0)
      + orphanRaw.reduce((sum, r) => sum + r.valueCad, 0);

    // Filter out holdings with 0% model weight for this profile, but never
    // drop an orphan — being weightless is the whole point of showing it.
    const activeRows = [...rawRows.filter((r) => r.modelPct > 0), ...orphanRaw];

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
        assetClass: r.h.assetClass,
        modelPct: r.modelPct,
        currentPct,
        driftPct,
        gainLoss,
        action,
        isOrphan: "isOrphan" in r ? true : undefined,
      });
    }

    return rows;
  }, [effectiveGroup, selectedGroup, profileWeights, livePrices, positionMap, currentPositions, usdCadRate, sharedCostBasisMap]);

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

  /**
   * 2dp display weights for the positions table.
   *
   * These get typed into the modelling software, so each column is apportioned
   * rather than rounded cell-by-cell: every figure is exactly two decimals and
   * the column still sums to its own rounded total, instead of drifting a few
   * hundredths away from it across thirty-odd rows.
   *
   * No forced total here (unlike the model tables, which tie to a known class
   * allocation): this table is sortable and its rows are whatever is on screen,
   * so each column ties to the rounded sum of exactly those rows.
   */
  const dPos = useMemo(() => {
    const out: Record<string, { target: Map<string, number | null>; current: Map<string, number | null> }> = {};
    for (const cls of ["fixedIncome", "equity", "alternative"] as PimAssetClass[]) {
      const rows = sortedRows.filter((r) => r.assetClass === cls);
      const t = apportionColumn(rows.map((r) => r.modelPct));
      const c = apportionColumn(rows.map((r) => (r.units > 0 ? r.currentPct : null)));
      out[cls] = {
        target: new Map(rows.map((r, i) => [r.symbol, t.values[i]])),
        current: new Map(rows.map((r, i) => [r.symbol, c.values[i]])),
      };
    }
    return out;
  }, [sortedRows]);

  // ── Seed a profile's positions from another profile's market value ──────
  // A newly-created profile (Conservative) has target weights but no units, so
  // it books no return at all. Its book is not a different portfolio, just a
  // different asset mix over the same money — so the sibling profile's total
  // market value is the right size to build it at.
  const [seedFrom, setSeedFrom] = useState<PimProfileType>("balanced");
  const [seeding, setSeeding] = useState(false);

  /** Total CAD market value of a profile's book, cash included. */
  const profileMarketValue = useCallback(
    (prof: PimProfileType) => {
      const entry = positions.find((p) => p.groupId === selectedGroupId && p.profile === prof);
      if (!entry) return 0;
      let total = entry.cashBalance || 0;
      for (const pos of entry.positions) {
        const h = effectiveGroup?.holdings.find(
          (x) => symbolToTicker(x.symbol) === symbolToTicker(pos.symbol),
        );
        const px = livePrices[pos.symbol] || 0;
        total += pos.units * px * (h?.currency === "USD" ? usdCadRate : 1);
      }
      return total;
    },
    [positions, selectedGroupId, effectiveGroup, livePrices, usdCadRate],
  );

  /**
   * Units the ACTIVE profile would hold if built at `totalValue`.
   * units = (totalValue x targetWeight) / priceCad, where targetWeight is
   * weightInClass x this profile's own allocation for that asset class.
   * Cost basis is seeded at today's price, so the profile starts flat rather
   * than inheriting a gain it never earned.
   */
  const seedPlan = useMemo(() => {
    if (!effectiveGroup || !profileWeights) return { rows: [], totalValue: 0, cash: 0, missingPrices: [] as string[] };
    const totalValue = profileMarketValue(seedFrom);
    const missingPrices: string[] = [];
    const rows = effectiveGroup.holdings
      .map((h) => {
        const alloc =
          h.assetClass === "equity" ? profileWeights.equity
          : h.assetClass === "fixedIncome" ? profileWeights.fixedIncome
          : profileWeights.alternatives;
        const targetWeight = h.weightInClass * alloc;
        if (targetWeight <= 0) return null;
        const px = livePrices[h.symbol] || 0;
        const priceCad = px * (h.currency === "USD" ? usdCadRate : 1);
        if (priceCad <= 0) { missingPrices.push(h.symbol); return null; }
        const targetValueCad = totalValue * targetWeight;
        return {
          symbol: h.symbol, name: h.name, currency: h.currency,
          targetWeight, targetValueCad, priceCad,
          units: targetValueCad / priceCad,
        };
      })
      .filter(Boolean) as { symbol: string; name: string; currency: "CAD" | "USD"; targetWeight: number; targetValueCad: number; priceCad: number; units: number }[];
    return { rows, totalValue, cash: totalValue * (profileWeights.cash || 0), missingPrices };
  }, [effectiveGroup, profileWeights, seedFrom, profileMarketValue, livePrices, usdCadRate]);

  const applySeed = useCallback(async () => {
    if (seedPlan.rows.length === 0) return;
    setSeeding(true);
    try {
      const others = positions.filter((p) => !(p.groupId === selectedGroupId && p.profile === activeProfile));
      const next = [
        ...others,
        {
          groupId: selectedGroupId,
          profile: activeProfile,
          positions: seedPlan.rows.map((r) => ({
            symbol: r.symbol,
            units: parseFloat(r.units.toFixed(4)),
            costBasis: parseFloat(r.priceCad.toFixed(4)),
          })),
          cashBalance: parseFloat(seedPlan.cash.toFixed(2)),
          lastUpdated: new Date().toISOString(),
        },
      ];
      setPositions(next);
      positionsRef.current = next;
      await fetch("/api/kv/pim-positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolios: next }),
      });
    } finally {
      setSeeding(false);
    }
  }, [seedPlan, positions, selectedGroupId, activeProfile]);

  /** Positions grouped the way the Models tab groups them, so the two pages
   *  read as one system rather than two different views of the same book. */
  const positionsByClass = useMemo(() => {
    const out: Record<PimAssetClass, HoldingRow[]> = { fixedIncome: [], equity: [], alternative: [] };
    for (const r of sortedRows) out[r.assetClass].push(r);
    return out;
  }, [sortedRows]);

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

  // ── Rebalance & Buy/Sell logic ──
  const groupState = getGroupState(selectedGroupId);

  /** Sell candidates for the Buy / Sell panel. Built from the RAW selected
   *  group (not effectiveGroup) and NOT scaled by the active profile's asset
   *  allocation — scaling hid every fixed-income / alternative holding
   *  whenever the viewed profile allocated 0% to its sleeve (All-Equity,
   *  Alpha, Core), so JBND could never be sold from those tabs even though a
   *  sell executes firm-wide. Unioned with the group's actual positions so a
   *  book/model divergence (units with no model target) stays sellable. */
  const sellCandidates = useMemo(() => {
    if (!selectedGroup) return [];
    const out: { symbol: string; name: string; assetClass: PimAssetClass }[] = [];
    for (const h of selectedGroup.holdings) {
      if (h.weightInClass > 0) out.push({ symbol: h.symbol, name: h.name, assetClass: h.assetClass });
    }
    for (const pp of positions) {
      if (pp.groupId !== selectedGroupId) continue;
      for (const p of pp.positions) {
        if (p.units > 0 && !out.some((c) => symbolEq(c.symbol, p.symbol))) {
          out.push({ symbol: p.symbol, name: p.symbol, assetClass: "equity" });
        }
      }
    }
    return out;
  }, [selectedGroup, positions, selectedGroupId]);

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
    /** A switch owns its own pm:pim-models write; helpers must not race it. */
    const isSwitch = !!trade.sellSymbol && !!buyTicker;
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

    /** Model group ids this trade does NOT apply to — the unticked models in
     *  the buy ticket, plus the No-US-Situs auto-rule. An excluded model is
     *  left completely untouched: no sell, no buy, no position change, no
     *  transaction row. Gated on buyTicker because the checkbox UI only
     *  exists on the buy side — a sell-only trade must not inherit stale
     *  exclusions from a buy that was picked and then cleared. */
    const excludedSet = new Set(buyTicker ? trade.excludedGroupIds || [] : []);

    /** Groups where the model got the bought holding but the book got no
     *  shares, because there was no sold position there to fund it. */
    const unitlessBuyGroups: string[] = [];
    /** Set when a partial trim could not move the model target, because the
     *  sold name is an equal-weighted individual stock. */
    let partialTrimNotApplied = false;
    /** Groups where a non-equity trim could not move the model target because
     *  the sold name is its sleeve's only holding — the freed weight has
     *  nowhere inside the sleeve to go. Position still trims. */
    const soleSleeveGroups: string[] = [];
    /** Buy-only: profiles where the name carries no model target, so no
     *  units could be sized. */
    const buyOnlyNoTargetGroups: string[] = [];

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

    /** Sleeve of the bought security (explicit from the buy ticket). */
    const buyAC: PimAssetClass = trade.buyAssetClass || "equity";
    /** Sleeve of the sold holding, from the first model that holds it. */
    const soldClass: PimAssetClass | undefined = trade.sellSymbol
      ? originalPim.groups
          .flatMap((g) => g.holdings)
          .find((h) => tickerEq(h.symbol, trade.sellSymbol))?.assetClass
      : undefined;

    // A switch must stay inside one sleeve. Selling JBND (fixed income) to
    // buy an equity name — or vice versa — moves weight BETWEEN asset
    // classes, and weightInClass cannot express that: each sleeve must still
    // sum to 100% of itself, with the mix owned by the profile allocations.
    // The old behaviour silently filed the buy under the sold name's class,
    // which kept the sums valid but put the security in the wrong bucket.
    if (trade.sellSymbol && buyTicker && soldClass && buyAC !== soldClass) {
      const label = (ac: PimAssetClass) =>
        ac === "fixedIncome" ? "fixed income" : ac === "alternative" ? "alternatives" : "equity";
      return {
        ok: false,
        error: `${displayTicker(trade.sellSymbol)} is ${label(soldClass)} but ${buyTicker} is marked ${label(buyAC)} — a cross-class switch changes the asset mix, which profile allocations own. Pick a same-class replacement (or fix the Bucket selector), or do a sell-only and adjust the mix separately.`,
      };
    }

    type SwapPlan = {
      groupId: string;
      groupName: string;
      soldHolding: PimHolding;
    };
    const swapPlan: SwapPlan[] = [];
    const skippedDueToBoughtPresent: string[] = [];
    if (trade.sellSymbol) {
      for (const g of originalPim.groups) {
        // Unticked models are left COMPLETELY untouched — neither leg
        // executes there. The old semantics ("cannot buy here, but the sell
        // still applies") sold JBND out of excluded models with no buy to
        // absorb the weight, skewing the sleeve (15.4/12.6 instead of 14/14)
        // and trimming positions the PM had explicitly opted out of.
        if (excludedSet.has(g.id)) continue;
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

    // Groups holding the sold ticker WITHOUT the already-holds-the-buy skip.
    // A partial sell trims the target everywhere the trade applies; whether
    // the bought name is already present decides only whether it gets ADDED,
    // not whether the trim applies. (A full switch still uses swapPlan — it
    // must not put the bought name into a group that already holds it.)
    // Excluded groups are skipped for the same reason as swapPlan: unticked
    // means the model is not part of this trade at all.
    const trimPlan: SwapPlan[] = [];
    if (trade.sellSymbol) {
      for (const g of originalPim.groups) {
        if (excludedSet.has(g.id)) continue;
        const sold = g.holdings.find((h) => tickerEq(h.symbol, trade.sellSymbol));
        if (sold) trimPlan.push({ groupId: g.id, groupName: g.name, soldHolding: sold });
      }
    }

    /** The plan that drives model writes + transaction-tape grouping. */
    const modelPlan = isPartialSell ? trimPlan : swapPlan;

    // Eligible models that do NOT hold the sold name still need the BUY.
    // Ticking a model means "this model should own the bought name"; whether
    // it happened to hold the name being sold is a separate question. Only
    // groups holding the sold ticker used to be touched, so a switch funded
    // from GRNJ silently skipped KPMG — which never held GRNJ — and LITE
    // never reached it even though KPMG was ticked. The residual rule funds
    // the addition from that model's own Core ETFs.
    const buyOnlyAddGroups: string[] = [];
    if (buyTicker) {
      for (const g of originalPim.groups) {
        if (excludedSet.has(g.id)) continue;
        if (modelPlan.some((p) => p.groupId === g.id)) continue;
        if (g.holdings.some((h) => tickerEq(h.symbol, buyTicker))) continue;
        buyOnlyAddGroups.push(g.id);
      }
    }
    const buyOnlyAddSet = new Set(buyOnlyAddGroups);

    const affectedGroupIds = new Set([
      ...modelPlan.map((p) => p.groupId),
      ...buyOnlyAddGroups,
    ]);

    // ── Resolve buy-side metadata up front so the atomic swap and the
    // addStock call share the same name / instrumentType / sector.
    // Only relevant when there IS a buy side — sell-only trades skip
    // this whole block.
    // ── Per-model eligibility for the bought ticker.
    // `trade.excludedGroupIds` is the set of model groups the user (or the
    // No-US-Situs auto-rule) has marked the buy INELIGIBLE for. Build the
    // full eligibility map so it can be persisted on pm:stocks (stock-page
    // display + future ops) and consulted by addToPimModels on pure buys.
    const eligibilityMap: Record<string, boolean> = {};
    for (const g of originalPim.groups) {
      eligibilityMap[g.id] = !excludedSet.has(g.id);
    }

    let buyName = trade.buyName || buyTicker;
    let buyInstrumentType: InstrumentType = "stock";
    let buySector = "";
    /** The buy-side Stock, passed to rebalanceStockWeights as `extraStock`.
     *  That function classifies holdings off the `stocks` context array, which
     *  has NOT re-rendered with a stock added moments earlier in this same
     *  function — without this the fresh name falls through to the legacy
     *  lookup, is treated as a residual-absorbing Core ETF, and silently
     *  inflates. `extraStock` exists precisely for this race. */
    let buyStockForRebalance: Stock | undefined;
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
        // isSwitch: the atomic swap below computes and writes the final
        // model state. Letting addStock persist its own version first is what
        // diluted every stock and left the sold holding in place.
        buyStockForRebalance = stock;
        addStock(stock, { skipPimModels: isSwitch, assetClass: buyAC });
      } else {
        buyStockForRebalance = existingStock;
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
          moveBucket(existingStock.ticker, {
            skipPimModels: isSwitch,
            eligibility: excludedSet.size > 0 ? eligibilityMap : undefined,
            assetClass: buyAC,
          });
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
    /** Excluded models that still hold the sold name after a full sell —
     *  the name is NOT fully exited, so the Portfolio → Watchlist demotion
     *  must not happen. */
    const soldKeptInGroups: string[] = excludedSet.size > 0 && trade.sellSymbol && !isPartialSell
      ? originalPim.groups
          .filter((g) => excludedSet.has(g.id) && g.holdings.some((h) => tickerEq(h.symbol, trade.sellSymbol)))
          .map((g) => g.name)
      : [];

    if (trade.sellSymbol && !isPartialSell && soldKeptInGroups.length === 0) {
      const soldStock = stocks.find((s) => tickerEq(s.ticker, trade.sellSymbol));
      if (soldStock?.bucket === "Portfolio") {
        // Same reason as the buy side: this fires removeFromPimModels, which
        // persists its OWN rebalanced pm:pim-models. During a switch that is a
        // third writer racing the atomic swap for the same key. The bucket
        // flip on pm:stocks still happens; only the model write is deferred to
        // the swap, which removes the sold holding as part of one write.
        // Non-equity sells are also skipped here: removeFromPimModels'
        // equity-only rebalance can't re-normalize a fixed-income /
        // alternatives sleeve — the sell-only block below owns that write.
        moveBucket(soldStock.ticker, {
          skipPimModels: isSwitch || (soldClass != null && soldClass !== "equity"),
        });
      }
    }

    // ── Partial sell: the model target moves too.
    //
    // This used to be skipped entirely ("model weights stay as designed"),
    // on the theory that a partial sell is a drift correction. It isn't — a
    // partial sell is a deliberate reduction in the target, and skipping the
    // model write produced two failures. The sold name kept its full target,
    // so the app immediately advised buying back what had just been trimmed;
    // and when the sell funded a NEW name, that name got units in
    // pm:pim-positions with no holding in pm:pim-models at all. The
    // Positioning table iterates MODEL holdings, so such a position is not
    // merely mis-weighted — it cannot render, and its value is missing from
    // the denominator every other weight is computed against.
    //
    // So: trim the sold holding by the fraction sold, add the bought name
    // where it is eligible and not already present, and let the standing
    // residual rule redistribute. Weight is moved, never created, so the
    // asset-class sum is preserved by construction.
    if (isPartialSell && trimPlan.length > 0) {
      const keepFraction = 1 - sellPercent / 100;
      const partialBuyCurrency: "CAD" | "USD" =
        buyTicker.endsWith(".U")
          ? "USD"
          : buyTicker.endsWith("-T") || buyTicker.endsWith(".TO")
            ? "CAD"
            : trimPlan[0].soldHolding.currency;

      const updatedGroups = originalPim.groups.map((g) => {
        const plan = trimPlan.find((p) => p.groupId === g.id);
        if (!plan) {
          if (!buyOnlyAddSet.has(g.id) || !buyTicker) return g;
          // Eligible model that doesn't hold the sold name — add the buy.
          // Equity buys are funded by the residual rule (Core ETFs shrink);
          // non-equity buys have no Core sleeve to fund them, so they land
          // at 0 target and are surfaced via the no-target warning.
          const added: PimHolding[] = [
            ...g.holdings,
            {
              name: buyName.toUpperCase(),
              symbol: buyTicker,
              currency: partialBuyCurrency,
              assetClass: buyAC,
              weightInClass: 0,
            },
          ];
          return buyAC === "equity"
            ? { ...g, holdings: rebalanceStockWeights(added, buyStockForRebalance, g.id) }
            : { ...g, holdings: added };
        }

        const soldAC = plan.soldHolding.assetClass;
        const freed = plan.soldHolding.weightInClass * (sellPercent / 100);
        const trimmed = g.holdings.map((h) =>
          h === plan.soldHolding
            ? { ...h, weightInClass: h.weightInClass * keepFraction }
            : h,
        );

        // ── Non-equity sleeve (fixed income / alternatives) ──────────────
        // rebalanceStockWeights only touches equity, so the freed weight
        // must be placed HERE or the sleeve stops summing to 100% and the
        // class-sum guard aborts the trade (which is exactly what made JBND
        // untradeable). Same-class buy takes the freed weight verbatim;
        // otherwise the sleeve's remaining holdings absorb it
        // proportionally; a sole-holding sleeve cannot express the trim at
        // all, so the target is left unchanged and the user is told.
        if (soldAC !== "equity") {
          const existingBuy = buyTicker
            ? g.holdings.find((h) => tickerEq(h.symbol, buyTicker))
            : undefined;
          if (buyTicker && !excludedSet.has(g.id) && !existingBuy) {
            const withBuy: PimHolding[] = [
              ...trimmed,
              {
                name: buyName.toUpperCase(),
                symbol: buyTicker,
                currency: partialBuyCurrency,
                assetClass: buyAC,
                weightInClass: freed,
              },
            ];
            return { ...g, holdings: withBuy };
          }
          if (existingBuy && !excludedSet.has(g.id) && existingBuy.assetClass === soldAC) {
            // Already holds the bought name in the same sleeve — the freed
            // weight tops it up.
            return {
              ...g,
              holdings: trimmed.map((h) =>
                tickerEq(h.symbol, buyTicker) ? { ...h, weightInClass: h.weightInClass + freed } : h,
              ),
            };
          }
          const redistributed = redistributeWithinClass(trimmed, soldAC, plan.soldHolding.symbol, freed);
          if (redistributed === null) {
            soleSleeveGroups.push(g.name);
            return g; // model target unchanged; position still trims below
          }
          return { ...g, holdings: redistributed };
        }

        // ── Equity sleeve — existing residual-rule path, unchanged ───────
        // No buy side, buy ineligible here, or the name is already held:
        // take the trim alone and let the residual rule place the freed
        // weight. (Already-held is why this walks trimPlan and not swapPlan.)
        const alreadyHolds = buyTicker && g.holdings.some((h) => tickerEq(h.symbol, buyTicker));
        if (!buyTicker || excludedSet.has(g.id) || alreadyHolds) {
          return { ...g, holdings: rebalanceStockWeights(trimmed, buyStockForRebalance, g.id) };
        }

        const withBuy: PimHolding[] = [
          ...trimmed,
          {
            name: buyName.toUpperCase(),
            symbol: buyTicker,
            currency: partialBuyCurrency,
            assetClass: plan.soldHolding.assetClass,
            weightInClass: 0,
          },
        ];
        return { ...g, holdings: rebalanceStockWeights(withBuy, buyStockForRebalance, g.id) };
      });

      const guardError = assertClassSumsSafe(originalPim.groups, updatedGroups, affectedGroupIds);
      if (guardError) return { ok: false, error: guardError };

      const nextPim = { ...originalPim, groups: updatedGroups, lastUpdated: nowIso };
      updatePimModels(nextPim);
      pimModelsRef.current = nextPim;

      // An individual stock's target is equal-weighted by construction, so a
      // trim to one cannot be expressed in the model — the residual rule puts
      // it straight back. Say so rather than let the user believe the target
      // moved.
      const soldStillFull = updatedGroups.some((g) => {
        const plan = trimPlan.find((p) => p.groupId === g.id);
        if (!plan) return false;
        const after = g.holdings.find((h) => tickerEq(h.symbol, trade.sellSymbol));
        return !!after && after.weightInClass >= plan.soldHolding.weightInClass - 1e-9;
      });
      if (soldStillFull) {
        partialTrimNotApplied = true;
      }
    }

    // ── Atomic firm-wide swap in pm:pim-models.
    // Full sells only — partial sells are handled by the block above.
    if (swapPlan.length > 0 && !isPartialSell && buyTicker) {
      const buyCurrency: "CAD" | "USD" =
        buyTicker.endsWith(".U")
          ? "USD"
          : buyTicker.endsWith("-T") || buyTicker.endsWith(".TO")
            ? "CAD"
            : swapPlan[0].soldHolding.currency; // inherit when suffix is silent
      const updatedGroups = originalPim.groups.map((g) => {
        const plan = swapPlan.find((p) => p.groupId === g.id);
        if (!plan) {
          if (!buyOnlyAddSet.has(g.id)) return g;
          // Eligible model that doesn't hold the sold name — add the buy.
          // Equity buys are funded by the residual rule (Core ETFs shrink);
          // non-equity buys have no Core sleeve, so they land at 0 target.
          const added: PimHolding[] = [
            ...g.holdings,
            {
              name: buyName.toUpperCase(),
              symbol: buyTicker,
              currency: buyCurrency,
              assetClass: buyAC,
              weightInClass: 0,
            },
          ];
          return buyAC === "equity"
            ? { ...g, holdings: rebalanceStockWeights(added, buyStockForRebalance, g.id) }
            : { ...g, holdings: added };
        }
        // NOTE: excluded groups never make it into swapPlan — an unticked
        // model is left completely untouched (no sell, no buy), so the old
        // "remove the sold holding and hand its weight to Core" branch for
        // excluded groups is gone by design.
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

      // Shared with the partial-sell block above — see assertClassSumsSafe.
      const guardError = assertClassSumsSafe(originalPim.groups, updatedGroups, affectedGroupIds);
      if (guardError) return { ok: false, error: guardError };

      const nextPim = { ...originalPim, groups: updatedGroups, lastUpdated: nowIso };
      updatePimModels(nextPim);
      // Sync the ref so the next trade in the queue sees this update.
      pimModelsRef.current = nextPim;
    }

    // ── Full sell-only of a NON-EQUITY holding: remove the model target. ──
    // Equity full sells reach the model via moveBucket → removeFromPimModels
    // (Core ETFs absorb the freed weight). Non-equity names are usually not
    // in pm:stocks at all, and the equity-only rebalance couldn't re-normalize
    // their sleeve anyway — so the removal is written here, with the sleeve's
    // remaining holdings absorbing the weight proportionally. A sole-holding
    // sleeve cannot express the removal (the profile still allocates to the
    // class), so the trade aborts with the options spelled out.
    if (sellOnly && !isPartialSell && soldClass && soldClass !== "equity" && trimPlan.length > 0) {
      const soleSleeve: string[] = [];
      const updatedGroups = originalPim.groups.map((g) => {
        const plan = trimPlan.find((p) => p.groupId === g.id);
        if (!plan) return g;
        const remaining = g.holdings.filter((h) => h !== plan.soldHolding);
        const redistributed = redistributeWithinClass(
          remaining, soldClass, plan.soldHolding.symbol, plan.soldHolding.weightInClass,
        );
        if (redistributed === null) {
          soleSleeve.push(g.name);
          return g;
        }
        return { ...g, holdings: redistributed };
      });
      if (soleSleeve.length > 0) {
        return {
          ok: false,
          error: `${displayTicker(trade.sellSymbol)} is the ONLY ${soldClass === "fixedIncome" ? "fixed-income" : "alternatives"} holding in ${soleSleeve.join(", ")} — the profile still allocates to that sleeve, so a full sell can't be expressed in the model. Switch into a replacement fund instead, use a partial sell, or change the profile's asset mix first. No changes persisted.`,
        };
      }
      const guardError = assertClassSumsSafe(originalPim.groups, updatedGroups, affectedGroupIds);
      if (guardError) return { ok: false, error: guardError };
      const nextPim = { ...originalPim, groups: updatedGroups, lastUpdated: nowIso };
      updatePimModels(nextPim);
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
    //   - Partial sell:     trimPlan drives it — every group whose model
    //                       target was trimmed gets a tape entry, matching
    //                       the full-switch behaviour
    //   - Neither in a model: fall back to the groups that actually hold the
    //                       sold position so the reduce still lands somewhere
    //   - Pure buy:         fallback to selectedGroupId (single txn row)
    const groupsToWrite: { groupId: string; soldWeightInClass: number }[] =
      modelPlan.length > 0
        ? modelPlan.map((p) => ({ groupId: p.groupId, soldWeightInClass: p.soldHolding.weightInClass }))
        : isPartialSell
          ? Array.from(
              new Set(
                // Read from the ref (not the `positions` closure) so back-to-
                // back partial sells pick groups from the post-previous-trade
                // state — consistent with the position math below.
                positionsRef.current
                  .filter((pp) => pp.positions.some((p) => tickerEq(p.symbol, trade.sellSymbol) && p.units > 0))
                  .map((pp) => pp.groupId)
                  .filter((gid) => !excludedSet.has(gid)),
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
    //   Sell-only (sellOnly):
    //     - Reduce or remove the position; proceeds credited to cashBalance.
    //
    //   Buy-only (buyOnly):
    //     - Size the new position from its MODEL TARGET for each profile and
    //       debit cashBalance. There is no sold leg to fund it, and the model
    //       already knows what the name should weigh, so the target is the
    //       funding source. Adding the name equal-weights it against the other
    //       individual stocks, which is what lowers theirs.
    //
    //     Both used to be skipped entirely — the trade hit the transaction tape
    //     but pm:pim-positions was never touched, so the PM had to enter units
    //     by hand and the book silently disagreed with the model until they did.
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
              // Unticked models are untouched on BOTH legs — the book must
              // not sell there either, or the position drifts away from a
              // model target that never moved.
              .filter((gid) => !excludedSet.has(gid))
          )
        : affectedGroupIds;

      // Bought units are derived from the SOLD position's units, so a group
      // whose positions don't hold the sold ticker silently produces no
      // position for the bought one. The model gets the holding, the book
      // gets no shares, and the name contributes nothing to performance —
      // with no error anywhere. Collect those groups and report them.
      const updatedPositions = currentPositions.map((pp) => {
        if (!positionGroupsToTouch.has(pp.groupId)) return pp;
        const soldPos = pp.positions.find((p) => tickerEq(p.symbol, trade.sellSymbol));
        if (!soldPos || soldPos.units <= 0) {
          // The "alpha" and "core" sleeves are single-designation by
          // construction: core holds only Core ETFs, alpha only the active
          // picks. A name of the other designation was never going to be in
          // there, so its absence is expected and not worth warning about —
          // only a sleeve that COULD have held the sold name is a real miss.
          const soldIsCore = coreSymbols.has(symbolToTicker(trade.sellSymbol));
          const expectedHere =
            (pp.profile !== "core" || soldIsCore) && (pp.profile !== "alpha" || !soldIsCore);
          if (expectedHere) {
            const gName = pimModelsRef.current.groups.find((g) => g.id === pp.groupId)?.name ?? pp.groupId;
            unitlessBuyGroups.push(`${gName}/${pp.profile}`);
          }
          return pp;
        }

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

    // ── Sell-only: reduce or close the position, proceeds to cash ────────
    if (sellOnly && sellPrice > 0) {
      const sellFx = tickerIsUsd(trade.sellSymbol) ? usdCadRate : 1;
      const fraction = sellPercent / 100;
      const updated = positionsRef.current.map((pp) => {
        const soldPos = pp.positions.find((p) => tickerEq(p.symbol, trade.sellSymbol));
        if (!soldPos || soldPos.units <= 0) return pp;
        const unitsSold = soldPos.units * fraction;
        const remaining = soldPos.units - unitsSold;
        const proceedsCad = unitsSold * sellPrice * sellFx;
        // Below a thousandth of a unit is rounding dust, not a position.
        const nextPositions = remaining > 0.001
          ? pp.positions.map((p) =>
              tickerEq(p.symbol, trade.sellSymbol) ? { ...p, units: remaining } : p)
          : pp.positions.filter((p) => !tickerEq(p.symbol, trade.sellSymbol));
        return {
          ...pp,
          positions: nextPositions,
          cashBalance: (pp.cashBalance || 0) + proceedsCad,
          lastUpdated: nowIso,
        };
      });
      setPositions(updated);
      positionsRef.current = updated;
      try {
        await fetch("/api/kv/pim-positions", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portfolios: updated }),
        });
      } catch { /* non-fatal; local state is correct */ }
    }

    // ── Buy-only: size from the model target, debit cash ─────────────────
    // No sold leg funds this, but the model already knows what the name
    // should weigh, so the target IS the size. Mirrors the arithmetic in
    // executeRebalanceForProfile (including its alpha-profile renormalization)
    // rather than inventing a second sizing rule.
    if (buyOnly && buyPrice > 0) {
      const buyFx = tickerIsUsd(buyTicker) ? usdCadRate : 1;
      const buyCostBasisCad = buyPrice * buyFx;
      const modelsNow = pimModelsRef.current;

      // A missing live price would silently understate a portfolio's total and
      // therefore undersize the buy. Refuse rather than size off a bad total.
      const unpriced = new Set<string>();
      for (const pp of positionsRef.current) {
        for (const p of pp.positions) {
          if (p.units > 0 && !livePrices[p.symbol]) unpriced.add(p.symbol);
        }
      }
      if (unpriced.size > 0) {
        return {
          ok: false,
          error: `${buyTicker}: cannot size a buy-only trade — no live price for ${[...unpriced].join(", ")}. Refresh prices and retry. Nothing was written to positions.`,
        };
      }

      const noTarget: string[] = [];
      const updated = positionsRef.current.map((pp) => {
        if (excludedSet.has(pp.groupId)) return pp;
        const g = modelsNow.groups.find((x) => x.id === pp.groupId);
        if (!g) return pp;
        const holding = g.holdings.find((h) => tickerEq(h.symbol, buyTicker));
        if (!holding) return pp;

        // Target share of THIS profile's portfolio.
        let targetPct = 0;
        if (pp.profile === "alpha") {
          // Alpha is equity-only and excludes Core ETFs, renormalized to 100%.
          const alphaHoldings = g.holdings.filter(
            (h) => h.assetClass === "equity" && !coreSymbols.has(symbolToTicker(h.symbol)),
          );
          const alphaTotal = alphaHoldings.reduce((sum, h) => sum + h.weightInClass, 0);
          const inAlpha = alphaHoldings.some((h) => tickerEq(h.symbol, buyTicker));
          targetPct = inAlpha && alphaTotal > 0 ? holding.weightInClass / alphaTotal : 0;
        } else {
          const pW = g.profiles[pp.profile as keyof typeof g.profiles];
          if (!pW) return pp;
          const alloc = holding.assetClass === "fixedIncome" ? pW.fixedIncome
            : holding.assetClass === "equity" ? pW.equity
            : pW.alternatives;
          targetPct = holding.weightInClass * alloc;
        }
        if (targetPct <= 0) {
          noTarget.push(`${g.name}/${pp.profile}`);
          return pp;
        }

        let totalCad = pp.cashBalance || 0;
        for (const p of pp.positions) {
          const fx = tickerIsUsd(p.symbol) ? usdCadRate : 1;
          totalCad += p.units * (livePrices[p.symbol] || 0) * fx;
        }
        const targetValueCad = totalCad * targetPct;
        const units = buyCostBasisCad > 0 ? targetValueCad / buyCostBasisCad : 0;
        if (units <= 0) return pp;

        const existing = pp.positions.find((p) => tickerEq(p.symbol, buyTicker));
        const nextPositions = existing
          ? pp.positions.map((p) => {
              if (!tickerEq(p.symbol, buyTicker)) return p;
              const mergedUnits = p.units + units;
              return {
                ...p,
                units: mergedUnits,
                costBasis: mergedUnits > 0
                  ? (p.units * p.costBasis + units * buyCostBasisCad) / mergedUnits
                  : buyCostBasisCad,
              };
            })
          : [...pp.positions, { symbol: buyTicker, units, costBasis: buyCostBasisCad }];

        return {
          ...pp,
          positions: nextPositions,
          cashBalance: (pp.cashBalance || 0) - targetValueCad,
          lastUpdated: nowIso,
        };
      });

      setPositions(updated);
      positionsRef.current = updated;
      try {
        await fetch("/api/kv/pim-positions", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portfolios: updated }),
        });
      } catch { /* non-fatal; local state is correct */ }
      if (noTarget.length > 0) {
        buyOnlyNoTargetGroups.push(...noTarget);
      }
    }

    // Surface skipped-group warnings via the return value rather than
    // alert() — the multi-trade caller aggregates them into the
    // tradeExecProgress label so one alert popup per queue execution
    // is shown at the end (not per trade).
    let warning = skippedDueToBoughtPresent.length > 0
      ? `${buyTicker} was already held in these models — swap was NOT applied there: ${skippedDueToBoughtPresent.join(", ")}.`
      : undefined;
    if (unitlessBuyGroups.length > 0) {
      const note = `${buyTicker} was added to the model but NO SHARES were recorded in ${unitlessBuyGroups.join(", ")} — ${trade.sellSymbol} had no position there to fund the buy. Enter the units via Edit Positions, or the holding will not contribute to performance.`;
      warning = warning ? `${warning} ${note}` : note;
    }
    if (buyOnlyNoTargetGroups.length > 0) {
      const note = `${buyTicker} has no model target in ${buyOnlyNoTargetGroups.join(", ")}, so NO units were sized there. Check the name is eligible for those models.`;
      warning = warning ? `${warning} ${note}` : note;
    }
    if (partialTrimNotApplied) {
      const note = `${trade.sellSymbol} is an individual stock, and individual stocks are equal-weighted by design — the model target could NOT be trimmed. The position was reduced; the model still targets the full weight.`;
      warning = warning ? `${warning} ${note}` : note;
    }
    if (soldKeptInGroups.length > 0) {
      const note = `${trade.sellSymbol} was NOT sold in ${soldKeptInGroups.join(", ")} (unticked models are left untouched), so it stays in the Portfolio bucket and keeps its targets there.`;
      warning = warning ? `${warning} ${note}` : note;
    }
    if (soleSleeveGroups.length > 0) {
      const note = `${trade.sellSymbol} is the only holding in its sleeve for ${soleSleeveGroups.join(", ")} — the freed weight had nowhere inside the sleeve to go, so the model target was NOT trimmed there. The position was reduced; switch into a replacement fund or adjust the profile mix to move the target.`;
      warning = warning ? `${warning} ${note}` : note;
    }

    // ── Post-write reconciliation. The failure mode this feature keeps
    // producing is not a wrong number, it is model and book disagreeing in
    // silence. Check the state that was actually persisted and surface any
    // divergence rather than leaving it to be discovered later.
    const recon = reconcileModelsVsPositions(pimModelsRef.current, positionsRef.current, tickerEq)
      .filter((msg) =>
        msg.startsWith(`${buyTicker}:`) || (!!trade.sellSymbol && msg.startsWith(`${trade.sellSymbol}:`)),
      );
    if (recon.length > 0) {
      const note = `MODEL/BOOK MISMATCH after this trade — ${recon.join(" ")}`;
      warning = warning ? `${warning} ${note}` : note;
    }

    return { ok: true, warning };
  }, [pimPortfolioState, selectedGroupId, updatePimPortfolioState, scoredStocks, addStock, pimModels, updatePimModels, moveBucket, stocks, positions, usdCadRate, rebalanceStockWeights, updateStockFields, coreSymbols, livePrices]);

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
    // Funnel stage 4→5: every bought name owes a thesis. Non-blocking — the
    // reminder lists the buys with a link to each stock page, where the
    // Thesis tile (write, or Draft with AI) closes the gap.
    if (executed > 0) {
      const bought = trades.filter((t) => t.buyTicker).map((t) => t.buyTicker.trim().toUpperCase());
      if (bought.length > 0) setThesisOwed(Array.from(new Set(bought)));
    }
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

  // Display-only aggregate for the toolbar meta: total overweight vs target
  // (= sum of positive per-holding drifts). Read-only; touches no
  // rebalance/trade logic.
  const sleeveDrift = holdingRows.reduce((sum, r) => sum + Math.max(0, r.driftPct), 0) * 100;

  // ── Render-side view state (UI only; persisted through pm:ui-prefs) ──
  const posView: PosView = (uiPrefs["positioning.view"] as PosView) || "drift";
  const [rebalanceDetail, toggleRebalanceDetail] = usePersistedOpen("positioning.rebalance.detail", false);
  const [settleOpen, toggleSettleOpen] = usePersistedOpen("positioning.settleFold", true);
  // Overflow menu (Refresh prices · Client report) — transient, exempt from
  // the persistence rule like every other menu.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  // Rebalance preview rows. Identical math to the old inline table body
  // (previous close to match the trading desk; MF rows carry a dollar amount
  // and settle later), lifted out so the panel header can count trades and
  // gross value before anything is queued.
  const rebalanceRows = useMemo<RebalanceRow[]>(() => {
    return sortedRows.filter((r) => r.modelPct > 0).map((r) => {
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
      const action: "BUY" | "SELL" | "HOLD" = isMF
        ? (Math.abs(deltaValueCad) < 0.01 ? "HOLD" : deltaValueCad > 0 ? "BUY" : "SELL")
        : (absDelta < 0.001 ? "HOLD" : deltaUnits > 0 ? "BUY" : "SELL");
      const execPrice = parseFloat(rebalancePrices[r.symbol] || "0");
      const fxRate = r.currency === "USD" ? usdCadRate : 1;
      const costCad = isMF
        ? Math.abs(deltaValueCad)
        : (execPrice > 0 ? absDelta * execPrice * fxRate : 0);
      const pcCurrentPct = prevCloseTotalCad > 0 ? pcValueCad / prevCloseTotalCad : r.currentPct;
      const pcDrift = prevCloseTotalCad > 0 ? (pcValueCad / prevCloseTotalCad) - r.modelPct : r.driftPct;
      return {
        symbol: r.symbol, currency: r.currency, isMF, action,
        modelPct: r.modelPct, pcCurrentPct, pcDrift,
        units: r.units, targetUnits, deltaUnits, deltaValueCad,
        pcPrice, costCad,
      };
    });
  }, [sortedRows, prevCloses, prevCloseUsdCad, prevCloseTotalCad, rebalancePrices, usdCadRate]);
  const rebalanceTrades = rebalanceRows.filter((r) => r.action !== "HOLD");
  const rebalanceGross = rebalanceTrades.reduce((s, r) => s + Math.abs(r.deltaValueCad), 0);
  const rebalanceVisible = rebalanceDetail ? rebalanceRows : rebalanceTrades;
  const rebalanceHasMF = rebalanceRows.some((r) => r.isMF);

  // Column plan for the positions table (which extra columns the view shows).
  const showAcb = editMode || posView !== "drift";
  const showGain = hasPositions && (editMode || posView !== "drift");
  const showGainCad = hasPositions && posView === "gain";
  const showBar = hasPositions && posView === "drift";
  /** The table is wide (extra money columns / edit inputs) — it needs the full
   *  content width rather than the 1.6fr half of the two-up band. */
  const positionsWide = editMode || posView !== "drift";
  const posColCount = 4 + (showAcb ? 1 : 0) + (showGain ? 1 : 0) + (showGainCad ? 1 : 0) + 1 + (hasPositions ? (showBar ? 3 : 2) : 0);
  // Drift bar scale: the largest live drift fills half the bar, floor 1pp so a
  // tidy book reads as tidy rather than every 0.05pp filling the track.
  const driftScalePp = Math.max(1, ...holdingRows.filter((r) => r.units > 0).map((r) => Math.abs(r.driftPct * 100)));
  const heldCount = holdingRows.filter((r) => r.units > 0).length;
  const outsideTolerance = holdingRows.filter((r) => r.units > 0 && Math.abs(r.driftPct) >= DRIFT_TOLERANCE).length;
  const cashBalanceCad = currentPositions?.cashBalance || 0;
  const cashTargetPct = profileWeights?.cash ?? 0;
  const cashDriftPct = hasPositions ? cashPct - cashTargetPct : null;
  const totalGainCad = totalValueCadSummary - totalCostCad;
  const totalGainPct = totalCostCad > 0 ? (totalGainCad / totalCostCad) * 100 : null;
  const lastRebalancedLabel = groupState.lastRebalance
    ? new Date(groupState.lastRebalance.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "never";
  // "Equity 66% · Fixed income 30% · Cash 4%" — live when priced, else target.
  const allocMeta = (() => {
    if (!allocationBreakdown) return "";
    const liveTotal = allocationBreakdown.live.equity + allocationBreakdown.live.fixedIncome + allocationBreakdown.live.alternatives + allocationBreakdown.live.cash;
    const src = liveTotal > 0.01 ? allocationBreakdown.live : allocationBreakdown.target;
    const parts: string[] = [];
    if (src.equity > 0.0005) parts.push(`Equity ${(src.equity * 100).toFixed(0)}%`);
    if (src.fixedIncome > 0.0005) parts.push(`Fixed income ${(src.fixedIncome * 100).toFixed(0)}%`);
    if (src.alternatives > 0.0005) parts.push(`Alternatives ${(src.alternatives * 100).toFixed(0)}%`);
    if (src.cash > 0.0005) parts.push(`Cash ${(src.cash * 100).toFixed(0)}%`);
    return parts.join(" · ") + (liveTotal > 0.01 ? "" : " · target");
  })();
  const isFullProfile = activeProfile !== "alpha" && activeProfile !== "core";

  const sortTh = (field: SortField, label: string, numeric = true, extra = "") => (
    <th
      className={`${numeric ? "n " : ""}cursor-pointer select-none hover:text-ink ${extra}`}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">{label}<SortIcon field={field} sortField={sortField} sortDir={sortDir} /></span>
    </th>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Row 1 · toolbar: profile seg · meta · actions ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="seg max-w-full">
          {availableProfiles.map((p) => (
            <button key={p} onClick={() => setSelectedProfile(p)} className={activeProfile === p ? "on" : ""}>
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>
        {/* Labelled values rather than one inline run — the sentence used to
            bunch up against the profile picker and the action buttons. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-ink-3">Last rebalanced</span>
            <span className="font-mono text-ink-2">{lastRebalancedLabel}</span>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-ink-3">Sleeve drift</span>
            <span className={`font-mono ${sleeveDrift >= 2 ? "text-warn" : "text-ink-2"}`}>{sleeveDrift.toFixed(2)}%</span>
          </span>
          <span className="hidden text-ink-faint sm:inline" title="Positioning tracks the PIM model only — other groups aren't position-tracked.">PIM model only</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {editMode ? (
            <>
              <button onClick={() => setEditMode(false)} className={BTN_SECONDARY}>Cancel</button>
              <button onClick={savePositions} disabled={saving} className={BTN_PRIMARY}>
                {saving ? "Saving…" : "Save positions"}
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className={BTN_SECONDARY}>Edit positions</button>
              <button onClick={() => setShowSwitch(!showSwitch)} className={`${BTN_SECONDARY} ${showSwitch ? "bg-surface-hover text-ink" : ""}`}>Buy / Sell</button>
              {pendingTrades.length > 0 && (
                <button onClick={handleOpenSettlement} className={BTN_SECONDARY}>
                  Settle MF trades <span className="font-mono text-[11.5px] text-ink-3">{pendingTrades.length}</span>
                </button>
              )}
              <button onClick={() => setShowRebalance(!showRebalance)} className={BTN_PRIMARY}>
                {showRebalance ? "Close rebalance" : "Rebalance"}
              </button>
            </>
          )}
          <div className="relative" ref={moreRef}>
            <button onClick={() => setMoreOpen((v) => !v)} aria-label="More actions" title="More" className={BTN_ICON}>
              <AppIcon name="more" size={14} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-8 z-30 min-w-[190px] rounded-card border border-line bg-surface py-1 shadow-[var(--shadow-pop)]">
                <button
                  onClick={() => { setMoreOpen(false); void fetchPrices(); }}
                  disabled={pricesLoading}
                  className={MENU_ITEM}
                >
                  <AppIcon name="refresh" size={13} className={pricesLoading ? "animate-spin" : ""} />
                  {pricesLoading ? "Refreshing prices…" : "Refresh prices"}
                </button>
                {/* Client Report — opens the one-pager preview in a new tab,
                    seeded with the currently-selected profile. Hidden for
                    Alpha and Core because the one-pager is only built for
                    the three full-model profiles (Balanced / Growth /
                    All-Equity); the server-side route ALSO validates and
                    falls back to Balanced if those profiles are passed. */}
                {!editMode && isFullProfile && (
                  <Link
                    href={`/client-report?group=${encodeURIComponent(selectedGroupId)}&profile=${encodeURIComponent(activeProfile)}`}
                    target="_blank"
                    rel="noopener"
                    onClick={() => setMoreOpen(false)}
                    className={MENU_ITEM}
                  >
                    <AppIcon name="doc" size={13} />
                    Client report
                    <AppIcon name="external" size={12} className="ml-auto text-ink-faint" />
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2 · one hairline strip (all CAD) ── */}
      {/* Cash is deliberately NOT a cell here — the book never holds a
          meaningful cash weight, and the sixth cell squeezed the others hard
          enough to truncate the Gain figure mid-number. The cash balance is
          still shown in full on its own row in the Positions table below. */}
      <StatStrip
        cols={5}
        items={[
          { label: "Total value", value: fmtCurrency(totalValueCadSummary) },
          { label: "ACB", value: fmtCurrency(totalCostCad) },
          {
            label: "Gain",
            value: (
              // block + whitespace-normal defeats StatStrip's `truncate`, so a
              // long gain wraps onto a second line instead of ellipsing.
              <span className={`block whitespace-normal break-words ${totalGainCad >= 0 ? "text-pos" : "text-neg"}`}>
                {totalGainCad >= 0 ? "+" : ""}{fmtCurrency(totalGainCad)}
                {totalGainPct != null && <> · {fmtGainLoss(totalGainPct)}</>}
              </span>
            ),
          },
          {
            label: "Today",
            value: todayReturn != null
              ? <span className={todayReturn >= 0 ? "text-pos" : "text-neg"}>{fmtGainLoss(todayReturn)}</span>
              : <span className="text-ink-faint">—</span>,
          },
          {
            label: "Blended MER",
            title: "Weighted-average management expense ratio across the current positions. Updates live as weights drift. Cash and direct equities contribute 0%. Funds without an MER on the Dashboard are excluded from the denominator — check the coverage % if the number looks low.",
            value: (
              <span className="block whitespace-normal break-words">
                {blendedMerTile.blended != null ? `${blendedMerTile.blended.toFixed(2)}%` : <span className="text-ink-faint">—</span>}
                {blendedMerTile.coveragePct < 99.5 && (
                  <span className="ml-1.5 font-sans text-[11px] font-normal text-ink-3">{blendedMerTile.coveragePct.toFixed(0)}% covered</span>
                )}
              </span>
            ),
          },
        ]}
      />

      {/* ── Row 3 · Positions (left) + Rebalance / Allocation / Recent trades (right) ── */}
      {/* Two-up only while the positions table is in its narrow default (Drift
          view, not editing). The Value / Gain views and edit mode add three or
          four more columns, which cannot fit a 1.6fr column at 1280px — so the
          table takes the full width there and the right stack drops below it,
          rather than scrolling sideways. */}
      <div className={`grid grid-cols-1 items-start gap-3.5 ${positionsWide ? "" : "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"}`}>
        {/* Positions panel */}
        <section className="panel animate-panel-in flex min-w-0 flex-col">
          <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
            <span className="t-mark bg-hub-portfolio" aria-hidden />
            <span className="t">Positions</span>
            {allocMeta && <span className="m min-w-0 break-words">{allocMeta}</span>}
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              {pricesFetchedAt && (
                <span className="m" title="When live prices and FX were last fetched from Yahoo. Refreshes when the page mounts or the group changes.">
                  prices {formatRelTimeShort(pricesFetchedAt)}
                </span>
              )}
              <div className="seg">
                {POS_VIEWS.map((v) => (
                  <button key={v.id} onClick={() => setUiPref("positioning.view", v.id)} className={posView === v.id ? "on" : ""}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {loading && holdingRows.length === 0 ? (
            <div className="p-3.5"><SkeletonTable rows={8} cols={6} /></div>
          ) : (
            <div className="min-w-0">
              <table className="data-table">
                <thead>
                  <tr>
                    {sortTh("symbol", "Symbol", false, "pl-3.5")}
                    {sortTh("units", "Units")}
                    {sortTh("price", "Price")}
                    {sortTh("value", "Value C$")}
                    {showAcb && sortTh("acb", "ACB C$")}
                    {showGainCad && <th className="n">Gain C$</th>}
                    {showGain && sortTh("gainLoss", "Gain")}
                    {sortTh("modelPct", "Model")}
                    {hasPositions && (
                      <>
                        {sortTh("currentPct", "Current")}
                        {showBar && <th style={{ width: 120 }}>Drift</th>}
                        {sortTh("drift", showBar ? "" : "Drift")}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(["fixedIncome", "equity", "alternative"] as PimAssetClass[]).map((ac) => {
                    const classRows = positionsByClass[ac];
                    if (!classRows.length) return null;
                    const classValue = classRows.reduce((t, r) => t + r.valueCad, 0);
                    const classPct = totalValueCadSummary > 0 ? classValue / totalValueCadSummary : 0;
                    const classTarget = classRows.reduce((t, r) => t + r.modelPct, 0);
                    return (
                      <React.Fragment key={ac}>
                        {/* Sleeve divider row: name · count · value · live vs target */}
                        <tr className="bg-surface-2">
                          <td colSpan={posColCount} className="!h-auto py-1 pl-3.5 text-[11px] text-ink-3">
                            <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                              <span className="font-medium text-ink-2">{POS_CLASS_LABELS[ac]}</span>
                              <span>{classRows.length} holding{classRows.length === 1 ? "" : "s"}</span>
                              <span className="font-mono">{fmtCad0(classValue)}</span>
                              {hasPositions && (
                                <span><span className="font-mono">{fmtPct2(classPct)}</span> vs <span className="font-mono">{fmtPct2(classTarget)}</span> target</span>
                              )}
                            </span>
                          </td>
                        </tr>
                        {classRows.map((row) => {
                          const dTargetV = dPos[row.assetClass]?.target.get(row.symbol) ?? null;
                          const dCurrentV = dPos[row.assetClass]?.current.get(row.symbol) ?? null;
                          // Drift is the difference between the two numbers ON SCREEN,
                          // not a separately-rounded float — otherwise the row can show
                          // 1.82% / 1.85% next to a drift of +0.02%.
                          const dDriftV =
                            row.units > 0 && dCurrentV != null && dTargetV != null ? dCurrentV - dTargetV : null;
                          const flat = dDriftV == null || sameAtDisplay(dCurrentV, dTargetV);
                          const overTolerance = row.units > 0 && Math.abs(row.driftPct) >= DRIFT_TOLERANCE;
                          const editPos = editMode ? editPositions.find((p) => p.symbol === row.symbol) : undefined;
                          const gainCad = row.valueCad - row.costValueCad;
                          return (
                            <tr key={row.symbol}>
                              <td className="pl-3.5">
                                <span className="font-mono font-medium text-ink">{displayTicker(row.symbol)}</span>
                                {row.currency === "USD" && <span className="ml-1.5 text-[11px] text-ink-3">USD</span>}
                                {row.name && (
                                  // Wraps rather than truncates: a 220px
                                  // no-break name set the column's minimum
                                  // width and pushed the table sideways.
                                  <span className="ml-2 break-words text-[12px] text-ink-3" title={row.name}>{row.name}</span>
                                )}
                                {row.isOrphan && (
                                  <span
                                    className="ml-2 text-[11px] text-warn"
                                    title="Held in the book but NOT a holding in this model. It has no target weight, and until it is added to the model it will not be rebalanced or attributed. Add it via Buy / Sell or the Models tab."
                                  >
                                    not in model
                                  </span>
                                )}
                              </td>
                              <td className="n text-ink-3">
                                {editMode ? (
                                  <input
                                    type="number"
                                    value={editPos?.units || ""}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value) || 0;
                                      setEditPositions((prev) =>
                                        prev.map((p) => p.symbol === row.symbol ? { ...p, units: val } : p)
                                      );
                                    }}
                                    className={`${INPUT} w-24 text-right font-mono`}
                                    step="0.0001"
                                  />
                                ) : (
                                  row.units > 0 ? fmtUnits(row.units) : <span className="text-ink-faint">—</span>
                                )}
                              </td>
                              <td className="n">{row.price > 0 ? row.price.toFixed(2) : <span className="text-ink-faint">—</span>}</td>
                              <td className="n">{row.valueCad > 0 ? fmtN0(row.valueCad) : <span className="text-ink-faint">—</span>}</td>
                              {showAcb && (
                                <td className="n text-ink-2">
                                  {editMode ? (
                                    <span className="inline-flex flex-col items-end gap-0.5 py-1">
                                      <input
                                        type="number"
                                        value={editPos?.costBasis || ""}
                                        onChange={(e) => {
                                          const val = parseFloat(e.target.value) || 0;
                                          setEditPositions((prev) =>
                                            prev.map((p) => p.symbol === row.symbol ? { ...p, costBasis: val } : p)
                                          );
                                        }}
                                        className={`${INPUT} w-24 text-right font-mono`}
                                        step="0.01"
                                        placeholder={`Cost (${row.currency})`}
                                      />
                                      <span className="text-[11px] text-ink-3">{row.costValueCad > 0 ? fmtN0(row.costValueCad) : "—"}</span>
                                    </span>
                                  ) : (
                                    row.costValueCad > 0 ? fmtN0(row.costValueCad) : <span className="text-ink-faint">—</span>
                                  )}
                                </td>
                              )}
                              {showGainCad && (
                                <td className={`n ${row.units > 0 ? (gainCad >= 0 ? "text-pos" : "text-neg") : ""}`}>
                                  {row.units > 0 ? `${gainCad >= 0 ? "+" : "−"}${fmtN0(Math.abs(gainCad))}` : <span className="text-ink-faint">—</span>}
                                </td>
                              )}
                              {showGain && (
                                <td className={`n ${row.units > 0 ? (row.gainLoss >= 0 ? "text-pos" : "text-neg") : ""}`}>
                                  {row.units > 0 ? fmtGainLoss(row.gainLoss) : <span className="text-ink-faint">—</span>}
                                </td>
                              )}
                              <td className="n text-ink-3">{fmtPct2(dTargetV)}</td>
                              {hasPositions && (
                                <>
                                  <td className="n">{row.units > 0 ? fmtPct2(dCurrentV) : <span className="text-ink-faint">—</span>}</td>
                                  {showBar && (
                                    <td>
                                      <DriftBar drift={dDriftV} scalePp={driftScalePp} warn={overTolerance} />
                                    </td>
                                  )}
                                  <td className={`n ${flat ? "text-ink-3" : overTolerance ? "text-warn" : "text-ink-2"}`}>
                                    {dDriftV == null ? <span className="text-ink-faint">—</span> : `${dDriftV > 0 ? "+" : ""}${fmtPct2(dDriftV)}`}
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                  {/* Cash — display only. cashBalance is tracked in
                      pm:pim-positions and feeds total value + MER coverage;
                      this row surfaces it beside the holdings without adding an
                      edit affordance. */}
                  {hasPositions && (
                    <tr>
                      <td className="pl-3.5">
                        <span className="font-mono font-medium text-ink">Cash</span>
                        <span className="ml-2 text-[12px] text-ink-3">CAD</span>
                      </td>
                      <td className="n" />
                      <td className="n" />
                      <td className="n">{fmtN0(cashBalanceCad)}</td>
                      {showAcb && <td className="n" />}
                      {showGainCad && <td className="n" />}
                      {showGain && <td className="n" />}
                      <td className="n text-ink-3">{fmtPct2(cashTargetPct)}</td>
                      <td className="n">{fmtPct2(cashPct)}</td>
                      {showBar && (
                        <td>
                          <DriftBar drift={cashDriftPct == null ? null : cashDriftPct * 100} scalePp={driftScalePp} warn={cashDriftPct != null && Math.abs(cashDriftPct) >= DRIFT_TOLERANCE} />
                        </td>
                      )}
                      <td className={`n ${cashDriftPct != null && Math.abs(cashDriftPct) >= DRIFT_TOLERANCE ? "text-warn" : "text-ink-3"}`}>
                        {cashDriftPct == null ? "—" : `${cashDriftPct > 0 ? "+" : ""}${fmtPct2(cashDriftPct)}`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex min-h-[32px] flex-wrap items-center gap-x-2 border-t border-line-soft px-3.5 py-1 text-[11.5px] text-ink-3">
            <span>{heldCount} of {holdingRows.length} held{hasPositions && <> · {outsideTolerance} outside tolerance ({(DRIFT_TOLERANCE * 100).toFixed(1)}pp)</>}</span>
            {usdCadRate > 1 && (
              <span className="ml-auto font-mono">
                USD/CAD {usdCadRate.toFixed(4)}
                {prevCloseUsdCad > 1 && prevCloseUsdCad !== usdCadRate && <> · {prevCloseUsdCad.toFixed(4)} prev close</>}
              </span>
            )}
          </div>
        </section>

        {/* Right stack */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Rebalance preview / execution */}
          <section className="panel animate-panel-in">
            <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
              <span className="t-mark bg-hub-portfolio" aria-hidden />
              <span className="t">Rebalance to {PROFILE_LABELS[activeProfile]}</span>
              <span className="m min-w-0 break-words">
                {showRebalance ? "execute" : "preview"} · {rebalanceTrades.length} trade{rebalanceTrades.length === 1 ? "" : "s"} · {fmtCad0(rebalanceGross)} gross
              </span>
              <div className="ml-auto flex items-center gap-2">
                <div className="seg">
                  <button onClick={() => { if (rebalanceDetail) toggleRebalanceDetail(); }} className={rebalanceDetail ? "" : "on"}>Trades</button>
                  <button onClick={() => { if (!rebalanceDetail) toggleRebalanceDetail(); }} className={rebalanceDetail ? "on" : ""}>Detail</button>
                </div>
                {showRebalance ? (
                  <button onClick={() => { setShowRebalance(false); setRebalancePrices({}); }} className={BTN_SECONDARY}>Cancel</button>
                ) : (
                  <button onClick={() => setShowRebalance(true)} className={BTN_PRIMARY}>Queue trades</button>
                )}
              </div>
            </div>
            {showRebalance && (
              <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-[1.5] text-ink-3">
                Target units are calculated from <span className="text-ink-2">previous close</span> prices to match the trading desk.
                Enter the actual execution price for ACB tracking. Mutual funds are recorded as pending and settled when NAV is available.
                Prices are shared across profiles.
              </p>
            )}
            {rebalanceVisible.length === 0 ? (
              <div className="px-3.5 py-3 text-[12px] text-ink-3">
                {rebalanceRows.length === 0 ? "No model targets to rebalance against." : "Every position is on target at previous close."}
              </div>
            ) : (
              <div className="min-w-0">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="pl-3.5">Symbol</th>
                      <th>Action</th>
                      <th className="n">Δ Units</th>
                      <th className="n">Exec</th>
                      <th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebalanceVisible.map((r) => (
                      <React.Fragment key={r.symbol}>
                      <tr className="row-link">
                        <td className="pl-3.5">
                          <Link href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`} className="font-mono font-medium text-ink hover:text-accent">
                            {displayTicker(r.symbol)}
                          </Link>
                          {r.isMF && <span className="ml-1.5 text-[11px] text-ink-3">fund</span>}
                          {fundMissingMer(r.symbol) && (
                            <Link
                              href={`/stock/${symbolToTicker(r.symbol).toLowerCase()}?from=positioning`}
                              title="No MER on file for this fund/ETF — click to add a manual override. Missing MERs are treated as 0% in the blended-fee calc, understating total fees."
                              className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-warn hover:underline"
                            >
                              <AppIcon name="warn" size={11} /> no MER
                            </Link>
                          )}
                        </td>
                        <td className={`text-[12px] font-medium ${r.action === "SELL" ? "text-neg" : r.action === "BUY" ? "text-pos" : "text-ink-3"}`}>
                          {r.action === "SELL" ? "Sell" : r.action === "BUY" ? "Buy" : "—"}
                        </td>
                        <td className={`n ${r.action === "BUY" ? "text-pos" : r.action === "SELL" ? "text-neg" : "text-ink-3"}`}>
                          {r.action === "HOLD" ? "—" : r.isMF ? (
                            <span title="Dollar amount — units determined at settlement">${Math.abs(r.deltaValueCad).toFixed(0)}</span>
                          ) : `${r.deltaUnits > 0 ? "+" : ""}${r.deltaUnits.toFixed(2)}`}
                        </td>
                        <td className="n text-ink-3">
                          {r.isMF ? (
                            <span className="text-[11px]">pending</span>
                          ) : showRebalance && r.action !== "HOLD" ? (
                            <input type="number" step="0.01" placeholder={r.pcPrice > 0 ? r.pcPrice.toFixed(2) : "Price"}
                              value={rebalancePrices[r.symbol] || ""}
                              onChange={(e) => setRebalancePrices((p) => ({ ...p, [r.symbol]: e.target.value }))}
                              className={`${INPUT} w-[72px] text-right font-mono`} />
                          ) : r.pcPrice > 0 ? r.pcPrice.toFixed(2) : "—"}
                        </td>
                        <td className="n text-ink-2">{r.costCad > 0 ? fmtN0(r.costCad) : "—"}</td>
                      </tr>
                      {/* Detail view keeps every figure it always showed, but
                          as a labelled grid under the row instead of five more
                          columns — the panel sits in a ~390px column, where
                          ten columns could only scroll sideways. */}
                      {rebalanceDetail && (
                        <tr className="bg-surface-2">
                          <td colSpan={5} className="!h-auto py-1.5 pl-3.5 pr-2.5">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-3">
                              {[
                                { label: "Target", value: pct(r.modelPct), cls: "text-ink-2" },
                                { label: "Current", value: pct(r.pcCurrentPct), cls: "text-ink-2", title: "Based on previous close" },
                                {
                                  label: "Drift",
                                  value: `${r.pcDrift > 0 ? "+" : ""}${(r.pcDrift * 10000).toFixed(0)}bp`,
                                  cls: r.pcDrift > 0 ? "text-pos" : r.pcDrift < 0 ? "text-neg" : "text-ink-3",
                                },
                                { label: "Units", value: r.units > 0 ? r.units.toFixed(2) : "—", cls: "text-ink-2" },
                                {
                                  label: "Target units",
                                  value: r.isMF ? "—" : r.targetUnits.toFixed(2),
                                  cls: "text-ink-2",
                                  title: r.isMF ? "Units calculated at settlement" : undefined,
                                },
                                { label: "Prev close", value: r.pcPrice > 0 ? r.pcPrice.toFixed(2) : "—", cls: "text-ink-2" },
                              ].map((d) => (
                                <span key={d.label} className="min-w-0" title={d.title}>
                                  <span className="block text-[11px] text-ink-3">{d.label}</span>
                                  <span className={`block break-words font-mono ${d.cls}`}>{d.value}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(showRebalance || (!rebalanceDetail && rebalanceRows.length > rebalanceTrades.length)) && (
              <div className="flex min-h-[32px] flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
                {showRebalance && (
                  <>
                    <button onClick={handleExecuteRebalance} className={BTN_PRIMARY}>
                      Execute ({PROFILE_LABELS[activeProfile]})
                    </button>
                    {availableProfiles.length > 1 && (
                      <button onClick={handleExecuteAllProfiles} className={BTN_SECONDARY}>Execute all profiles</button>
                    )}
                    {rebalanceHasMF && (
                      <span>Mutual fund trades are recorded as pending — settle tomorrow when NAV is available.</span>
                    )}
                  </>
                )}
                {!rebalanceDetail && rebalanceRows.length > rebalanceTrades.length && (
                  <span className="ml-auto">{rebalanceRows.length - rebalanceTrades.length} on target hidden</span>
                )}
              </div>
            )}
          </section>

          {/* Allocation — target vs live per sleeve. Re-renders whenever prices
              refresh or the profile tab changes. */}
          {allocationBreakdown && (
            <AllocationPanel live={allocationBreakdown.live} target={allocationBreakdown.target} />
          )}

          {/* Recent trades: last settled transactions from the group's
              persisted log. Read-only — we don't store per-trade share counts,
              so execution price is shown instead of "+N sh". */}
          {groupState.transactions.filter((t) => t.status !== "pending").length > 0 && (() => {
            const recent = [...groupState.transactions]
              .filter((t) => t.status !== "pending")
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .slice(0, 6);
            const lastRebDate = groupState.lastRebalance?.date;
            return (
              <CollapsibleSection
                prefKey="positioning.recentTrades"
                title="Recent trades"
                subtitle={lastRebDate
                  ? `since last rebalance · ${new Date(lastRebDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                  : undefined}
              >
                <div className="stagger -mx-3.5 -my-2">
                  {recent.map((t, i) => (
                    <div
                      key={t.id}
                      style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
                      className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-line-soft px-3.5 py-2 text-[12.5px] last:border-b-0"
                    >
                      <span className="w-12 shrink-0 font-mono text-[11.5px] text-ink-3">
                        {new Date(t.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                      <span className={`w-9 shrink-0 font-medium ${t.direction === "sell" ? "text-neg" : "text-pos"}`}>
                        {t.direction === "sell" ? "Sell" : "Buy"}
                      </span>
                      <span className="min-w-0 break-words font-mono font-medium text-ink">{displayTicker(t.symbol)}</span>
                      {(t.type === "switch" || t.type === "rebalance") && (
                        <span className="min-w-0 break-words text-[11.5px] text-ink-3">{t.type}{t.pairedWith ? ` · ${displayTicker(t.pairedWith)}` : ""}</span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-ink-2">{t.price > 0 ? `@ ${t.price.toFixed(2)}` : "—"}</span>
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            );
          })()}
        </div>
      </div>

      {/* Settle pending mutual-fund trades — a full-width task panel (it was
          in the ~390px right stack, where seven columns could only scroll
          sideways). Every column, control and the persisted fold are kept. */}
      {showSettlement && pendingTrades.length > 0 && (
        <section className="panel animate-panel-in">
          <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
            <span className="t-mark bg-warn" aria-hidden />
            <button onClick={toggleSettleOpen} aria-expanded={settleOpen} className="inline-flex items-center gap-1.5 text-ink hover:text-ink-2">
              <AppIcon name={settleOpen ? "chevD" : "chevR"} size={13} className="text-ink-3" />
              <span className="t">Settle pending MF trades</span>
            </button>
            <span className="m min-w-0 break-words">{pendingTrades.length} pending · NAV auto-fetched from Barchart — verify and adjust</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button onClick={handleFetchSettlementPrices} disabled={settlementLoading} className={BTN_SECONDARY}>
                <AppIcon name="refresh" size={13} className={settlementLoading ? "animate-spin" : ""} />
                {settlementLoading ? "Fetching…" : "Refresh NAV"}
              </button>
              <button
                onClick={handleSettlePending}
                disabled={settling || !pendingTrades.some((t) => parseFloat(settlementPrices[t.symbol] || "0") > 0)}
                className={BTN_PRIMARY}
              >
                {settling ? "Settling…" : "Settle all"}
              </button>
              <button onClick={() => { setShowSettlement(false); setSettlementPrices({}); }} className={BTN_SECONDARY}>Cancel</button>
            </div>
          </div>
          {settleOpen && (
            <div className="min-w-0">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Symbol</th>
                    <th>Profile</th>
                    <th>Direction</th>
                    <th className="n">Amount C$</th>
                    <th className="n">NAV</th>
                    <th className="n">Units</th>
                    <th>Trade date</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingTrades.map((t) => {
                    const nav = parseFloat(settlementPrices[t.symbol] || "0");
                    const units = nav > 0 && t.targetAmount ? t.targetAmount / nav : 0;
                    return (
                      <tr key={t.id}>
                        <td className="pl-3.5 font-mono font-medium">{displayTicker(t.symbol)}</td>
                        <td className="text-ink-2">{PROFILE_LABELS[(t.profile || activeProfile) as PimProfileType]}</td>
                        <td className={`text-[12px] font-medium ${t.direction === "sell" ? "text-neg" : "text-pos"}`}>{t.direction === "sell" ? "Sell" : "Buy"}</td>
                        <td className="n">{(t.targetAmount || 0).toFixed(2)}</td>
                        <td className="n">
                          <input type="number" step="0.0001" placeholder="NAV"
                            value={settlementPrices[t.symbol] || ""}
                            onChange={(e) => setSettlementPrices((p) => ({ ...p, [t.symbol]: e.target.value }))}
                            className={`${INPUT} w-24 text-right font-mono`} />
                        </td>
                        <td className="n font-medium">{units > 0 ? units.toFixed(4) : "—"}</td>
                        <td className="nw font-mono text-ink-3">{new Date(t.date).toLocaleDateString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Thesis owed — bought names still without a signed thesis. */}
      {thesisOwed.length > 0 && (
        <div className="animate-panel-in flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-warn-border bg-warn-soft px-3.5 py-2 text-[12px]">
          <AppIcon name="warn" size={14} className="shrink-0 text-warn" />
          <span className="shrink-0 font-medium text-warn">Thesis required</span>
          <span className="min-w-0 break-words text-ink-2">Bought — write the thesis or draft it with AI, then sign, so monitoring starts:</span>
          <span className="flex flex-wrap items-center gap-2">
            {thesisOwed.map((t) => (
              <Link key={t} href={`/stock/${encodeURIComponent(t)}#thesis-tile`} className="font-mono font-medium text-accent hover:underline">
                {displayTicker(t)}
              </Link>
            ))}
          </span>
          <button onClick={() => setThesisOwed([])} className="ml-auto text-[11.5px] text-ink-3 hover:text-ink" title="Hide this reminder (the Dashboard banner keeps tracking the gap)">Dismiss</button>
        </div>
      )}

      {/* Buy/Sell panel — supports a queue of trades, each independently
          configurable as buy-only / sell-only / switch. Sell % defaults
          to 100; lower values run a partial-sell, which trims the model
          target by the fraction sold AND adds the bought name to each
          eligible model. Execute All runs the queue sequentially. */}
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
        <section className="panel animate-panel-in">
          <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
            <span className="t-mark bg-hub-portfolio" aria-hidden />
            <span className="t">Buy / Sell</span>
            <span className="m min-w-0 break-words">{trades.length} queued · sell % under 100 trims the model target by the same fraction</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button onClick={addTrade} className={BTN_SECONDARY}>
                <AppIcon name="plus" size={13} /> Add another trade
              </button>
            </div>
          </div>
          <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-[1.5] text-ink-3">
            Queue one or more trades. Sell % defaults to 100 (full position); lower it for a partial sell — the model target is trimmed by the same fraction and the bought name is added to each eligible model. Sell-only credits proceeds to cash; buy-only sizes the position from its model target and debits cash.
          </p>
          <div className="flex flex-col gap-3 p-3.5">
            {trades.map((t, idx) => {
              const sellPctParsed = parseFloat(t.sellPercent);
              const isPartial = !!t.sellSymbol && Number.isFinite(sellPctParsed) && sellPctParsed > 0 && sellPctParsed < 100;
              return (
                <div key={t.id} className="rounded-card border border-line-soft bg-surface-2 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] text-ink-3">
                      Trade {idx + 1}{isPartial ? " · partial" : t.sellSymbol && t.buyTicker ? " · switch" : t.sellSymbol ? " · sell" : t.buyTicker ? " · buy" : ""}
                    </span>
                    {trades.length > 1 && (
                      <button onClick={() => removeTrade(t.id)}
                        className="inline-flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-neg"
                        title="Remove this trade from the queue">
                        <AppIcon name="x" size={12} /> Remove
                      </button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label className="text-[11px] text-neg">Sell (optional)</label>
                      <select value={t.sellSymbol}
                        onChange={(e) => {
                          // The buy inherits the sold name's sleeve by default —
                          // a JBND sale funds a fixed-income buy unless the user
                          // says otherwise via the class selector.
                          const soldClass = sellCandidates.find((c) => symbolEq(c.symbol, e.target.value))?.assetClass;
                          updateTrade(t.id, {
                            sellSymbol: e.target.value,
                            sellPrice: e.target.value ? t.sellPrice : "",
                            ...(soldClass ? { buyAssetClass: soldClass } : {}),
                          });
                        }}
                        className={`${INPUT} w-full min-w-0`}>
                        <option value="">None — buy only</option>
                {sellCandidates.map((h) => (
                          <option key={h.symbol} value={h.symbol}>
                            {symbolToTicker(h.symbol)} — {h.name}
                            {h.assetClass === "fixedIncome" ? " · fixed income" : h.assetClass === "alternative" ? " · alternative" : ""}
                          </option>
                        ))}
                      </select>
                      {t.sellSymbol && (
                        <>
                          <div className="grid grid-cols-[1fr_88px] gap-2">
                            <input type="number" step="0.01" placeholder="Sell price"
                              value={t.sellPrice}
                              onChange={(e) => updateTrade(t.id, { sellPrice: e.target.value })}
                              className={`${INPUT} w-full font-mono`} />
                            <div className="relative">
                              <input type="number" step="1" min="1" max="100"
                                value={t.sellPercent}
                                onChange={(e) => updateTrade(t.id, { sellPercent: e.target.value })}
                                aria-label="Percent of position to sell"
                                title="Percent of the position to sell. 100 = full liquidation (the name is replaced in every model that holds it); <100 = partial sell (the model target is trimmed by the same fraction, and any bought name is added)."
                                className={`${INPUT} w-full pr-6 font-mono`} />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">%</span>
                            </div>
                          </div>
                          {livePrices[t.sellSymbol] && (
                            <p className="text-[11px] text-ink-3">Market: <span className="font-mono">${livePrices[t.sellSymbol].toFixed(2)}</span></p>
                          )}
                          {isPartial && (() => {
                            // A trim to an individual stock cannot be expressed
                            // in the model: stock targets are equal-weighted by
                            // construction, so the residual rule puts the weight
                            // straight back. Say so BEFORE the button is pressed.
                            const soldIsEqualWeightStock = stocks.some(
                              (st) => symbolEq(st.ticker, t.sellSymbol) &&
                                st.bucket === "Portfolio" &&
                                (st.instrumentType === "stock" || st.instrumentType === undefined),
                            );
                            const soldCand = sellCandidates.find((c) => symbolEq(c.symbol, t.sellSymbol));
                            const soldNonEquity = soldCand && soldCand.assetClass !== "equity";
                            return (
                              <p className="text-[11px] leading-[1.5] text-warn">
                                Partial sell — the model target is trimmed by the same {sellPctParsed || 0}%
                                {t.buyTicker ? `, and ${t.buyTicker.toUpperCase()} is added to each eligible model.` : "."}
                                {soldIsEqualWeightStock && (
                                  <> <strong>{displayTicker(t.sellSymbol)} is an individual stock, so its target cannot be trimmed</strong> — stock targets are equal-weighted by design. The position will shrink; the target will not.</>
                                )}
                                {soldNonEquity && (
                                  <> {displayTicker(t.sellSymbol)} is {soldCand.assetClass === "fixedIncome" ? "fixed income" : "an alternative"} — the freed target goes to {t.buyTicker ? "the bought fund" : "the sleeve's other holdings"}; where a model holds nothing else in that sleeve, the position shrinks but the target stays.</>
                                )}
                              </p>
                            );
                          })()}
                        </>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label className="text-[11px] text-pos">Buy (from Watchlist)</label>
                      {watchlistStocks.length === 0 ? (
                        <div className="rounded-control border border-dashed border-line bg-surface px-2.5 py-2 text-[11.5px] text-ink-3">
                          Watchlist is empty. Press <kbd className="rounded border border-line bg-surface-2 px-1 py-px font-mono text-[10.5px]">Shift + A</kbd> to add a research candidate first.
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
                            // Default sleeve: inherit the sold holding's class on a
                            // switch; otherwise guess from the name (bond → fixed
                            // income). Always user-overridable below.
                            const soldClass = t.sellSymbol
                              ? sellCandidates.find((c) => symbolEq(c.symbol, t.sellSymbol))?.assetClass
                              : undefined;
                            updateTrade(t.id, {
                              buyTicker: e.target.value,
                              buyName: picked?.name || e.target.value,
                              buyPrice: e.target.value ? t.buyPrice : "",
                              excludedGroupIds: autoExcluded,
                              buyAssetClass: soldClass
                                ?? guessAssetClass(picked?.name || "", e.target.value),
                            });
                          }}
                          className={`${INPUT} w-full min-w-0 font-mono`}>
                          <option value="">— None — sell only —</option>
                          {watchlistStocks.map((s) => (
                            <option key={s.ticker} value={s.ticker}>
                              {s.ticker}{s.name && s.name !== s.ticker ? ` · ${s.name}` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      {t.buyTicker && (
                        <>
                          <input type="number" step="0.01" placeholder="Buy price"
                            value={t.buyPrice}
                            onChange={(e) => updateTrade(t.id, { buyPrice: e.target.value })}
                            className={`${INPUT} w-full font-mono`} />
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="whitespace-nowrap text-[11px] text-ink-3">Sleeve</span>
                            <select value={t.buyAssetClass}
                              onChange={(e) => updateTrade(t.id, { buyAssetClass: e.target.value as PimAssetClass })}
                              className={`${INPUT} w-full min-w-0`}
                              title="Which model sleeve the bought security belongs to. A switch must stay within one sleeve — changing the equity/fixed-income mix is a profile-allocation decision, not a trade.">
                              <option value="equity">Equity</option>
                              <option value="fixedIncome">Fixed income</option>
                              <option value="alternative">Alternative</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  {t.buyTicker && (
                    <div className="mt-3 rounded-card border border-line-soft bg-surface p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-ink-3">Models this trade applies to</span>
                        {t.excludedGroupIds.includes(NO_US_SITUS_GROUP_ID) &&
                          isUsSitusTicker(t.buyTicker) && (
                          <span className="text-[11px] text-warn">No US Situs auto-excluded (US-listed)</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {pimModels.groups.map((g) => {
                          const eligible = !t.excludedGroupIds.includes(g.id);
                          return (
                            <label key={g.id} className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-ink">
                              <input
                                type="checkbox"
                                checked={eligible}
                                onChange={(e) => {
                                  const next = new Set(t.excludedGroupIds);
                                  if (e.target.checked) next.delete(g.id);
                                  else next.add(g.id);
                                  updateTrade(t.id, { excludedGroupIds: [...next] });
                                }}
                                className="h-3.5 w-3.5 rounded border-line accent-accent"
                              />
                              {g.name}
                            </label>
                          );
                        })}
                      </div>
                      <p className="mt-1.5 text-[11px] text-ink-3">
                        Unticked models are left completely untouched — neither the sell nor the buy executes there.
                      </p>
                    </div>
                  )}

                  {/* ── Unit plan ──────────────────────────────────────────
                      What this trade will actually do to the BOOK, per group
                      and profile, before it is executed. The model swap and
                      the unit math are separate steps inside the executor, and
                      when the unit step silently did nothing the result was a
                      holding in the model with no shares against it — worth
                      nothing to performance, and visible only if you went
                      looking. This makes it checkable up front. */}
                  {(t.sellSymbol || t.buyTicker) && (() => {
                    const plan = planTrade({
                      sellSymbol: t.sellSymbol,
                      buySymbol: t.buyTicker.trim().toUpperCase(),
                      sellPrice: parseFloat(t.sellPrice) || 0,
                      buyPrice: parseFloat(t.buyPrice) || 0,
                      sellPercent: parseFloat(t.sellPercent) || 100,
                      usdCadRate,
                      positions,
                      models: pimModels,
                      affectedGroupIds: pimModels.groups
                        .map((g) => g.id)
                        .filter((id) => !t.excludedGroupIds.includes(id)),
                    });
                    const active = plan.rows.filter((r) => r.heldUnits > 0 || r.unitsToBuy > 0);
                    return (
                      <div className="mt-3 overflow-hidden rounded-card border border-line-soft bg-surface">
                        <div className="flex min-h-[30px] items-center px-3 text-[11px] text-ink-3">Units this trade will book</div>
                        {active.length === 0 ? (
                          <p className="border-t border-line-soft px-3 py-2 text-[11.5px] font-medium text-neg">
                            No units will be recorded anywhere — the model would change but the book
                            would not.
                          </p>
                        ) : (
                          <div className="min-w-0">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th className="pl-3">Model · Profile</th>
                                  <th className="n">Sell units</th>
                                  <th className="n">Proceeds</th>
                                  <th className="n">Buy units</th>
                                </tr>
                              </thead>
                              <tbody>
                                {active.map((r) => (
                                  <tr key={`${r.groupId}-${r.profile}`}>
                                    <td className="pl-3 text-ink">
                                      {r.groupName} · {r.profile}
                                      {r.note && <span className="ml-1.5 text-neg">{r.note}</span>}
                                    </td>
                                    <td className="n text-ink-2">{r.unitsToSell > 0 ? fmtUnits(+r.unitsToSell.toFixed(4)) : "—"}</td>
                                    <td className="n text-ink-2">{r.proceedsCad > 0 ? fmtCurrency(r.proceedsCad) : "—"}</td>
                                    <td className="n font-medium text-ink">{r.unitsToBuy > 0 ? fmtUnits(+r.unitsToBuy.toFixed(4)) : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {(plan.modelOnlyGroups.length > 0 || plan.warnings.length > 0) && (
                          <div className="border-t border-line-soft px-3 py-1.5">
                            {plan.modelOnlyGroups.length > 0 && (
                              <p className="text-[11px] text-ink-3">
                                Model-only (no position record, so no units): {plan.modelOnlyGroups.join(", ")}.
                              </p>
                            )}
                            {plan.warnings.map((w, i) => (
                              <p key={i} className="mt-1 text-[11px] font-medium text-neg">{w}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
          <div className="flex min-h-[32px] flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-1.5">
            <button onClick={() => void executeAllTrades()}
              disabled={!anyValid || executingTrades}
              className={BTN_PRIMARY}>
              {executingTrades ? "Executing…" : `Execute all (${trades.length})`}
            </button>
            <button onClick={closeAndReset} disabled={executingTrades} className={BTN_SECONDARY}>Cancel</button>
            {tradeExecProgress && <span className="text-[11.5px] text-warn">{tradeExecProgress}</span>}
          </div>
        </section>
        );
      })()}

      {/* Suggested trades: compact row derived from live drift. "Review &
          execute all" opens the Rebalance panel's execution mode — no
          rebalance math or execution path is changed, this is a shortcut. */}
      {hasPositions && !editMode && (() => {
        const suggestions = sortedRows
          .filter((r) => r.units > 0 && r.modelPct > 0)
          .map((r) => ({ symbol: r.symbol, adj: -r.driftPct })) // adj>0 = add, adj<0 = trim
          .filter((s) => Math.abs(s.adj) >= 0.0005)
          .sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj))
          .slice(0, 6);
        if (suggestions.length === 0) return null;
        return (
          <section className="panel animate-panel-in">
            <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
              <span className="t-mark bg-warn" aria-hidden />
              <span className="t">Suggested trades</span>
              <span className="m min-w-0 break-words">to reach the {PROFILE_LABELS[activeProfile]} target</span>
              <button onClick={() => setShowRebalance(true)} className={`${BTN_SECONDARY} ml-auto`}>
                Review &amp; execute all <AppIcon name="arrowR" size={13} />
              </button>
            </div>
            <div className="stagger flex flex-wrap items-center gap-2 px-3.5 py-2.5">
              {suggestions.map((s, i) => {
                const isTrim = s.adj < 0;
                return (
                  <div key={s.symbol} style={{ "--i": Math.min(i, 8) } as React.CSSProperties} className="inline-flex h-7 items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-[12.5px]">
                    <span className={`font-medium ${isTrim ? "text-warn" : "text-pos"}`}>{isTrim ? "Trim" : "Add"}</span>
                    <span className="font-mono font-medium text-ink">{displayTicker(s.symbol)}</span>
                    <span className={`font-mono ${isTrim ? "text-warn" : "text-pos"}`}>
                      {s.adj > 0 ? "+" : ""}{(s.adj * 100).toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* No positions prompt */}
      {!hasPositions && !editMode && (
        <section className="panel animate-panel-in">
          <EmptyState
            glyph={<AppIcon name="pie" size={18} />}
            title="No position data entered yet"
            body="Enter your current holdings (units and cost basis) to see current weights, drift, and rebalance actions."
            action={<button onClick={startEdit} className={BTN_PRIMARY}>Enter positions</button>}
          />

          {/* ── Build from a sibling profile ────────────────────────────────
              A profile with target weights but no units books no return at
              all. Its book is not a different portfolio, only a different
              asset mix over the same money, so a sibling's market value is
              the right size to build it at. Shown as a plan first — this
              writes real positions. */}
          {seedPlan.rows.length > 0 && (
            <div className="border-t border-line-soft">
              <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
                <span className="t-mark bg-hub-portfolio" aria-hidden />
                <span className="t">Build {PROFILE_LABELS[activeProfile]} from</span>
                <select
                  value={seedFrom}
                  onChange={(e) => setSeedFrom(e.target.value as PimProfileType)}
                  className={`${INPUT} min-w-0 max-w-full`}
                >
                  {(["balanced", "growth", "allEquity"] as PimProfileType[])
                    .filter((p) => p !== activeProfile && profileMarketValue(p) > 0)
                    .map((p) => (
                      <option key={p} value={p}>
                        {PROFILE_LABELS[p]} — {fmtCurrency(profileMarketValue(p))}
                      </option>
                    ))}
                </select>
                <span className="m min-w-0 break-words">at this profile&apos;s own target weights</span>
                <button
                  onClick={applySeed}
                  disabled={seeding}
                  className={`${BTN_PRIMARY} ml-auto`}
                >
                  {seeding ? "Creating…" : `Create ${seedPlan.rows.length} positions`}
                </button>
              </div>

              <div className="min-w-0">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="pl-3.5">Holding</th>
                      <th className="n">Target wt</th>
                      <th className="n">Value</th>
                      <th className="n">Price</th>
                      <th className="n">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seedPlan.rows.map((r) => (
                      <tr key={r.symbol}>
                        <td className="pl-3.5 font-mono font-medium text-ink">{displayTicker(r.symbol)}</td>
                        <td className="n text-ink-2">{fmtPct2(r.targetWeight)}</td>
                        <td className="n text-ink-2">{fmtCurrency(r.targetValueCad)}</td>
                        <td className="n text-ink-2">{fmtCurrency(r.priceCad)}</td>
                        <td className="n font-medium text-ink">{fmtUnits(+r.units.toFixed(4))}</td>
                      </tr>
                    ))}
                    <tr className="bg-surface-2">
                      <td className="pl-3.5 text-[11.5px] text-ink-3" colSpan={2}>Total invested</td>
                      <td className="n font-medium">
                        {fmtCurrency(seedPlan.rows.reduce((t, r) => t + r.targetValueCad, 0))}
                      </td>
                      <td colSpan={2} className="n font-sans text-[11.5px] text-ink-3">
                        + {fmtCurrency(seedPlan.cash)} cash = {fmtCurrency(seedPlan.totalValue)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-1 border-t border-line-soft px-3.5 py-2 text-[11.5px] text-ink-3">
                {seedPlan.missingPrices.length > 0 && (
                  <p className="font-medium text-warn">
                    No live price for {seedPlan.missingPrices.join(", ")} — these are left out. Refresh
                    prices first, or enter them by hand afterwards.
                  </p>
                )}
                <p>
                  Cost basis is set to today&apos;s price, so the profile starts flat rather than
                  inheriting a gain it never earned.
                </p>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
