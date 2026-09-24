/* ─── Weight decisions: the monthly meeting's target-weight decisions ───
 *
 * Three things share the word "weight" and are kept apart:
 *   TARGET  what the model says a name should be (pm:pim-models weightInClass)
 *           — changed only by a decision (here) or a Buy/Sell.
 *   LIVE    what prices have done since the last trades — observed, never decided.
 *   TRADES  the action that moves live toward target — logged in Positioning.
 * Performance is computed daily from targets already, so it needs nothing here.
 *
 * At the first-Monday meeting each held Alpha name gets one of:
 *   keep   the drift is noise; trade back to the current target
 *   adopt  let it ride; the live weight becomes the new target (no trade)
 *   set    an explicit trim / add
 * The record lives in pm:weight-decisions, one entry per month, PIM only
 * (other models inherit PIM's targets; a name a model does not hold leaves that
 * weight in its Core, as today).
 *
 * Rule (Jordan, 2026-09-23): a change absorbs WITHIN THE SAME SLEEVE. A 0.5%
 * trim from one Thesis name must be reallocated to one or more Thesis names
 * before the month can be committed; Core is untouched by a decision. A name in
 * both sleeves counts as Tactical here — the overlay is the variable part.
 * Single STOCKS are capped at 10% of the whole portfolio (funds are not).
 *
 * All weights stored here are weightInClass (fraction of the equity class) so
 * the record is profile-independent; the page edits in % of a chosen profile. */

import type { PimModelGroup, PimProfileType } from "./pim-types";
import { canonicalTicker } from "./ticker";
import { isCoreDesignated, isFund, sleevesOf } from "./sleeves";
import { MAX_STOCK_PORTFOLIO_WEIGHT, maxEquityAllocation } from "./sleeve-weights";

export const WEIGHT_DECISIONS_KEY = "pm:weight-decisions";
/** Commit writes pm:pim-models. Off until the split is approved for production
 *  — preview shares the database, so a commit there would change the live models. */
export const WEIGHT_COMMIT_ENABLED = false;

export type DecisionAction = "keep" | "adopt" | "set";
export type WeightDecision = {
  action: DecisionAction;
  /** New weightInClass for adopt / set; absent for keep. */
  targetInClass?: number;
  /** The live weight (in class) at decision time, for the record. */
  liveInClass?: number | null;
  note?: string;
  at: string;
};
export type MonthReview = {
  month: string; // YYYY-MM
  groupId: string;
  /** Profile the meeting edited in (display basis only). */
  profile: PimProfileType;
  status: "draft" | "committed";
  decisions: Record<string, WeightDecision>; // by PIM symbol
  updatedAt: string;
  committedAt?: string;
  /** Redis key holding the pre-commit pm:pim-models, for rollback. */
  stashKey?: string;
};
export type WeightDecisionStore = { months: Record<string, MonthReview> };

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

type StockLite = { ticker: string; bucket?: string; instrumentType?: string; designation?: "core" | "alpha"; inThesis?: boolean; inTactical?: boolean; name?: string; sector?: string };

export type DecisionSleeve = "thesis" | "tactical";

/** Sleeve a change on this holding nets against; null = not decidable here. */
export function decisionSleeveOf(s: StockLite | undefined): DecisionSleeve | null {
  if (!s || isCoreDesignated(s)) return null;
  const { thesis, tactical } = sleevesOf(s);
  if (tactical) return "tactical"; // both → Tactical (the overlay is the variable part)
  if (thesis) return "thesis";
  return null;
}

export type SleeveNet = { sleeve: DecisionSleeve; delta: number; ok: boolean };
export type Reconciliation = {
  nets: SleeveNet[];
  capBreaches: Array<{ symbol: string; targetInClass: number; capInClass: number }>;
  untouchedUntagged: string[];
  /** Committable: every sleeve nets to zero and no cap is breached. */
  ok: boolean;
};

export const NET_TOLERANCE = 0.00005; // 0.005% of the equity class

