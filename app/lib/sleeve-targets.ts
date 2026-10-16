/* ─── Three-bucket equity model: Core / Thematic / Alpha ───
 *
 * Since the Oct 2026 restructure the PIM equity class is three buckets:
 *   Core      index ETFs (designation "core") — absorb the residual.
 *   Thematic  thematic / specialty funds (designation "thematic", or any other
 *             non-Core fund) — each held at its set weight.
 *   Alpha     individual stocks only.
 *
 * The targets live on pm:pim-models (`sleeveTargets`), written by a Stage
 * changes apply. While they are present, every model write from the client
 * (Buy/Sell, add/remove, eligibility toggles) runs enforceSleeveTargets():
 * the Alpha bucket RE-SPLITS — each unpinned stock is
 * (alpha − PIM's pinned stocks) / PIM's unpinned stock count, in every model
 * (PIM sets, the others derive) — Thematic and pinned holdings pass through,
 * and Core absorbs whatever is left, keeping its own mix.
 *
 * No targets → identity, so nothing changes until the first apply.
 * Pure, client- and server-safe. */

import type { EquityBucket, PimHolding, PimModelData, PimModelGroup, SleeveTargets } from "./pim-types";
import { sameSymbol } from "./model-staging";

export type BucketStock = { ticker: string; instrumentType?: string; designation?: "core" | "alpha" | "thematic" };

const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);

/** Which bucket a holding is in. pm:stocks record first: a stock is Alpha,
 *  "core" is Core, any other fund is Thematic. No record: the legacy lock list
 *  is Thematic, anything else Core (rebalanceStockWeights' no-record rule). */
export function bucketOf(symbol: string, stocks: BucketStock[]): EquityBucket {
  const rec = stocks.find((s) => sameSymbol(s.ticker, symbol));
  if (rec) {
    if (!rec.instrumentType || rec.instrumentType === "stock") return "alpha";
    return rec.designation === "core" ? "core" : "thematic";
  }
  return LEGACY_LOCKED.has(symbol.toUpperCase()) ? "thematic" : "core";
}

export const BUCKET_LABELS: Record<EquityBucket, string> = { core: "Core", thematic: "Thematic", alpha: "Alpha" };

/** Bucket totals of one group's equity class. */
export function bucketTotals(holdings: PimHolding[], bucket: (symbol: string) => EquityBucket): Record<EquityBucket, number> {
  const out: Record<EquityBucket, number> = { core: 0, thematic: 0, alpha: 0 };
  for (const h of holdings) if (h.assetClass === "equity") out[bucket(h.symbol)] += h.weightInClass;
  return out;
}

const isPinned = (h: PimHolding) => h.pinned != null && Number.isFinite(h.pinned.weightInClass);

/** The per-stock weight every model uses, derived from PIM. Null when PIM has
 *  no unpinned stock to size. */
export function perStockFromPim(pim: PimModelGroup | undefined, targets: SleeveTargets, stocks: BucketStock[]): number | null {
  if (!pim) return null;
  const eqStocks = pim.holdings.filter((h) => h.assetClass === "equity" && bucketOf(h.symbol, stocks) === "alpha");
  const pinned = eqStocks.filter(isPinned).reduce((a, h) => a + h.pinned!.weightInClass, 0);
  const free = eqStocks.filter((h) => !isPinned(h)).length;
  if (free === 0) return null;
  return Math.max(0, (targets.alpha - pinned) / free);
}

/** Re-split one group's equity to the targets. Returns the SAME array when
 *  nothing moves (so callers can cheaply detect no-ops). */
export function enforceGroup(group: PimModelGroup, perStock: number, stocks: BucketStock[]): PimHolding[] {
  const eq = group.holdings.filter((h) => h.assetClass === "equity");
  if (eq.length === 0) return group.holdings;
  const b = (h: PimHolding) => bucketOf(h.symbol, stocks);
  const sized = new Map<PimHolding, number>();
  let nonCore = 0;
  for (const h of eq) {
    if (b(h) === "core") continue;
    const w = b(h) === "alpha" && !isPinned(h) ? perStock : isPinned(h) ? h.pinned!.weightInClass : h.weightInClass;
    sized.set(h, w);
    nonCore += w;
  }
  const core = eq.filter((h) => b(h) === "core");
  const coreCur = core.reduce((a, h) => a + h.weightInClass, 0);
  const residual = 1 - nonCore;
  // Nothing to absorb into, or over-full: leave the group exactly as it was.
  if (core.length === 0 || residual < 0) return group.holdings;
  for (const h of core) sized.set(h, coreCur > 0 ? (h.weightInClass / coreCur) * residual : residual / core.length);
  let changed = false;
  const next = group.holdings.map((h) => {
    const w = sized.get(h);
    if (w == null) return h;
    const r = parseFloat(w.toFixed(6));
    if (Math.abs(r - h.weightInClass) < 2e-6) return h; // rounding noise — leave it
    changed = true;
    return { ...h, weightInClass: r };
  });
  return changed ? next : group.holdings;
}

/** Apply the bucket rule to every group. Identity without targets. */
export function enforceSleeveTargets(data: PimModelData, stocks: BucketStock[]): PimModelData {
  const t = data.sleeveTargets;
  if (!t) return data;
  const perStock = perStockFromPim(data.groups.find((g) => g.id === "pim"), t, stocks);
  if (perStock == null) return data;
  let changed = false;
  const groups = data.groups.map((g) => {
    const holdings = enforceGroup(g, perStock, stocks);
    if (holdings === g.holdings) return g;
    changed = true;
    return { ...g, holdings };
  });
  return changed ? { ...data, groups } : data;
}
