/* ─── Weight decisions: the monthly meeting's target-weight decisions ───
 *
 * Three things share the word "weight" and are kept apart:
 *   TARGET  what the model says a name should be (pm:pim-models weightInClass)
 *           — changed only by a decision (here) or a Buy/Sell.
 *   LIVE    what prices have done since the last trades — observed, never decided.
 *   TRADES  the action that moves live toward target — logged in Positioning.
 * Performance is computed daily from targets already, so it needs nothing here.
 *
 * At the first-Monday meeting each held Alpha stock or Thematic fund gets one of:
 *   keep   the drift is noise; trade back to the current target
 *   adopt  let it ride; the live weight becomes the new target (no trade)
 *   set    an explicit trim / add
 * The record lives in pm:weight-decisions, one entry per month, PIM only
 * (other models inherit PIM's targets; a name a model does not hold leaves that
 * weight in its Core, as today).
 *
 * Rule: a change absorbs WITHIN THE SAME BUCKET of the three-bucket model
 * (app/lib/sleeve-targets — Core / Thematic / Alpha). A 0.5% trim from one
 * Alpha stock must be reallocated to other Alpha stocks, a Thematic change to
 * other Thematic funds, before the month can be committed; Core is never
 * decided (it absorbs residual by construction). (Replaced the Thesis/Tactical
 * same-sleeve rule of 2026-09-23 when those tags retired.)
 * Single STOCKS are capped at 10% of the whole portfolio (funds are not).
 *
 * All weights stored here are weightInClass (fraction of the equity class) so
 * the record is profile-independent; the page edits in % of a chosen profile. */

import type { PimModelGroup, PimProfileType, SleeveTargets } from "./pim-types";
import { canonicalTicker } from "./ticker";
import { isFund } from "./sleeves";
import { bucketOf, perStockFromPim } from "./sleeve-targets";
import { substituteSource } from "./model-staging";

export const WEIGHT_DECISIONS_KEY = "pm:weight-decisions";
/** Commit writes pm:pim-models (enabled 2026-09-24 with typed confirmation,
 *  server-side reconciliation, a version snapshot before every write, and a
 *  revision guard against stale tabs). */
export const WEIGHT_COMMIT_ENABLED = true;
/** The pre-three-bucket per-stock rule weight. A "release" returns a pinned
 *  stock to this only when the model has no bucket targets (see releaseWeight). */
export const REF_PER_STOCK = 0.018182;

/** A single STOCK is capped at this share of the WHOLE portfolio (funds are not). */
export const MAX_STOCK_PORTFOLIO_WEIGHT = 0.1;

/** The model's most equity-heavy real profile: weightInClass is shared by every
 *  profile, so the stock cap binds there (in-class cap = 10% ÷ this). */
export function maxEquityAllocation(group: PimModelGroup): number {
  let max = 0;
  for (const [k, p] of Object.entries(group.profiles)) {
    if (k === "alpha" || k === "core" || k === "thematic" || !p) continue;
    if (p.equity > max) max = p.equity;
  }
  return max > 0 ? max : 1;
}

/** Weight a released stock returns to. With bucket targets: the Alpha per-stock
 *  share AFTER this month's pins / releases (what the re-split will give it);
 *  without: the old fixed rule weight. */
export function releaseWeight(
  pim: PimModelGroup,
  stocks: StockLite[],
  decisions: Record<string, WeightDecision>,
  targets?: SleeveTargets,
): number {
  if (!targets) return REF_PER_STOCK;
  const at = new Date().toISOString();
  const after: PimModelGroup = {
    ...pim,
    holdings: pim.holdings.map((h) => {
      const d = decisions[h.symbol];
      if (h.assetClass !== "equity" || !d || d.action === "keep") return h;
      if (d.action === "release") { const { pinned: _p, ...rest } = h; void _p; return rest; }
      if (d.targetInClass == null) return h;
      return { ...h, pinned: { weightInClass: d.targetInClass, month: monthKey(), at } };
    }),
  };
  return perStockFromPim(after, targets, stocks) ?? REF_PER_STOCK;
}

/**
 *   keep     the drift is noise; the current target stands
 *   adopt    the live weight becomes the target — PINNED
 *   set      an explicit target — PINNED
 *   release  drop the pin; the name returns to the rule weight (nets like a set)
 * A pin means the rebalance rule skips the name; it holds the committed weight
 * through later trades until released or decided again (Jordan, 2026-09-24).
 */
export type DecisionAction = "keep" | "adopt" | "set" | "release";
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

type StockLite = { ticker: string; bucket?: string; instrumentType?: string; designation?: "core" | "alpha" | "thematic"; name?: string; sector?: string };

/** The bucket a decision on this holding nets within; null = Core (never decided). */
export type DecisionBucket = "alpha" | "thematic";
export function decisionBucketOf(symbol: string, stocks: StockLite[]): DecisionBucket | null {
  const b = bucketOf(symbol, stocks);
  return b === "core" ? null : b;
}

