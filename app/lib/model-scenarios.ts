import type { PimAssetClass, PimHolding } from "./pim-types";

/**
 * Model scenarios — "what if we made these changes?" previews for the Models
 * tab, computed against the live model but NEVER written into it.
 *
 * DESIGN — actions, not materialised weights. A scenario stores the CHANGES
 * ("drop ARX-T", "add TD-T at 2.5%") rather than a full weight table. The base
 * model moves underneath it — a rescore, a rebalance, a new holding — and a
 * stored weight table would silently go stale and start comparing against a
 * model that no longer exists. Replaying actions against whatever the model is
 * TODAY keeps a week-old scenario honest.
 *
 * WEIGHT BASIS. Individual stocks are pinned at ~1.82% in the model's own
 * rebalance, but the actual book drifts away from that with price movement.
 * A scenario therefore starts from one of two bases:
 *   - "actual" (default) — where the position ACTUALLY sits today, per the
 *     Positioning tab. This is what you are really trading away from.
 *   - "model" — the target weights the standard rebalance would produce.
 * "Rebalance to model" is just re-running with basis "model", which is why it
 * is a basis and not a separate action.
 *
 * RESIDUAL. Weights within an asset class must sum to 1. Anything freed or
 * consumed has to land somewhere, and pretending otherwise is how a preview
 * starts lying. The policy is explicit and reported in the diagnostics.
 *
 * Nothing here touches pm:pim-models. Applying a scenario is a separate,
 * confirmed action that goes through the normal write path.
 */

export type ScenarioAction =
  | { kind: "drop"; symbol: string }
  | {
      kind: "add";
      symbol: string;
      name?: string;
      currency?: "CAD" | "USD";
      assetClass?: PimAssetClass;
      /** Target weightInClass. Omitted → the model's per-stock reference. */
      weight?: number;
    }
  /** Set an absolute weight — the per-stock override.
   *  `ofPortfolio` means `weight` is a share of the WHOLE portfolio (what the
   *  tables display and what goes into the modelling software); it is resolved
   *  against the class allocation at replay time. Without it, `weight` is a
   *  share of the holding's own asset class. */
  | { kind: "setWeight"; symbol: string; weight: number; ofPortfolio?: boolean }
  /** Reduce a position by a RELATIVE fraction (0.25 = trim a quarter away). */
  | { kind: "trim"; symbol: string; fraction: number }
  /**
   * "Trim X and buy Y with the proceeds" — the single most common change, and
   * one intent rather than two. Expressed as a pair of edits it is easy to get
   * wrong: you have to work out the freed weight by hand, and any mismatch is
   * silently absorbed by the residual policy, so the rest of the sleeve moves
   * for no reason you asked for.
   *
   * As one action the arithmetic is exact by construction — whatever leaves
   * `from` is exactly what arrives at `to`, so the class total never changes
   * and nothing else in the model is disturbed. `fraction` is a share of the
   * SOURCE position (1 = sell it all), resolved at replay time against
   * whatever the source weighs today.
   */
  | {
      kind: "fund";
      from: string;
      to: string;
      /** Share of the SOURCE position to sell (1 = all of it). Used only when
       *  `sourceTarget` is absent. */
      fraction: number;
      /**
       * The source's NEW portfolio weight — "take JBND down to 12.00%" rather
       * than "sell 14.29% of JBND". This is how the trade is actually decided,
       * and it is what the tables show, so it is what the builder collects.
       * Stored as the TARGET rather than a computed fraction so that a saved
       * scenario still means the same thing after the base model moves.
       */
      sourceTarget?: number;
      toName?: string;
      toCurrency?: "CAD" | "USD";
      /** Defaults to the source's class — proceeds stay in the same sleeve. */
      toAssetClass?: PimAssetClass;
    }
  /**
   * Send whatever a sleeve has NOT allocated to a different sleeve.
   *
   * Trimming inside a class leaves a hole, and by default the class's own
   * holdings have to fill it — the money is stuck in the sleeve it came from.
   * That is often not the intent: freeing 2% of the bond sleeve in order to
   * hold more alternatives is a perfectly ordinary decision, and it is an
   * allocation move, since class weights are always 100% of their own class.
   *
   * Resolved at replay time against whatever the shortfall turns out to be, so
   * it keeps tracking as the weights above it are edited. Works in both
   * directions: an OVER-allocated sleeve pulls the excess from the target.
   */
  | { kind: "spill"; from: PimAssetClass; to: PimAssetClass }
  | { kind: "retag"; symbol: string; designation: "alpha" | "core" };

