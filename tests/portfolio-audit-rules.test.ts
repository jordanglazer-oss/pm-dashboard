import { describe, expect, it } from "vitest";
import { analystFindings, constructionFindings, driftFindings, driftRows, weekOf } from "@/app/lib/agents/portfolio-audit-rules";
import type { EquityBucket, PimPortfolioPositions } from "@/app/lib/pim-types";
import { group, h } from "./helpers";

const today = "2026-11-19"; // a Thursday
const bucket = (sym: string): EquityBucket => (sym === "XIC" ? "core" : sym === "GRNJ" ? "thematic" : "alpha");
// All-Equity = 100% equity, so model share of the book = weightInClass.
const pim = group("pim", [h("XIC", 0.84), h("AAPL", 0.02), h("MSFT", 0.02), h("NVDA", 0.02), h("GRNJ", 0.1)]);
const book = (positions: [string, number][], cash = 0): PimPortfolioPositions => ({ groupId: "pim", profile: "allEquity", positions: positions.map(([symbol, units]) => ({ symbol, units, costBasis: 1 })), cashBalance: cash, lastUpdated: today });
const at1 = () => 1; // every unit worth C$1, so units are dollars

describe("drift", () => {
  it("flags a stock off model by 1 point or 35% of target; leaves an on-model stock and Core / Managed Alpha alone", () => {
    // 1000 total: AAPL 3.2% (model 2% → +1.2 pts), MSFT 2% (on model), NVDA 1.2% (−0.8 pt = −40% → relative rule), XIC 83.6%, GRNJ 10%.
    const rows = driftRows(pim, bucket, [book([["XIC", 836], ["AAPL", 32], ["MSFT", 20], ["NVDA", 12], ["GRNJ", 100]])], at1);
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(rows[0].live).toBeCloseTo(0.032, 6);
    expect(rows[0].model).toBeCloseTo(0.02, 6);
    const f = driftFindings(rows, today);
    expect(f).toHaveLength(1);
    expect(f[0].priority).toBe("medium");
    expect(f[0].dedupeKey).toBe("audit-position-drift-2026-11-16");
  });

  it("never flags a Core ETF or a Managed Alpha fund, however far it has drifted", () => {
    const rows = driftRows(pim, bucket, [book([["XIC", 700], ["AAPL", 20], ["MSFT", 20], ["NVDA", 20], ["GRNJ", 240]])], at1);
    expect(rows).toEqual([]);
  });

  it("skips a book when any held position has no price, and a book with no units", () => {
    const b = book([["XIC", 836], ["AAPL", 32], ["MSFT", 20], ["NVDA", 12], ["GRNJ", 100]]);
    expect(driftRows(pim, bucket, [b], (s) => (s === "GRNJ" ? null : 1))).toEqual([]);
    expect(driftRows(pim, bucket, [book([])], at1)).toEqual([]);
    expect(driftRows(pim, bucket, [], at1)).toEqual([]);
    expect(driftFindings([], today)).toEqual([]);
  });

  it("a model stock with no units and a held stock outside the model are both reported", () => {
    const rows = driftRows(pim, bucket, [book([["XIC", 880], ["AAPL", 20], ["MSFT", 20], ["GRNJ", 60], ["TSLA", 20]])], at1);
    expect(rows.map((r) => r.symbol).sort()).toEqual(["NVDA", "TSLA"]);
    expect(rows.find((r) => r.symbol === "NVDA")!.live).toBe(0);
    expect(rows.find((r) => r.symbol === "TSLA")!.model).toBe(0);
  });

  it("the week key is that week's Monday", () => {
    expect(weekOf("2026-11-16")).toBe("2026-11-16");
    expect(weekOf("2026-11-22")).toBe("2026-11-16");
    expect(weekOf("2026-11-23")).toBe("2026-11-23");
  });
});