export type BucketNet = { bucket: DecisionBucket; delta: number; ok: boolean };
export type Reconciliation = {
  nets: BucketNet[];
  capBreaches: Array<{ symbol: string; targetInClass: number; capInClass: number }>;
  /** Core holdings that carry a decision — Core is not decidable. */
  coreDecided: string[];
  /** Committable: every bucket nets to zero, no cap breached, no Core decided. */
  ok: boolean;
};

export const NET_TOLERANCE = 0.00005; // 0.005% of the equity class

/** Check a month's decisions against the group they would be applied to. */
export function reconcile(group: PimModelGroup, stocks: StockLite[], decisions: Record<string, WeightDecision>, releaseW: number = REF_PER_STOCK): Reconciliation {
  const deltas: Record<DecisionBucket, number> = { alpha: 0, thematic: 0 };
  const capInClass = MAX_STOCK_PORTFOLIO_WEIGHT / maxEquityAllocation(group);
  const capBreaches: Reconciliation["capBreaches"] = [];
  const coreDecided: string[] = [];
  for (const h of group.holdings) {
    if (h.assetClass !== "equity") continue;
    const d = decisions[h.symbol];
    if (!d || d.action === "keep") continue;
    const target = d.action === "release" ? releaseW : d.targetInClass;
    if (target == null) continue;
    const b = decisionBucketOf(h.symbol, stocks);
    if (!b) { coreDecided.push(h.symbol); continue; }
    deltas[b] += target - h.weightInClass;
    const s = stocks.find((x) => canonicalTicker(x.ticker) === canonicalTicker(h.symbol));
    if (b === "alpha" && !(s && isFund(s)) && target > capInClass + 1e-9) capBreaches.push({ symbol: h.symbol, targetInClass: target, capInClass });
  }
  const nets: BucketNet[] = (["alpha", "thematic"] as DecisionBucket[]).map((bucket) => ({ bucket, delta: deltas[bucket], ok: Math.abs(deltas[bucket]) <= NET_TOLERANCE }));
  return { nets, capBreaches, coreDecided, ok: nets.every((n) => n.ok) && capBreaches.length === 0 && coreDecided.length === 0 };
}

/** The group with a month's decisions applied (pure — for the diff preview and,
 *  once enabled, the commit). Only decided symbols move; Core is untouched
 *  because decisions net to zero inside each bucket. */
export function applyDecisions(group: PimModelGroup, decisions: Record<string, WeightDecision>, month?: string, releaseW: number = REF_PER_STOCK): PimModelGroup {
  const at = new Date().toISOString();
  return {
    ...group,
    holdings: group.holdings.map((h) => {
      const d = decisions[h.symbol];
      if (h.assetClass !== "equity" || !d || d.action === "keep") return h;
      if (d.action === "release") {
        const { pinned: _drop, ...rest } = h;
        void _drop;
        return { ...rest, weightInClass: parseFloat(releaseW.toFixed(6)) };
      }
      if (d.targetInClass == null) return h;
      const w = parseFloat(d.targetInClass.toFixed(6));
      return { ...h, weightInClass: w, pinned: { weightInClass: w, month: month ?? monthKey(), at } };
    }),
  };
}

/** Other models inherit PIM's decided targets for the names they hold; the
 *  difference (a trimmed name held here, an added name not eligible) lands in
 *  that model's Core in its current proportions — today's rule. */
export function inheritDecisions(pim: PimModelGroup, other: PimModelGroup, stocks: StockLite[], decisions: Record<string, WeightDecision>, releaseW: number = REF_PER_STOCK): PimModelGroup {
  const decided = new Map<string, { w: number; pin: boolean }>();
  for (const h of pim.holdings) {
    const d = decisions[h.symbol];
    if (h.assetClass !== "equity" || !d || d.action === "keep") continue;
    if (d.action === "release") decided.set(canonicalTicker(h.symbol), { w: releaseW, pin: false });
    else if (d.targetInClass != null) decided.set(canonicalTicker(h.symbol), { w: d.targetInClass, pin: true });
  }
  const at = new Date().toISOString();
  const equity = other.holdings.filter((h) => h.assetClass === "equity");
  // Same bucket rule as the rebalance (sleeve-targets.bucketOf).
  const core = equity.filter((h) => bucketOf(h.symbol, stocks) === "core");
  const coreSet = new Set(core.map((h) => h.symbol));
  let nonCore = 0;
  const next = other.holdings.map((h) => {
    if (h.assetClass !== "equity" || coreSet.has(h.symbol)) return h;
    // A per-model substitute (FINN in Non-Res) follows the decision on the
    // security it stands in for (FID5982).
    const t = decided.get(canonicalTicker(h.symbol)) ?? decided.get(canonicalTicker(substituteSource(h.symbol) ?? h.symbol));
    if (!t) { nonCore += h.weightInClass; return h; }
    const w = parseFloat(t.w.toFixed(6));
    nonCore += w;
    if (!t.pin) { const { pinned: _drop, ...rest } = h; void _drop; return { ...rest, weightInClass: w }; }
    return { ...h, weightInClass: w, pinned: { weightInClass: w, month: monthKey(), at } };
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
