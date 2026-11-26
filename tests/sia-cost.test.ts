import { describe, expect, it } from "vitest";
import { siaCostBasis } from "@/app/lib/sia-cost";
import { currencyImpact, type FxRow } from "@/app/lib/currency-impact";
import type { SiaTxn } from "@/app/lib/sia-holdings";

const t = (date: string, symbol: string, action: "BUY" | "SELL", units: number, price: number): SiaTxn => ({ date, symbol, action, units, price });

describe("Since purchase — average cost from the SIA log", () => {
  it("averages two purchases and keeps the first date", () => {
    const [c] = siaCostBasis([t("2026-01-05", "RY.TO", "BUY", 100, 100), t("2026-03-05", "RY.TO", "BUY", 100, 120)]);
    expect(c.symbol).toBe("RY-T");
    expect(c.since).toBe("2026-01-05");
    expect(c.units).toBe(200);
    expect(c.avgCost).toBeCloseTo(110, 9);
    expect(c.incomplete).toBe(false);
  });

  it("a trim leaves the average cost unchanged", () => {
    const [c] = siaCostBasis([t("2026-01-05", "GS", "BUY", 100, 100), t("2026-02-05", "GS", "SELL", 40, 150)]);
    expect(c.units).toBe(60);
    expect(c.avgCost).toBeCloseTo(100, 9);
  });

  it("sold out and bought again starts a fresh holding period", () => {
    const [c] = siaCostBasis([t("2025-01-05", "GS", "BUY", 100, 100), t("2025-06-05", "GS", "SELL", 100, 150), t("2026-04-24", "GS", "BUY", 50, 200)]);
    expect(c.since).toBe("2026-04-24");
    expect(c.avgCost).toBeCloseTo(200, 9);
  });

  it("a name fully sold is not listed", () => {
    expect(siaCostBasis([t("2025-01-05", "GS", "BUY", 100, 100), t("2025-06-05", "GS", "SELL", 100, 150)])).toEqual([]);
  });

  it("units and cost per unit are in today's share terms after a split", () => {
    const [c] = siaCostBasis([t("2024-01-05", "NVDA", "BUY", 10, 500)]);
    expect(c.units).toBe(100); // 10-for-1 on 2024-06-10
    expect(c.avgCost).toBeCloseTo(50, 9);
  });

  it("a purchase with no price marks the cost incomplete", () => {
    const [c] = siaCostBasis([t("2026-01-05", "ABC", "BUY", 100, 0), t("2026-02-05", "ABC", "BUY", 100, 10)]);
    expect(c.incomplete).toBe(true);
  });

  it("a sell listed before a same-day buy is not a short", () => {
    const [c] = siaCostBasis([t("2026-01-05", "ABC", "SELL", 50, 12), t("2026-01-05", "ABC", "BUY", 100, 10)]);
    expect(c.units).toBe(50);
    expect(c.avgCost).toBeCloseTo(10, 9);
  });
});

describe("Currency impact — the team's validation case (Nov 25)", () => {
  it("USD/CAD up 3.5% × 50% unhedged US-dollar exposure = +1.75%", () => {
    const row = (symbol: string, weight: number, cls: FxRow["cls"]): FxRow => ({ symbol, name: symbol, currency: "CAD", assetClass: "equity", weight, cls, reason: "" });
    const rows = [row("US", 0.5, "usd-unhedged"), row("HEDGED", 0.2, "hedged"), row("CDN", 0.3, "cad")];
    const fx = [{ date: "2025-12-31", value: 1.4 }, { date: "2026-06-30", value: 1.4 * 1.035 }];
    const out = currencyImpact(rows, fx, "2026-01-01", "2026-06-30");
    expect(out.fxPct).toBeCloseTo(3.5, 4);
    expect(out.contributionPct).toBeCloseTo(1.75, 4);
  });
});
