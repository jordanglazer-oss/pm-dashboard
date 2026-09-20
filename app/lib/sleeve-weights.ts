/* ─── Sleeve weights: the PROPOSED equity weights under the Thesis/Tactical split ───
 *
 * Pure, read-only. Nothing here writes pm:pim-models — it answers "what would
 * every weight be if the sleeve rule were live?" so the numbers can be checked
 * before the rebalance engine is switched over.
 *
 * All weights are fractions of the EQUITY class (PimHolding.weightInClass).
 *
 *   Core      fixed at CORE_SHARE (50%) when the Alpha sleeves are fully used;
 *             in practice Core is the residual 1 − ΣAlpha, so an unfilled
 *             sleeve or a capped stock parks its weight in Core.
 *   Thesis    (1 − CORE_SHARE) × thesisShare
 *   Tactical  (1 − CORE_SHARE) × (1 − thesisShare)
 *
 * Inside a sleeve, funds / ETFs keep the manually-set weight they carry today
 * and the stocks split what is left equally:
 *
 *   leg = (sleeve budget − the sleeve's fund weights) ÷ stock legs in the sleeve
 *
 * A stock tagged in BOTH sleeves carries a Thesis leg plus a full Tactical leg.
 * Leg sizes are set by the PIM group and reused verbatim in every other model;
 * a name a model does not hold simply leaves that weight in the model's Core.
 * A single STOCK is capped at MAX_STOCK_WEIGHT of the equity class (funds are
 * not capped); the excess goes to Core. */

import type { PimHolding, PimModelGroup } from "./pim-types";
import { canonicalTicker } from "./ticker";
import { isCoreDesignated, isFund, sleevesOf } from "./sleeves";

export const CORE_SHARE = 0.5;
export const DEFAULT_THESIS_SHARE = 2 / 3;
export const MAX_STOCK_WEIGHT = 0.1;

type StockLite = {
  ticker: string;
  bucket?: string;
  instrumentType?: string;
  designation?: "core" | "alpha";
  inThesis?: boolean;
  inTactical?: boolean;
  name?: string;
  sector?: string;
};

export type SleeveRole = "core" | "thesis" | "tactical" | "both" | "untagged" | "unknown";

export type SleeveLegs = {
  thesisBudget: number;
  tacticalBudget: number;
  thesisFunds: number;
  tacticalFunds: number;
  thesisStockLegs: number;
  tacticalStockLegs: number;
  thesisLeg: number;
  tacticalLeg: number;
  warnings: string[];
};

export type ProposedRow = {
  symbol: string;
  name: string;
  kind: "stock" | "fund";
  role: SleeveRole;
  current: number;
  proposed: number;
  capped: boolean;
};

export type ProposedGroup = {
  groupId: string;
  rows: ProposedRow[];
  totals: { core: number; thesis: number; tactical: number; untagged: number };
  currentTotals: { core: number; alpha: number };
  warnings: string[];
};

function indexStocks(stocks: StockLite[]): Map<string, StockLite> {
  const m = new Map<string, StockLite>();
  // Portfolio first so a Watchlist duplicate can never shadow the held record.
  for (const s of [...stocks].sort((a, b) => (a.bucket === "Portfolio" ? -1 : 0) - (b.bucket === "Portfolio" ? -1 : 0))) {
    const k = canonicalTicker(s.ticker);
    if (k && !m.has(k)) m.set(k, s);
  }
  return m;
}

// Mirrors LEGACY_LOCKED_EQUITY_SYMBOLS in StockContext.tsx: a holding with NO
// pm:stocks record is treated by the live rebalance as a residual-absorbing
// Core holding, unless it is one of these specialty funds.
const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);

function roleOf(s: StockLite | undefined, symbol: string): SleeveRole {
  if (!s) return LEGACY_LOCKED.has(symbol) ? "unknown" : "core";
  if (isCoreDesignated(s)) return "core";
  const { thesis, tactical } = sleevesOf(s);
  if (thesis && tactical) return "both";
  if (thesis) return "thesis";
  if (tactical) return "tactical";
  return "untagged";
}

const equityOf = (g: PimModelGroup): PimHolding[] => g.holdings.filter((h) => h.assetClass === "equity");

