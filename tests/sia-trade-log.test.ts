import { describe, expect, it } from "vitest";
import { siaTradeLog, tradeLogSummary } from "@/app/lib/sia-trade-log";
import type { SiaTxn } from "@/app/lib/sia-holdings";

const t = (date: string, symbol: string, action: "BUY" | "SELL", units: number, price: number): SiaTxn => ({ date, symbol, action, units, price });

describe("Trade log from the SIA log", () => {
  it("labels buy, add, trim and sale, and measures each sale against average cost", () => {
    const rows = siaTradeLog([t("2026-01-05", "ABC", "BUY", 100, 100), t("2026-02-05", "ABC", "BUY", 100, 120), t("2026-03-05", "ABC", "SELL", 50, 132), t("2026-04-05", "ABC", "SELL", 150, 99)]);
    expect(rows.map((r) => r.kind)).toEqual(["Sold", "Trimmed", "Added", "Bought"]);
    const trim = rows[1];
    expect(trim.avgCost).toBeCloseTo(110, 9);
    expect(trim.gainPct).toBeCloseTo(20, 9);
    expect(trim.gain).toBeCloseTo(50 * 22, 9);
    const sale = rows[0];
    expect(sale.gainPct).toBeCloseTo(-10, 9);
    expect(tradeLogSummary(rows).realized).toBeCloseTo(1100 - 1650, 6);
  });
  it("a sale after a split is measured in the same share terms as its cost", () => {
    const rows = siaTradeLog([t("2024-01-05", "NVDA", "BUY", 10, 500), t("2024-07-01", "NVDA", "SELL", 50, 60)]); // 10-for-1 on 2024-06-10
    const sale = rows[0];
    expect(sale.kind).toBe("Trimmed");
    expect(sale.avgCost).toBeCloseTo(50, 9);
    expect(sale.gainPct).toBeCloseTo(20, 9);
  });
  it("no gain is shown when a purchase had no price", () => {
    const rows = siaTradeLog([t("2026-01-05", "XYZ", "BUY", 100, 0), t("2026-02-05", "XYZ", "SELL", 100, 10)]);
    expect(rows[0].gain).toBeNull();
    expect(rows[0].note).toMatch(/no price/);
    expect(tradeLogSummary(rows).salesNotCounted).toBe(1);
  });
  it("sold out and bought again starts as a new purchase", () => {
    const rows = siaTradeLog([t("2025-01-05", "GS", "BUY", 10, 100), t("2025-06-05", "GS", "SELL", 10, 150), t("2026-04-24", "GS", "BUY", 5, 200)]);
    expect(rows[0].kind).toBe("Bought");
  });
});
