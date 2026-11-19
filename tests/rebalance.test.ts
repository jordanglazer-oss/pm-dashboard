import { describe, expect, it } from "vitest";
import { rebalanceHoldings, LEGACY_LOCKED_EQUITY_SYMBOLS } from "@/app/lib/rebalance";
import { equitySum, group, h, stock, weightOf } from "./helpers";

const REF = 0.018182;

// PIM baseline: two Core ETFs in a 3:1 seed ratio + one seed stock.
const baseline = [
  group("pim", [h("XIC", 0.6), h("VFV", 0.2), h("AAPL", REF), h("FID5982", 0.1)]),
];

const stocks = [
  stock("AAPL"),
  stock("MSFT"),
  stock("NVDA"),
  stock("XIC", { instrumentType: "etf", designation: "core" }),
  stock("VFV", { instrumentType: "etf", designation: "core" }),
  stock("GRNJ", { instrumentType: "mutual-fund", designation: "thematic" }),
  // FID5982 deliberately has NO pm:stocks record → legacy lock list applies.
];

const holdings = [
  h("XIC", 0.3),
  h("VFV", 0.3),
  h("AAPL", 0.05),
  h("MSFT", 0.05),
  h("NVDA", 0.05, { pinned: { weightInClass: 0.04, month: "2026-10", at: "2026-10-01T00:00:00Z" } }),
  h("FID5982", 0.12),
  h("GRNJ", 0.07),
  h("XBB", 0.6, { assetClass: "fixedIncome" }),
  h("ZAG", 0.4, { assetClass: "fixedIncome" }),
];

describe("rebalanceHoldings (StockContext.rebalanceStockWeights)", () => {
  const out = rebalanceHoldings(holdings, { stocks, pimBaseline: baseline, useSeedRatios: true });

  it("equity class sums to 1", () => {
    expect(equitySum(out)).toBeCloseTo(1, 5);
  });

  it("locked specialty funds pass through unchanged", () => {
    expect(weightOf(out, "FID5982")).toBe(0.12);
    expect(weightOf(out, "GRNJ")).toBe(0.07);
  });

  it("legacy lock list holds FID5982, FID5982-T and GRNJ", () => {
    expect([...LEGACY_LOCKED_EQUITY_SYMBOLS].sort()).toEqual(["FID5982", "FID5982-T", "GRNJ"]);
    const withT = rebalanceHoldings([h("FID5982-T", 0.11), h("XIC", 0.89)], { stocks: [], pimBaseline: [], useSeedRatios: true });
    expect(weightOf(withT, "FID5982-T")).toBe(0.11);
    expect(weightOf(withT, "XIC")).toBeCloseTo(0.89, 6);
  });

  it("unpinned stocks are set to the fixed per-stock weight", () => {
    expect(weightOf(out, "AAPL")).toBe(REF);
    expect(weightOf(out, "MSFT")).toBe(REF);
  });

  it("a pinned stock is skipped by the rule and holds its pinned weight", () => {
    expect(weightOf(out, "NVDA")).toBe(0.04);
  });

  it("Core absorbs the residual in seed ratios", () => {
    const residual = 1 - 2 * REF - 0.04 - 0.12 - 0.07;
    expect(weightOf(out, "XIC")! + weightOf(out, "VFV")!).toBeCloseTo(residual, 5);
    expect(weightOf(out, "XIC")! / weightOf(out, "VFV")!).toBeCloseTo(3, 4);
  });

  it("with sleeve targets present Core keeps its own current mix", () => {
    const o = rebalanceHoldings(holdings, { stocks, pimBaseline: baseline, useSeedRatios: false });
    expect(equitySum(o)).toBeCloseTo(1, 5);
    expect(weightOf(o, "XIC")! / weightOf(o, "VFV")!).toBeCloseTo(1, 4);
  });

  it("non-equity holdings are untouched", () => {
    expect(weightOf(out, "XBB")).toBe(0.6);
    expect(weightOf(out, "ZAG")).toBe(0.4);
  });

  it("adding a stock moves Core, never the other stocks", () => {
    const plus = rebalanceHoldings([...holdings, h("SHOP", 0)], {
      stocks,
      pimBaseline: baseline,
      extraStock: stock("SHOP"),
      useSeedRatios: true,
    });
    expect(equitySum(plus)).toBeCloseTo(1, 5);
    expect(weightOf(plus, "SHOP")).toBe(REF);
    expect(weightOf(plus, "AAPL")).toBe(REF);
    expect(weightOf(plus, "FID5982")).toBe(0.12);
    const coreBefore = weightOf(out, "XIC")! + weightOf(out, "VFV")!;
    const coreAfter = weightOf(plus, "XIC")! + weightOf(plus, "VFV")!;
    expect(coreBefore - coreAfter).toBeCloseTo(REF, 5);
  });
});