/** Check a month's decisions against the group they would be applied to. */
export function reconcile(group: PimModelGroup, stocks: StockLite[], decisions: Record<string, WeightDecision>): Reconciliation {
  const idx = new Map<string, StockLite>();
  for (const s of stocks) if (s.bucket === "Portfolio") idx.set(canonicalTicker(s.ticker), s);
  const deltas: Record<DecisionSleeve, number> = { thesis: 0, tactical: 0 };
  const capInClass = MAX_STOCK_PORTFOLIO_WEIGHT / maxEquityAllocation(group);
  const capBreaches: Reconciliation["capBreaches"] = [];
  const untouchedUntagged: string[] = [];
  for (const h of group.holdings) {
    if (h.assetClass !== "equity") continue;
    const s = idx.get(canonicalTicker(h.symbol));
    const d = decisions[h.symbol];
    if (!d || d.action === "keep" || d.targetInClass == null) continue;
    const sleeve = decisionSleeveOf(s);
    if (!sleeve) { untouchedUntagged.push(h.symbol); continue; }
    deltas[sleeve] += d.targetInClass - h.weightInClass;
    if (s && !isFund(s) && d.targetInClass > capInClass + 1e-9) capBreaches.push({ symbol: h.symbol, targetInClass: d.targetInClass, capInClass });
  }
  const nets: SleeveNet[] = (["thesis", "tactical"] as DecisionSleeve[]).map((sleeve) => ({ sleeve, delta: deltas[sleeve], ok: Math.abs(deltas[sleeve]) <= NET_TOLERANCE }));
  return { nets, capBreaches, untouchedUntagged, ok: nets.every((n) => n.ok) && capBreaches.length === 0 && untouchedUntagged.length === 0 };
}

/** The group with a month's decisions applied (pure — for the diff preview and,
 *  once enabled, the commit). Only decided symbols move; Core is untouched
 *  because decisions net to zero inside each sleeve. */
export function applyDecisions(group: PimModelGroup, decisions: Record<string, WeightDecision>): PimModelGroup {
  return {
    ...group,
    holdings: group.holdings.map((h) => {
      const d = decisions[h.symbol];
      if (h.assetClass !== "equity" || !d || d.action === "keep" || d.targetInClass == null) return h;
      return { ...h, weightInClass: parseFloat(d.targetInClass.toFixed(6)) };
    }),
  };
}

/** Other models inherit PIM's decided targets for the names they hold; the
 *  difference (a trimmed name held here, an added name not eligible) lands in
 *  that model's Core in its current proportions — today's rule. */
export function inheritDecisions(pim: PimModelGroup, other: PimModelGroup, stocks: StockLite[], decisions: Record<string, WeightDecision>): PimModelGroup {
  const idx = new Map<string, StockLite>();
  for (const s of stocks) if (s.bucket === "Portfolio") idx.set(canonicalTicker(s.ticker), s);
  const decided = new Map<string, number>();
  for (const h of pim.holdings) {
    const d = decisions[h.symbol];
    if (h.assetClass === "equity" && d && d.action !== "keep" && d.targetInClass != null) decided.set(canonicalTicker(h.symbol), d.targetInClass);
  }
  const equity = other.holdings.filter((h) => h.assetClass === "equity");
  const core = equity.filter((h) => isCoreDesignated(idx.get(canonicalTicker(h.symbol)) ?? {}) || (!idx.has(canonicalTicker(h.symbol))));
  const coreSet = new Set(core.map((h) => h.symbol));
  let nonCore = 0;
  const next = other.holdings.map((h) => {
    if (h.assetClass !== "equity" || coreSet.has(h.symbol)) return h;
    const t = decided.get(canonicalTicker(h.symbol));
    const w = t != null ? parseFloat(t.toFixed(6)) : h.weightInClass;
    nonCore += w;
    return { ...h, weightInClass: w };
  });
  const coreTotal = Math.max(0, 1 - nonCore);
  const coreCur = core.reduce((a, h) => a + h.weightInClass, 0);
  return {
    ...other,
    holdings: next.map((h) => {
      if (!coreSet.has(h.symbol)) return h;
      const ratio = coreCur > 0 ? h.weightInClass / coreCur : 1 / core.length;
      return { ...h, weightInClass: parseFloat((ratio * coreTotal).toFixed(6)) };
    }),
  };
}
