import { describe, expect, it } from "vitest";
import { deriveFundamentals, median, usablePe } from "@/app/lib/signal-fundamentals-shared";

describe("Signal grid fundamentals from FactSet", () => {
  it("leverage, interest cover, EV/EBITDA and margins from the raw figures", () => {
    const d = deriveFundamentals({ pe: 30, mktVal: 1000, debt: 300, cash: 100, ebitdaLtm: 100, operIncLtm: 80, intExp: 10, fcfLtm: 60, salesLtm: 400, salesLtm4: 320, roic: 18, ltg: 15, sector: "Technology" }, 20, 25);
    expect(d.netDebtEbitda).toBe(2);
    expect(d.interestCoverage).toBe(8);
    expect(d.evEbitda).toBe(12);
    expect(d.fcfMargin).toBe(15);
    expect(d.revenueGrowth).toBe(25);
    expect(d.peg).toBe(2);
    expect(d.peVsMarketPct).toBe(50);
    expect(d.peVsSectorPct).toBe(20);
  });
  it("a bank gets no debt-based figures", () => {
    const d = deriveFundamentals({ pe: 12, mktVal: 1000, debt: 5000, cash: 100, ebitdaLtm: 100, operIncLtm: 80, intExp: 10, sector: "Financials" }, 20, 13);
    expect(d.netDebtEbitda).toBeNull();
    expect(d.interestCoverage).toBeNull();
    expect(d.evEbitda).toBeNull();
    expect(deriveFundamentals({ fcfLtm: 500, salesLtm: 490, sector: "Financials" }, 20, 13).fcfMargin).toBeNull();
    expect(d.pe).toBe(12);
  });
  it("missing inputs give null, never a guess; a negative or absurd P/E is not ranked", () => {
    const d = deriveFundamentals({ pe: -5, debt: 0, cash: 50, sector: "Technology" }, 20, 25);
    expect(d.pe).toBeNull();
    expect(d.peVsMarketPct).toBeNull();
    expect(d.fcfMargin).toBeNull();
    expect(d.noDebt).toBe(true);
    expect(usablePe(900)).toBe(false);
    expect(median([1, 9, 5])).toBe(5);
  });
});
