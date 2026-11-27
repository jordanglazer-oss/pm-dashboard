import { describe, expect, it } from "vitest";
import { auditFund, usableSectors, wrapperHolding } from "@/app/lib/fund-data-sanity";

const xuh = { topHoldings: [{ symbol: "XUU.TO", name: "iShares Core S&P US Total Market", weight: 102.1 }], sectorWeightings: [{ sector: "Financials", weight: 102.1 }], assetAllocation: { stock: 99.6, bond: 0, cash: 0.4, other: 0 }, expenseRatio: 0.08, lastUpdated: "2026-11-20" };
const normal = { topHoldings: [{ symbol: "AAPL", weight: 7 }, { symbol: "MSFT", weight: 6 }], sectorWeightings: [{ sector: "Technology", weight: 32 }, { sector: "Financials", weight: 13 }, { sector: "Other", weight: 55 }], assetAllocation: { stock: 99.5, cash: 0.5 }, expenseRatio: 0.09, lastUpdated: "2026-11-20" };

describe("Fund data sanity", () => {
  it("a fund that holds one other fund has its sector breakdown withheld, not shown as 102% Financials", () => {
    expect(wrapperHolding(xuh)?.symbol).toBe("XUU.TO");
    const u = usableSectors(xuh);
    expect(u.sectors).toBeNull();
    expect(u.withheld).toMatch(/holds one other fund/);
    expect(u.lookThrough?.symbol).toBe("XUU.TO");
    expect(auditFund(xuh, "2026-11-26").some((i) => i.severity === "wrong")).toBe(true);
  });
  it("a wrapper whose breakdown is already diversified is shown as is (XUS.U, QQC.F)", () => {
    const xus = { ...xuh, topHoldings: [{ symbol: "IVV", name: "iShares Core S&P 500 ETF", weight: 100 }], sectorWeightings: [{ sector: "Technology", weight: 38.7 }, { sector: "Financials", weight: 13 }, { sector: "Other", weight: 48.3 }] };
    expect(usableSectors(xus).sectors).toHaveLength(3);
    expect(auditFund(xus, "2026-11-26")).toEqual([]);
  });
  it("a normal fund is shown as is and has no findings", () => {
    expect(usableSectors(normal).sectors).toHaveLength(3);
    expect(auditFund(normal, "2026-11-26")).toEqual([]);
  });
  it("flags sectors over 105%, an allocation that does not add up, stale and missing data", () => {
    expect(usableSectors({ sectorWeightings: [{ sector: "A", weight: 70 }, { sector: "B", weight: 60 }] }).sectors).toBeNull();
    const issues = auditFund({ ...normal, assetAllocation: { stock: 60, bond: 10 }, lastUpdated: "2026-05-01", expenseRatio: undefined }, "2026-11-26").map((i) => i.what).join(" | ");
    expect(issues).toMatch(/Asset allocation adds to 70/);
    expect(issues).toMatch(/last fetched/);
    expect(issues).toMatch(/No fee/);
  });
});