export type WeightBasis = "actual" | "model";

/**
 * Where freed (or borrowed) weight goes.
 *   core         — Core-tagged ETFs absorb it, mirroring the live rebalance.
 *   proportional — every untouched holding in the class scales together.
 *   named        — specific symbols absorb it, split by `residualTargets`.
 */
export type ResidualPolicy = "core" | "proportional" | "named";

export type ScenarioOptions = {
  basis: WeightBasis;
  /** symbol → actual weightInClass today (Positioning tab). Required for
   *  basis "actual"; a symbol missing here falls back to the model weight. */
  actualWeights?: Record<string, number>;
  /** symbol → true when the holding is Core-tagged (residual absorbing). */
  isCore?: (symbol: string) => boolean;
  residual?: ResidualPolicy;
  /** For residual "named": the symbols that absorb, split evenly. */
  residualTargets?: string[];
  /** Per-stock reference weight used when an `add` omits one. */
  refPerStock?: number;
  /**
   * Asset-class allocations (fractions of the whole portfolio). Supplying
   * these lets a cross-class `fund` do the thing it obviously means: move
   * money BETWEEN sleeves. Without them a cross-class move can only warn,
   * because each class normalises to 100% of its own allocation.
   */
  allocations?: Partial<Record<PimAssetClass, number>>;
  /**
   * Allocations used to INTERPRET portfolio-weight targets (`sourceTarget`,
   * `setWeight` with `ofPortfolio`). Defaults to `allocations`.
   *
   * Profiles inside a group share one holdings list — `weightInClass` is
   * profile-invariant and only the class allocation differs — so a change made
   * once already applies to every profile. But a target typed as a share of
   * the PORTFOLIO is profile-specific: "take JBND to 12%" means a different
   * share of the bond sleeve under Balanced (28% bonds) than under Growth
   * (14%). Anchoring the target to the profile it was authored against makes
   * the same class-space change land in every profile, which is what
   * "translates across models" has to mean.
   */
  targetAllocations?: Partial<Record<PimAssetClass, number>>;
  /**
   * Symbols the PM has pinned. A pin is not a change — it is a CONSTRAINT: the
   * weight stays where it is and the residual has to be found somewhere else.
   * Without it, setting one weight silently drags every other holding in the
   * sleeve, which is rarely what is meant when only one line is being adjusted.
   */
  pinnedSymbols?: string[];
};

export type ScenarioDiagnostic = {
  assetClass: PimAssetClass;
  /** Class total BEFORE normalisation — how far the actions left it from 1. */
  rawTotal: number;
  /** Weight the residual policy had to move to bring the class back to 1. */
  residualApplied: number;
  absorbedBy: string[];
  warnings: string[];
};

export type ScenarioResult = {
  holdings: PimHolding[];
  diagnostics: ScenarioDiagnostic[];
  /** Allocations after any cross-class funding. Echoes the input unchanged
   *  when nothing crossed classes; undefined when none were supplied. */
  allocations?: Partial<Record<PimAssetClass, number>>;
};


const DEFAULT_REF_PER_STOCK = 0.018182;
const EPSILON = 1e-9;

const norm = (s: string) => s.trim().toUpperCase();
/** -T and .TO name the same listing; scenarios must match either form. */
const sameSymbol = (a: string, b: string) => {
  const x = norm(a).replace(/\.TO$/, "-T");
  const y = norm(b).replace(/\.TO$/, "-T");
  return x === y;
};

/**
 * Replay a scenario's actions against the CURRENT model.
 *
 * Pure: no Redis, no fetch, no mutation of the input. Every asset class is
 * renormalised to 1 and the adjustment reported, so a preview can never
 * silently present weights that do not add up.
 */
