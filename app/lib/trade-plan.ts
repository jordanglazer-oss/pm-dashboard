import type { PimModelData, PimPortfolioPositions } from "./pim-types";

/**
 * Trade unit planning — what a Buy/Sell will actually do, computed BEFORE it
 * runs so it can be read and checked rather than hoped for.
 *
 * WHY. A switch is executed as one button press across many model groups, and
 * the unit arithmetic happens deep inside that handler. When it silently did
 * nothing — a group with no sold position produces no bought position, and
 * says nothing — the result was a holding present in the model with no shares
 * in the book. That name then contributes NOTHING to performance, and the only
 * way to notice was to go looking. It has happened more than once.
 *
 * This module answers "how many units, in which group and profile, and where
 * will nothing happen?" from the same inputs the executor uses, so the answer
 * can be shown up front and compared against the result afterwards.
 *
 * Pure: no Redis, no fetch, no mutation. Deliberately independent of the
 * executor so it is a genuine second opinion rather than an echo of the same
 * code path.
 */

export type TradePlanRow = {
  groupId: string;
  groupName: string;
  profile: string;
  /** Units of the sold ticker currently held in this group+profile. */
  heldUnits: number;
  /** Units that will be sold (heldUnits × sellPercent). */
  unitsToSell: number;
  proceedsCad: number;
  /** Units of the bought ticker this trade will create. */
  unitsToBuy: number;
  /** Units of the bought ticker already held (a merge rather than a new buy). */
  existingBuyUnits: number;
  /** Non-fatal notes: why a row produces nothing, or needs attention. */
  note?: string;
};

export type TradePlan = {
  rows: TradePlanRow[];
  /** Groups whose MODEL will change but where no units can be created. */
  modelOnlyGroups: string[];
  totalUnitsToBuy: number;
  totalProceedsCad: number;
  warnings: string[];
};

const eq = (a: string, b: string) =>
  a.toUpperCase() === b.toUpperCase() ||
  a.toUpperCase().replace("-T", ".TO") === b.toUpperCase().replace("-T", ".TO");

const currencyOf = (sym: string): "CAD" | "USD" =>
  sym.endsWith(".U") ? "USD" : sym.endsWith("-T") || sym.endsWith(".TO") ? "CAD" : "USD";

/**
 * Plan the unit-level effect of one trade.
 *
 * Mirrors the executor's arithmetic:
 *   unitsToSell = held × (sellPercent / 100)
 *   proceedsCad = unitsToSell × sellPrice × sellFx
 *   unitsToBuy  = proceedsCad / (buyPrice × buyFx)
 *
 * A row with held units of zero is reported explicitly rather than dropped —
 * "nothing will happen here" is the finding, not an absence of one.
 */
export function planTrade(args: {
  sellSymbol: string;
  buySymbol: string;
  sellPrice: number;
  buyPrice: number;
  sellPercent: number;
  usdCadRate: number;
  positions: PimPortfolioPositions[];
  models: PimModelData;
  /** Groups the model swap will touch (from the eligibility selection). */
  affectedGroupIds?: string[];
}): TradePlan {
  const {
    sellSymbol, buySymbol, sellPrice, buyPrice, sellPercent,
    usdCadRate, positions, models, affectedGroupIds,
  } = args;

  const rows: TradePlanRow[] = [];
  const warnings: string[] = [];
  const groupName = (id: string) => models.groups.find((g) => g.id === id)?.name ?? id;

  const sellFx = currencyOf(sellSymbol) === "USD" ? usdCadRate : 1;
  const buyFx = currencyOf(buySymbol) === "USD" ? usdCadRate : 1;
  const buyCostBasisCad = buyPrice * buyFx;
  const fraction = Math.min(Math.max(sellPercent, 0), 100) / 100;

  const touched = affectedGroupIds ? new Set(affectedGroupIds) : null;

  for (const pp of positions) {
    if (touched && !touched.has(pp.groupId)) continue;
    const sold = sellSymbol ? pp.positions.find((p) => eq(p.symbol, sellSymbol)) : undefined;
    const existingBuy = buySymbol ? pp.positions.find((p) => eq(p.symbol, buySymbol)) : undefined;
    const heldUnits = sold?.units ?? 0;
    const unitsToSell = heldUnits * fraction;
    const proceedsCad = unitsToSell * sellPrice * sellFx;
    const unitsToBuy = buyCostBasisCad > 0 ? proceedsCad / buyCostBasisCad : 0;

    let note: string | undefined;
    if (sellSymbol && heldUnits <= 0) {
      note = `no ${sellSymbol} position here — this trade will create NO ${buySymbol} units`;
    } else if (buySymbol && buyCostBasisCad <= 0) {
      note = "buy price missing — units cannot be computed";
    } else if (existingBuy) {
      note = `merging into an existing ${existingBuy.units.toFixed(2)}-unit position`;
    }

    rows.push({
      groupId: pp.groupId,
      groupName: groupName(pp.groupId),
      profile: pp.profile,
      heldUnits,
      unitsToSell,
      proceedsCad,
      unitsToBuy,
      existingBuyUnits: existingBuy?.units ?? 0,
      note,
    });
  }

  // Groups whose MODEL changes but which have no position record at all. This
  // is normal for the groups that aren't position-tracked, but it is exactly
  // the case that silently produced "holding in the model, no shares in the
  // book", so it is stated rather than assumed understood.
  const groupsWithPositions = new Set(positions.map((p) => p.groupId));
  const modelOnlyGroups = (affectedGroupIds ?? models.groups.map((g) => g.id))
    .filter((id) => !groupsWithPositions.has(id))
    .map(groupName);

  const buyingRows = rows.filter((r) => r.unitsToBuy > 0);
  if (buySymbol && buyingRows.length === 0) {
    warnings.push(
      `No ${buySymbol} units will be created anywhere. ${
        sellSymbol
          ? `Nothing holds ${sellSymbol} in a position record, so there are no proceeds to size the buy from.`
          : "A buy with no sell side does not size a position — enter units via Edit Positions."
      }`,
    );
  }
  if (sellPrice <= 0 && sellSymbol) warnings.push("Sell price missing — proceeds cannot be computed.");
  if (buyPrice <= 0 && buySymbol) warnings.push("Buy price missing — units cannot be computed.");

  return {
    rows,
    modelOnlyGroups,
    totalUnitsToBuy: rows.reduce((s, r) => s + r.unitsToBuy, 0),
    totalProceedsCad: rows.reduce((s, r) => s + r.proceedsCad, 0),
    warnings,
  };
}