/** Leg sizes, derived from the PIM group only. */
export function computeSleeveLegs(pim: PimModelGroup | undefined, stocks: StockLite[], thesisShare: number): SleeveLegs {
  const alpha = 1 - CORE_SHARE;
  const legs: SleeveLegs = {
    thesisBudget: alpha * thesisShare,
    tacticalBudget: alpha * (1 - thesisShare),
    thesisFunds: 0,
    tacticalFunds: 0,
    thesisStockLegs: 0,
    tacticalStockLegs: 0,
    thesisLeg: 0,
    tacticalLeg: 0,
    warnings: [],
  };
  if (!pim) {
    legs.warnings.push("No PIM group found — leg sizes cannot be derived.");
    return legs;
  }
  const idx = indexStocks(stocks);
  for (const h of equityOf(pim)) {
    const s = idx.get(canonicalTicker(h.symbol));
    const role = roleOf(s, h.symbol);
    if (role === "core" || role === "unknown" || role === "untagged") continue;
    if (s && isFund(s)) {
      if (role === "thesis") legs.thesisFunds += h.weightInClass;
      else legs.tacticalFunds += h.weightInClass;
    } else {
      if (role === "thesis" || role === "both") legs.thesisStockLegs++;
      if (role === "tactical" || role === "both") legs.tacticalStockLegs++;
    }
  }
  const leg = (budget: number, funds: number, n: number, label: string): number => {
    const room = budget - funds;
    if (room < 0) {
      legs.warnings.push(`${label} funds (${(funds * 100).toFixed(2)}%) exceed the ${label} budget (${(budget * 100).toFixed(2)}%) — ${label} stocks would get no weight.`);
      return 0;
    }
    if (n === 0) {
      if (room > 1e-6) legs.warnings.push(`${label} has no stocks — ${(room * 100).toFixed(2)}% of its budget parks in Core.`);
      return 0;
    }
    return room / n;
  };
  legs.thesisLeg = leg(legs.thesisBudget, legs.thesisFunds, legs.thesisStockLegs, "Thesis");
  legs.tacticalLeg = leg(legs.tacticalBudget, legs.tacticalFunds, legs.tacticalStockLegs, "Tactical");
  return legs;
}

/** Proposed equity weights for one model group, using PIM's leg sizes. */
export function proposeGroupWeights(group: PimModelGroup, stocks: StockLite[], legs: SleeveLegs): ProposedGroup {
  const idx = indexStocks(stocks);
  const equity = equityOf(group);
  const warnings: string[] = [];
  const rows: ProposedRow[] = [];
  const totals = { core: 0, thesis: 0, tactical: 0, untagged: 0 };
  const currentTotals = { core: 0, alpha: 0 };

  const coreHoldings: PimHolding[] = [];
  for (const h of equity) {
    const s = idx.get(canonicalTicker(h.symbol));
    const role = roleOf(s, h.symbol);
    // No pm:stocks record: leave the weight exactly as it is and say so.
    const kind: "stock" | "fund" = s ? (isFund(s) ? "fund" : "stock") : "fund";
    if (role === "core") {
      coreHoldings.push(h);
      currentTotals.core += h.weightInClass;
      continue;
    }
    currentTotals.alpha += h.weightInClass;
    let proposed = h.weightInClass;
    let capped = false;
    if (role === "unknown") {
      warnings.push(`${h.symbol} has no Holdings record — weight left unchanged and counted as untagged Alpha.`);
      totals.untagged += proposed;
    } else if (role === "untagged") {
      warnings.push(`${h.symbol} is untagged — weight left unchanged. Tag it Thesis or Tactical.`);
      totals.untagged += proposed;
    } else if (kind === "fund") {
      if (role === "thesis") totals.thesis += proposed;
      else totals.tactical += proposed;
    } else {
      const t = role === "thesis" || role === "both" ? legs.thesisLeg : 0;
      const k = role === "tactical" || role === "both" ? legs.tacticalLeg : 0;
      proposed = t + k;
      if (proposed > MAX_STOCK_WEIGHT) {
        const scale = MAX_STOCK_WEIGHT / proposed;
        totals.thesis += t * scale;
        totals.tactical += k * scale;
        proposed = MAX_STOCK_WEIGHT;
        capped = true;
      } else {
        totals.thesis += t;
        totals.tactical += k;
      }
    }
    rows.push({ symbol: h.symbol, name: h.name, kind, role, current: h.weightInClass, proposed, capped });
  }

  // Core is the residual, spread across the Core holdings in their current
  // proportions (today's rule — relative Core weights are preserved).
  const alphaTotal = totals.thesis + totals.tactical + totals.untagged;
  const coreTotal = Math.max(0, 1 - alphaTotal);
  if (alphaTotal > 1 + 1e-6) warnings.push(`Alpha weights sum to ${(alphaTotal * 100).toFixed(2)}% — more than the whole equity class.`);
  const coreCurrent = coreHoldings.reduce((a, h) => a + h.weightInClass, 0);
  if (coreHoldings.length === 0 && coreTotal > 1e-6) warnings.push(`No Core holdings in this model — ${(coreTotal * 100).toFixed(2)}% has nowhere to go.`);
  for (const h of coreHoldings) {
    const ratio = coreCurrent > 0 ? h.weightInClass / coreCurrent : 1 / coreHoldings.length;
    rows.push({ symbol: h.symbol, name: h.name, kind: "fund", role: "core", current: h.weightInClass, proposed: ratio * coreTotal, capped: false });
  }
  totals.core = coreHoldings.length > 0 ? coreTotal : 0;

  return { groupId: group.id, rows, totals, currentTotals, warnings };
}