describe("construction", () => {
  // Ten equal stocks: the top five are exactly 50% of the sleeve (under the 60% limit).
  const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const sectors: Record<string, string> = { A: "Technology", B: "Technology", C: "Technology", D: "Technology", E: "Health Care", F: "Energy", G: "Industrials", H: "Materials", I: "Financials", J: "Utilities" };
  const stocksOf = (m: Record<string, string>) => Object.entries(m).map(([ticker, sector]) => ({ ticker, sector }));
  const alpha = () => "alpha" as EquityBucket;

  it("an even ten-stock sleeve raises only the sector over 35%", () => {
    const g = group("pim", names.map((n) => h(n, 0.02)));
    const f = constructionFindings(g, alpha, stocksOf(sectors), today);
    expect(f.map((x) => x.rule)).toEqual(["sector-concentration"]);
    expect(f[0].detail).toContain("Technology 40%");
    expect(f[0].dedupeKey).toBe("audit-sector-concentration-2026-11");
  });

  it("eight equal stocks trip the top-five rule (62.5%) — few names is itself concentration", () => {
    const g = group("pim", names.slice(0, 8).map((n) => h(n, 0.02)));
    expect(constructionFindings(g, alpha, [], today).map((x) => x.rule)).toEqual(["top5-concentration"]);
  });

  it("flags a stock above 10% of the All-Equity portfolio (medium) and a heavy top five", () => {
    const g = group("pim", [h("A", 0.12), h("B", 0.05), h("C", 0.05), h("D", 0.05), h("E", 0.05), h("F", 0.01), h("G", 0.01), h("H", 0.01)]);
    const f = constructionFindings(g, alpha, stocksOf({ A: "Technology", B: "Financials", C: "Health Care", D: "Energy", E: "Industrials", F: "Materials", G: "Utilities", H: "Real Estate" }), today);
    // A is 34% of the sleeve (under the 35% sector limit); the top five are 91% of it.
    expect(f.map((x) => `${x.rule}:${x.priority}`)).toEqual(["stock-over-cap:medium", "top5-concentration:low"]);
    expect(f.find((x) => x.rule === "stock-over-cap")!.names).toEqual(["A (12.0%)"]);
  });

  it("the cap is measured on the All-Equity portfolio, so the equity share scales it", () => {
    const g = group("pim", [h("A", 0.12), ...names.slice(1).map((n) => h(n, 0.02))], 0.8); // 12% of equity × 80% = 9.6%
    expect(constructionFindings(g, alpha, [], today).some((x) => x.rule === "stock-over-cap")).toBe(false);
  });

  it("too few sectors is flagged only when every stock's sector is on file", () => {
    const g = group("pim", names.map((n) => h(n, 0.02)));
    const two = Object.fromEntries(names.map((n, i) => [n, i < 5 ? "Technology" : "Financials"]));
    expect(constructionFindings(g, alpha, stocksOf(two), today).map((x) => x.rule).sort()).toEqual(["few-sectors", "sector-concentration"]);
    const missing = { ...two } as Record<string, string>;
    delete missing.J;
    expect(constructionFindings(g, alpha, stocksOf(missing), today).some((x) => x.rule === "few-sectors")).toBe(false);
  });

  it("no sector on file → no sector findings; Core and Managed Alpha are not part of the sleeve", () => {
    const g = group("pim", names.map((n) => h(n, 0.02)));
    expect(constructionFindings(g, alpha, [], today)).toEqual([]);
    expect(constructionFindings(pim, bucket, [], today)).toEqual([]); // 3 stocks: top-5 rule does not apply
  });
});

describe("analyst trend", () => {
  it("stays silent on a log too young to compare", () => {
    const young = { AAPL: [{ date: "2026-11-17", target: 250, count: 40 }, { date: "2026-11-19", target: 200, count: 30 }] };
    expect(analystFindings(["AAPL"], young, today)).toEqual([]);
    expect(analystFindings(["AAPL"], {}, today)).toEqual([]);
    expect(analystFindings(["AAPL"], { AAPL: [{ date: "2026-08-01", target: 250, count: 40 }] }, today)).toEqual([]);
  });

  it("one list flag for held names: a 10% target cut in 30 days, 3 fewer analysts in 90, or 3 cuts in a row", () => {
    const history = {
      AAPL: [{ date: "2026-10-10", target: 200, count: 30 }, { date: "2026-11-19", target: 178, count: 30 }], // −11% in 30d
      MSFT: [{ date: "2026-08-01", target: 500, count: 40 }, { date: "2026-11-19", target: 500, count: 36 }], // −4 analysts in 90d
      NVDA: [{ date: "2026-11-10", target: 100, count: 50 }, { date: "2026-11-12", target: 99, count: 50 }, { date: "2026-11-14", target: 98, count: 50 }, { date: "2026-11-18", target: 97, count: 50 }], // 3 cuts in a row
      TSLA: [{ date: "2026-10-10", target: 200, count: 30 }, { date: "2026-11-19", target: 100, count: 10 }], // not held
      "SHOP-T": [{ date: "2026-10-10", target: 200, count: 30 }, { date: "2026-11-19", target: 199, count: 30 }], // small move
    };
    const f = analystFindings(["AAPL", "MSFT", "NVDA", "SHOP.TO"], history, today);
    expect(f).toHaveLength(1);
    expect(f[0].priority).toBe("medium");
    expect(f[0].dedupeKey).toBe("audit-analyst-trend-2026-11");
    expect(f[0].names!.map((n) => n.split(" ")[0])).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});