export function applyScenario(
  base: PimHolding[],
  actions: ScenarioAction[],
  opts: ScenarioOptions,
): ScenarioResult {
  const refPerStock = opts.refPerStock ?? DEFAULT_REF_PER_STOCK;
  const residual: ResidualPolicy = opts.residual ?? "core";
  const allocations: Partial<Record<PimAssetClass, number>> | undefined = opts.allocations
    ? { ...opts.allocations }
    : undefined;
  const targetAllocations = opts.targetAllocations ?? opts.allocations;

  // 1. Seed weights from the chosen basis.
  const holdings: PimHolding[] = base.map((h) => {
    if (opts.basis === "actual" && opts.actualWeights) {
      const hit = Object.entries(opts.actualWeights).find(([sym]) => sameSymbol(sym, h.symbol));
      if (hit && Number.isFinite(hit[1])) return { ...h, weightInClass: hit[1] };
    }
    return { ...h };
  });

  const warningsByClass: Record<string, string[]> = {};
  const warn = (cls: PimAssetClass, msg: string) => {
    (warningsByClass[cls] ??= []).push(msg);
  };
  // Symbols held fixed while the residual moves: everything an action touched,
  // plus anything explicitly pinned.
  const touched = new Set<string>();
  for (const p of opts.pinnedSymbols ?? []) {
    const hit = holdings.find((h) => sameSymbol(h.symbol, p));
    if (hit) touched.add(norm(hit.symbol));
  }

  // 2. Apply actions in order; later actions on the same symbol win.
  for (const a of actions) {
    const idx = "symbol" in a ? holdings.findIndex((h) => sameSymbol(h.symbol, a.symbol)) : -1;
    switch (a.kind) {
      case "fund": {
        const src = holdings.findIndex((h) => sameSymbol(h.symbol, a.from));
        if (src < 0) {
          warn("equity", `fund from ${a.from}: not in the model — ignored`);
          break;
        }
        const srcClass = holdings[src].assetClass;
        const wNow = holdings[src].weightInClass;
        let freed: number;
        if (a.sourceTarget != null) {
          // A portfolio-weight target: convert into this class's own space.
          const aSrc = targetAllocations?.[srcClass];
          if (!aSrc || aSrc <= EPSILON) {
            warn(srcClass, `${a.from}: ${srcClass} has no allocation in this profile, so the target cannot be resolved`);
            break;
          }
          freed = wNow - a.sourceTarget / aSrc;
          if (freed < -EPSILON) {
            warn(
              srcClass,
              `${a.from}: target ${(a.sourceTarget * 100).toFixed(2)}% is ABOVE its current weight — this action only trims, so it was ignored`,
            );
            break;
          }
          freed = Math.min(Math.max(freed, 0), wNow);
        } else {
          freed = wNow * Math.min(Math.max(a.fraction, 0), 1);
        }
        const f = wNow > EPSILON ? freed / wNow : 0;
        const cls: PimAssetClass = a.toAssetClass ?? srcClass;
        const crossClass = cls !== srcClass;

        // Proceeds are denominated. Selling a CAD position raises Canadian
        // dollars, and putting them into a USD name is an FX transaction with
        // a rate, a cost and a currency-exposure change — not the clean
        // like-for-like transfer the arithmetic here assumes. Flagged rather
        // than blocked: it is a legitimate trade, but it should be a decision
        // rather than a side effect of picking a ticker.
        {
          const toCcy = a.toCurrency ?? (/-T$|\.TO$/i.test(a.to) ? "CAD" : "USD");
          if (toCcy !== holdings[src].currency) {
            warn(
              cls,
              `${a.from} is ${holdings[src].currency} and ${a.to} is ${toCcy} — the proceeds change currency, so this is an FX trade. The weights below assume a straight transfer at today's rate.`,
            );
          }
        }

        if (!crossClass) {
          // Same sleeve: an exact internal transfer. Whatever leaves the
          // source arrives at the destination, the class total never moves,
          // and nothing else is disturbed.
          if (f >= 1) holdings.splice(src, 1);
          else holdings[src] = { ...holdings[src], weightInClass: holdings[src].weightInClass - freed };
          touched.add(norm(a.from));

          const dst = holdings.findIndex((h) => sameSymbol(h.symbol, a.to));
          if (dst >= 0) holdings[dst] = { ...holdings[dst], weightInClass: holdings[dst].weightInClass + freed };
          else
            holdings.push({
              name: a.toName ?? a.to,
              symbol: a.to,
              currency: a.toCurrency ?? (/-T$|\.TO$/i.test(a.to) ? "CAD" : "USD"),
              assetClass: cls,
              weightInClass: freed,
            });
          touched.add(norm(a.to));
          break;
        }

        // ── Cross-class: this is an ALLOCATION move ──────────────────────
        // Selling bonds to buy an alt takes money out of the bond sleeve and
        // puts it in the alt sleeve. Class weights alone cannot express that
        // (each class is 100% of itself), so the class ALLOCATIONS move by the
        // portfolio-level amount, and both classes are renormalised here so
        // every other holding keeps its portfolio weight exactly.
        if (!allocations) {
          warn(
            cls,
            `${a.from} → ${a.to} crosses asset classes, which needs the asset-class allocations to model — the sleeves were left unchanged`,
          );
          break;
        }
        const aSrc = allocations[srcClass] ?? 0;
        const moved = freed * aSrc; // portfolio-level money leaving the sleeve
        if (moved <= EPSILON) break;

        const aSrcNext = aSrc - moved;
        const aDstNext = (allocations[cls] ?? 0) + moved;
        allocations[srcClass] = Math.max(0, aSrcNext);
        allocations[cls] = aDstNext;

        // Source sleeve: drop the freed weight, then rescale the whole class
        // (the trimmed position included) so it is 100% of its SMALLER
        // allocation. Every survivor's portfolio weight is unchanged.
        if (f >= 1) holdings.splice(src, 1);
        else holdings[src] = { ...holdings[src], weightInClass: holdings[src].weightInClass - freed };
        const srcScale = 1 - freed;
        if (srcScale > EPSILON) {
          for (let i = 0; i < holdings.length; i++) {
            if (holdings[i].assetClass === srcClass)
              holdings[i] = { ...holdings[i], weightInClass: holdings[i].weightInClass / srcScale };
          }
        }

        // Destination sleeve: existing holdings keep their portfolio weight
        // (scaled by old/new allocation), and the buy enters at exactly the
        // money that moved.
        const dstScale = aDstNext > EPSILON ? (aDstNext - moved) / aDstNext : 0;
        for (let i = 0; i < holdings.length; i++) {
          if (holdings[i].assetClass === cls)
            holdings[i] = { ...holdings[i], weightInClass: holdings[i].weightInClass * dstScale };
        }
        const newWeight = aDstNext > EPSILON ? moved / aDstNext : 0;
        const dst = holdings.findIndex((h) => sameSymbol(h.symbol, a.to));
        if (dst >= 0) holdings[dst] = { ...holdings[dst], weightInClass: holdings[dst].weightInClass + newWeight };
        else
          holdings.push({
            name: a.toName ?? a.to,
            symbol: a.to,
            currency: a.toCurrency ?? (/-T$|\.TO$/i.test(a.to) ? "CAD" : "USD"),
            assetClass: cls,
            weightInClass: newWeight,
          });
        // Both sleeves already sum to 1 — mark everything touched so the
        // residual pass cannot "correct" a correct answer.
        for (const h of holdings) {
          if (h.assetClass === srcClass || h.assetClass === cls) touched.add(norm(h.symbol));
        }
        break;
      }
      case "add": {
        if (idx >= 0) {
          warn(holdings[idx].assetClass, `add ${a.symbol}: already held — treated as a weight change`);
          holdings[idx] = { ...holdings[idx], weightInClass: a.weight ?? refPerStock };
          touched.add(norm(holdings[idx].symbol));
          break;
        }
        const cls: PimAssetClass = a.assetClass ?? "equity";
        holdings.push({
          name: a.name ?? a.symbol,
          symbol: a.symbol,
          currency: a.currency ?? (/-T$|\.TO$/i.test(a.symbol) ? "CAD" : "USD"),
          assetClass: cls,
          weightInClass: a.weight ?? refPerStock,
        });
        touched.add(norm(a.symbol));
        break;
      }
      case "setWeight": {
        if (idx < 0) {
          warn("equity", `setWeight ${a.symbol}: not in the model — ignored`);
          break;
        }
        if (a.weight < 0) {
          warn(holdings[idx].assetClass, `setWeight ${a.symbol}: negative weight rejected`);
          break;
        }
        let w = a.weight;
        if (a.ofPortfolio) {
          const aCls = targetAllocations?.[holdings[idx].assetClass];
          if (!aCls || aCls <= EPSILON) {
            warn(holdings[idx].assetClass, `setWeight ${a.symbol}: no allocation to resolve a portfolio weight against`);
            break;
          }
          w = a.weight / aCls;
        }
        holdings[idx] = { ...holdings[idx], weightInClass: w };
        touched.add(norm(holdings[idx].symbol));
        break;
      }
      case "trim": {
        if (idx < 0) {
          warn("equity", `trim ${a.symbol}: not in the model — ignored`);
          break;
        }
        const f = Math.min(Math.max(a.fraction, 0), 1);
        holdings[idx] = { ...holdings[idx], weightInClass: holdings[idx].weightInClass * (1 - f) };
        touched.add(norm(holdings[idx].symbol));
        break;
      }
      case "retag":
        // Designation lives on pm:stocks, not the holding; recorded so the
        // caller can apply it and so the residual pool reflects the intent.
        touched.add(norm(a.symbol));
        break;
    }
  }

  // 2b. Spillovers — after every other action, so the shortfall being moved is
  // the one the finished edits actually leave behind.
  for (const a of actions) {
    if (a.kind !== "spill") continue;
    if (!allocations) {
      warn(a.from, `spill ${a.from} → ${a.to}: needs asset-class allocations`);
      continue;
    }
    const inClass = holdings.filter((h) => h.assetClass === a.from);
    const rawTotal = inClass.reduce((t, h) => t + h.weightInClass, 0);
    const gap = 1 - rawTotal; // > 0 = under-allocated, money to send away
    if (Math.abs(gap) <= EPSILON || rawTotal <= EPSILON) continue;

    const aFrom = allocations[a.from] ?? 0;
    const moved = gap * aFrom; // portfolio-level money changing sleeve
    const aToNext = (allocations[a.to] ?? 0) + moved;
    if (aToNext < 0) {
      warn(a.to, `spill ${a.from} → ${a.to}: ${a.to} cannot give up ${(-moved * 100).toFixed(2)}%`);
      continue;
    }
    allocations[a.from] = Math.max(0, aFrom - moved);
    allocations[a.to] = aToNext;

    // The source sleeve becomes 100% of its now-smaller allocation, which
    // leaves every holding in it at exactly the portfolio weight it already
    // had. The destination's holdings are untouched, so its residual policy
    // spreads the arriving money across them — or reports it as still to
    // place if the sleeve is empty.
    for (let i = 0; i < holdings.length; i++) {
      if (holdings[i].assetClass === a.from)
        holdings[i] = { ...holdings[i], weightInClass: holdings[i].weightInClass / rawTotal };
    }
  }

  // 3. Renormalise each asset class back to 1 under the residual policy.
  const diagnostics: ScenarioDiagnostic[] = [];
  const classes = [...new Set(holdings.map((h) => h.assetClass))];
  for (const cls of classes) {
    const inClass = holdings.filter((h) => h.assetClass === cls);
    const rawTotal = inClass.reduce((s, h) => s + h.weightInClass, 0);
    const gap = 1 - rawTotal;
    const warnings = [...(warningsByClass[cls] ?? [])];
    let absorbedBy: string[] = [];

    if (Math.abs(gap) > EPSILON) {
      // Candidates: never the holdings the scenario explicitly set, or the
      // adjustment would silently undo the instruction.
      let pool = inClass.filter((h) => !touched.has(norm(h.symbol)));

      // Freed CAD should land in CAD names and freed USD in USD names —
      // otherwise a trim quietly shifts the sleeve's currency mix, which is a
      // separate decision from the one being made. Same rule the live
      // Buy/Sell redistribution already follows. Falls back to the full pool
      // when the sleeve has no same-currency absorber, since a class that
      // cannot balance is worse than one whose mix moved.
      const touchedCcy = new Set(
        inClass.filter((h) => touched.has(norm(h.symbol))).map((h) => h.currency),
      );
      if (touchedCcy.size === 1) {
        const [ccy] = [...touchedCcy];
        const sameCcy = pool.filter((h) => h.currency === ccy);
        if (sameCcy.length > 0) pool = sameCcy;
        else if (pool.length > 0)
          warnings.push(
            `${cls}: no ${ccy} holding available to absorb the freed weight — it went to the other currency, so the sleeve's CAD/USD mix has moved.`,
          );
      }
      if (residual === "core" && opts.isCore) {
        const coreOnly = pool.filter((h) => opts.isCore!(h.symbol));
        // Fixed income and alternatives have no Core-tagged ETFs — that tag
        // only exists on the equity sleeve. Giving up there left the class
        // unnormalised and the table unusable, so fall back to spreading it
        // across the sleeve and say which rule actually applied.
        if (coreOnly.length > 0) pool = coreOnly;
        else if (pool.length > 0)
          warnings.push(`${cls}: no Core holding to absorb — spread across the sleeve instead`);
      }
      else if (residual === "named") {
        const targets = opts.residualTargets ?? [];
        pool = inClass.filter((h) => targets.some((t) => sameSymbol(t, h.symbol)));
        // A target that isn't in the model at all is almost certainly a typo,
        // and silently absorbing into the remaining names would hide it.
        for (const t of targets) {
          if (!holdings.some((h) => sameSymbol(h.symbol, t))) {
            warnings.push(`${t} is not in the model — it cannot absorb anything`);
          }
        }
      }

      // Named targets split the freed weight EVENLY — "sell TOU, split the
      // proceeds between CLS and CSU" means half each, not in proportion to
      // whatever those two already happened to weigh. The other policies stay
      // proportional, which is what "spread it back over the sleeve" means.
      const evenSplit = residual === "named";
      const poolTotal = pool.reduce((s, h) => s + h.weightInClass, 0);
      if (pool.length === 0 || (!evenSplit && poolTotal <= EPSILON)) {
        // Nothing can absorb it — say so rather than fabricating a spread.
        warnings.push(
          `${cls}: nothing left to absorb ${(gap * 100).toFixed(2)}% — every holding is either pinned or explicitly set, so the sleeve is left at ${(rawTotal * 100).toFixed(2)}%. Unpin one to let it take up the slack.`,
        );
      } else {
        for (const h of pool) {
          // An even split also lets a zero-weight target absorb, which a
          // proportional share cannot.
          const share = evenSplit ? 1 / pool.length : h.weightInClass / poolTotal;
          const target = holdings.find((x) => x.symbol === h.symbol && x.assetClass === cls);
          if (target) target.weightInClass = Math.max(0, target.weightInClass + gap * share);
        }
        absorbedBy = pool.map((h) => h.symbol);
      }
    }

    diagnostics.push({
      assetClass: cls,
      rawTotal,
      residualApplied: absorbedBy.length ? gap : 0,
      absorbedBy,
      warnings,
    });
  }

  return { holdings, diagnostics, allocations };
}

export type WeightDelta = {
  symbol: string;
  name: string;
  assetClass: PimAssetClass;
  from: number | null; // null = not present on that side
  to: number | null;
  delta: number;
};

/** Compare two holding sets — scenario vs current, or scenario vs scenario. */
export function diffHoldings(a: PimHolding[], b: PimHolding[]): WeightDelta[] {
  const keys = new Set([...a, ...b].map((h) => norm(h.symbol).replace(/\.TO$/, "-T")));
  const find = (set: PimHolding[], key: string) => set.find((h) => sameSymbol(h.symbol, key));
  const out: WeightDelta[] = [];
  for (const key of keys) {
    const ha = find(a, key);
    const hb = find(b, key);
    const from = ha ? ha.weightInClass : null;
    const to = hb ? hb.weightInClass : null;
    const delta = (to ?? 0) - (from ?? 0);
    if (Math.abs(delta) <= EPSILON && from != null && to != null) continue; // unchanged
    out.push({
      symbol: (hb ?? ha)!.symbol,
      name: (hb ?? ha)!.name,
      assetClass: (hb ?? ha)!.assetClass,
      from,
      to,
      delta,
    });
  }
  // Biggest moves first; additions and removals surface at the top.
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
