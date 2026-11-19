import { describe, expect, it } from "vitest";
import { enforceSleeveTargets } from "@/app/lib/sleeve-targets";
import type { PimModelData } from "@/app/lib/pim-types";
import { equitySum, group, h, stock, weightOf } from "./helpers";

const stocks = [
  stock("AAPL"),
  stock("MSFT"),
  stock("NVDA"),
  stock("XIC", { instrumentType: "etf", designation: "core" }),
  stock("VFV", { instrumentType: "etf", designation: "core" }),
  stock("GRNJ", { instrumentType: "mutual-fund", designation: "thematic" }),
];

const pinnedNvda = { weightInClass: 0.05, month: "2026-10", at: "2026-10-01T00:00:00Z" };
const targets = { core: 0.6, thematic: 0.15, alpha: 0.25, since: "2026-10-22T00:00:00Z" };

function data(withTargets = true): PimModelData {
  return {
    revision: 7,
    groups: [
      group("pim", [
        h("XIC", 0.5),
        h("VFV", 0.2),
        h("FID5982", 0.15, { bucket: "thematic" }),
        h("AAPL", 0.03),
        h("MSFT", 0.03),
        h("NVDA", 0.09, { pinned: pinnedNvda }),
        h("XBB", 1, { assetClass: "fixedIncome" }),
      ]),
      group("growth", [h("XIC", 0.5), h("GRNJ", 0.1), h("AAPL", 0.02), h("FID5982-T", 0.08)]),
    ],
    ...(withTargets ? { sleeveTargets: targets } : {}),
  };
}

describe("enforceSleeveTargets", () => {
  it("no sleeve targets → identity (same object)", () => {
    const d = data(false);
    expect(enforceSleeveTargets(d, stocks)).toBe(d);
  });

  const out = enforceSleeveTargets(data(), stocks);
  const pim = out.groups.find((g) => g.id === "pim")!.holdings;
  const growth = out.groups.find((g) => g.id === "growth")!.holdings;

  it("every group's equity class sums to 1", () => {
    for (const g of out.groups) expect(equitySum(g.holdings)).toBeCloseTo(1, 5);
  });

  it("unpinned stocks split (alpha − pinned) / count, in every model", () => {
    // (0.25 − 0.05) / 2 unpinned PIM stocks = 0.10
    expect(weightOf(pim, "AAPL")).toBeCloseTo(0.1, 6);
    expect(weightOf(pim, "MSFT")).toBeCloseTo(0.1, 6);
    expect(weightOf(growth, "AAPL")).toBeCloseTo(0.1, 6);
  });

  it("pinned holdings are skipped and hold their pinned weight", () => {
    expect(weightOf(pim, "NVDA")).toBeCloseTo(0.05, 6);
  });

  it("locked / thematic funds pass through unchanged", () => {
    expect(weightOf(pim, "FID5982")).toBe(0.15);
    expect(weightOf(growth, "GRNJ")).toBe(0.1);
    expect(weightOf(growth, "FID5982-T")).toBe(0.08);
  });

  it("Core absorbs the residual keeping its own mix", () => {
    expect(weightOf(pim, "XIC")! + weightOf(pim, "VFV")!).toBeCloseTo(0.6, 5);
    expect(weightOf(pim, "XIC")! / weightOf(pim, "VFV")!).toBeCloseTo(2.5, 3);
    expect(weightOf(growth, "XIC")).toBeCloseTo(1 - 0.1 - 0.1 - 0.08, 5);
  });

  it("non-equity holdings and other top-level fields are preserved", () => {
    expect(weightOf(pim, "XBB")).toBe(1);
    expect(out.revision).toBe(7);
    expect(out.sleeveTargets).toEqual(targets);
  });

  it("an over-full group is left exactly as it was", () => {
    const d: PimModelData = {
      sleeveTargets: targets,
      groups: [
        group("pim", [h("XIC", 0.5), h("AAPL", 0.1)]),
        group("tight", [h("XIC", 0.1), h("GRNJ", 0.95), h("AAPL", 0.05)]),
      ],
    };
    const o = enforceSleeveTargets(d, stocks);
    expect(o.groups[1]).toBe(d.groups[1]);
  });
});
