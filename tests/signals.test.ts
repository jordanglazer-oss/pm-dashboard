import { describe, expect, it } from "vitest";
import { analystSignal, computeSignals, fundamentalsSignal, houseSignal, relStrengthSignal, technicalsSignal, upsideSignal } from "@/app/lib/signals";

describe("Signal grid — each signal on its own", () => {
  it("upside: positive above 10%, negative below 0, neutral between, pending with no target", () => {
    expect(upsideSignal({ price: 100, avgTarget: 115 }).state).toBe("positive");
    expect(upsideSignal({ price: 100, avgTarget: 105 }).state).toBe("neutral");
    expect(upsideSignal({ price: 100, avgTarget: 95 }).state).toBe("negative");
    expect(upsideSignal({ price: 100 }).state).toBe("pending");
  });

  it("house views: positive only when both rate it positively; mixed or one missing is neutral", () => {
    expect(houseSignal({ rbc: { rating: "outperform" }, jpm: { rating: "outperform" } }).state).toBe("positive");
    expect(houseSignal({ rbc: { rating: "outperform" }, jpm: { rating: "neutral" } }).state).toBe("neutral");
    expect(houseSignal({ rbc: { rating: "outperform" } }).state).toBe("neutral");
    expect(houseSignal({ rbc: { rating: "underperform" }, jpm: { rating: "underperform" } }).state).toBe("negative");
    expect(houseSignal({}).state).toBe("pending");
  });

  it("analyst consensus: net revisions as a share of the analyst count", () => {
    expect(analystSignal({ revUp: 8, revDown: 2, analystCount: 30 }).state).toBe("positive");
    expect(analystSignal({ revUp: 2, revDown: 8, analystCount: 30 }).state).toBe("negative");
    expect(analystSignal({ revUp: 3, revDown: 2, analystCount: 30 }).state).toBe("neutral");
    expect(analystSignal({}).state).toBe("pending");
  });

  it("relative strength from the SIA reading", () => {
    expect(relStrengthSignal({ sia: 9 }).state).toBe("positive");
    expect(relStrengthSignal({ sia: 5 }).state).toBe("neutral");
    expect(relStrengthSignal({ sia: 2 }).state).toBe("negative");
    expect(relStrengthSignal({}).state).toBe("pending");
  });

  it("fundamentals: pending with fewer than four metrics, never a guess", () => {
    expect(fundamentalsSignal({ peg: 1.0, roic: 20, fcfMargin: 15 }).state).toBe("pending");
    expect(fundamentalsSignal({ peg: 1.0, roic: 20, fcfMargin: 15, netDebtEbitda: 0.5 }).state).toBe("positive");
    expect(fundamentalsSignal({ peg: 4, roic: 3, fcfMargin: -2, interestCoverage: 1.2 }).state).toBe("negative");
    expect(fundamentalsSignal({ peg: 1.0, roic: 3, fcfMargin: 5, peVsMarketPct: 5 }).state).toBe("neutral");
  });

  it("fundamentals: no debt reads well for coverage and leverage; P/E vs market and sector count", () => {
    const s = fundamentalsSignal({ noDebt: true, peVsMarketPct: -20, peVsSectorPct: -15 });
    expect(s.state).toBe("positive");
    expect(s.rows.find((r) => r.label.startsWith("Net debt"))?.value).toBe("no debt");
  });

  it("technicals: above both averages near the high reads positive", () => {
    expect(technicalsSignal({ price: 100, sma50: 95, sma200: 90, rsi14: 58, week52High: 104 }).state).toBe("positive");
    expect(technicalsSignal({ price: 70, sma50: 85, sma200: 95, rsi14: 40, week52High: 110 }).state).toBe("negative");
    expect(technicalsSignal({ price: 100 }).state).toBe("pending");
  });

  it("counts positives; there is no combined score", () => {
    const s = computeSignals({ price: 100, avgTarget: 120, sia: 8, rbc: { rating: "outperform" }, jpm: { rating: "outperform" } });
    expect(s.positives).toBe(3);
    expect(s.withData).toBe(3);
    expect(Object.keys(s)).not.toContain("score");
  });
});
