import { describe, expect, it } from "vitest";
import { actualWeights, mergeSplits, mergedPrices, parseSiaCsv, siaPositions, siaSummary, siaSymbol, splitFactorAfter, unitsAt } from "@/app/lib/sia-holdings";
import { computeRangeAttribution, type HoldingInput } from "@/app/lib/range-attribution";
import { packTxns, unpackTxns } from "@/app/lib/sia-store";

const CSV = [
  ",Edit,Date,Symbol,Action,Units,Price",
  ',,10/21/2026,GS,SELL,36,"$1,270.68"',
  ",,04/24/2026,GS,BUY,36,$1271.79",
  ',,01/02/2018,TDAY,BUY,"1,569",$14.48',
].join("\n");

describe("SIA transaction log — parsing", () => {
  it("reads dates, quoted numbers and dollar signs, oldest first", () => {
    const { txns, problems } = parseSiaCsv(CSV);
    expect(problems).toEqual([]);
    expect(txns.map((t) => t.date)).toEqual(["2018-01-02", "2026-04-24", "2026-10-21"]);
    expect(txns[0]).toEqual({ date: "2018-01-02", symbol: "TDAY", action: "BUY", units: 1569, price: 14.48 });
    expect(txns[2].price).toBeCloseTo(1270.68, 6);
  });

  it("reports a row it cannot read instead of guessing, and rejects a file without the columns", () => {
    const bad = parseSiaCsv(CSV + "\n,,not a date,XX,BUY,1,$1");
    expect(bad.txns).toHaveLength(3);
    expect(bad.problems).toHaveLength(1);
    expect(parseSiaCsv("a,b,c\n1,2,3").txns).toEqual([]);
    expect(parseSiaCsv("a,b,c\n1,2,3").problems[0]).toMatch(/expected columns/);
  });

  it("maps SIA symbols to the dashboard's form", () => {
    expect(siaSymbol("CLS.TO")).toBe("CLS-T");
    expect(siaSymbol("XUS.U.TO")).toBe("XUS.U");
    expect(siaSymbol("qqc.f.to")).toBe("QQC.F-T");
    expect(siaSymbol("ARX.TO.IN1")).toBe("ARX-T");
    expect(siaSymbol("LVGO.IN")).toBe("LVGO");
    expect(siaSymbol("ECHO")).toBe("SATS");
    expect(siaSymbol("PWR")).toBe("PWR");
  });

  it("packs and unpacks trades without loss", () => {
    const { txns } = parseSiaCsv(CSV);
    expect(unpackTxns(packTxns(txns))).toEqual(txns);
  });
});

describe("SIA transaction log — units over time", () => {
  const t = (date: string, symbol: string, action: "BUY" | "SELL", units: number, price = 10) => ({ date, symbol, action, units, price });

  it("expresses units in today's shares: a pre-split buy is multiplied by the split", () => {
    const splits = mergeSplits({ "XUS.U": [{ date: "2024-08-09", factor: 2 }] });
    expect(splitFactorAfter("XUS.U", "2024-07-15", splits)).toBe(2);
    expect(splitFactorAfter("XUS.U", "2024-09-16", splits)).toBe(1);
    const [p] = siaPositions([t("2024-07-15", "XUS.U.TO", "BUY", 2816, 96.83), t("2024-09-16", "XUS.U.TO", "BUY", 4, 48.16), t("2026-10-21", "XUS.U.TO", "SELL", 243, 68.23)], splits);
    expect(unitsAt(p.steps, "2024-08-01")).toBe(5632);
    expect(unitsAt(p.steps, "2026-11-01")).toBe(5632 + 4 - 243);
    // The pre-split trade price is halved so it is comparable with split-adjusted market prices.
    expect(p.tradePrices[0].price).toBeCloseTo(48.415, 3);
  });

  it("the built-in splits stay and an extra entry for the same date is not double-counted", () => {
    const m = mergeSplits({ GOOGL: [{ date: "2022-07-18", factor: 20 }], NEW: [{ date: "2026-01-02", factor: 3 }] });
    expect(m.GOOGL).toHaveLength(1);
    expect(m.NEW[0].factor).toBe(3);
    expect(m.TSLA).toHaveLength(2);
  });

  it("nets a day's trades before judging: a sell listed before a same-day buy is not a short", () => {
    const [p] = siaPositions([t("2022-10-19", "ARX.TO.IN1", "SELL", 52), t("2022-10-19", "ARX.TO.IN1", "BUY", 1879)]);
    expect(p.negativeOn).toEqual([]);
    expect(unitsAt(p.steps, "2022-10-19")).toBe(1827);
  });

  it("a total that ends a day below zero is reset to zero and reported, and a later buy starts clean", () => {
    const [p] = siaPositions([t("2020-01-02", "LVGO.IN", "BUY", 100), t("2021-11-15", "LVGO.IN", "SELL", 237), t("2026-03-01", "LVGO.IN", "BUY", 50)]);
    expect(p.negativeOn).toEqual(["2021-11-15"]);
    expect(unitsAt(p.steps, "2022-01-01")).toBe(0);
    expect(unitsAt(p.steps, "2026-03-02")).toBe(50);
  });

  it("a sliver left after a full sale is not a position", () => {
    const [p] = siaPositions([t("2026-01-02", "FID5982", "BUY", 3000.5), t("2026-06-01", "FID5982", "SELL", 3000.4)]);
    expect(unitsAt(p.steps, "2026-06-02")).toBe(0);
  });

  it("the summary lists what is held at the end and what was reset", () => {
    const s = siaSummary([t("2026-01-02", "AAA", "BUY", 10), t("2026-02-02", "BBB.TO", "BUY", 5), t("2026-03-02", "AAA", "SELL", 10)]);
    expect(s.rows).toBe(3);
    expect(s.first).toBe("2026-01-02");
    expect(s.last).toBe("2026-03-02");
    expect(s.heldAtEnd).toEqual(["BBB-T"]);
  });
});

describe("SIA transaction log — actual weights and contribution", () => {
  const cal = ["2026-11-02", "2026-11-03", "2026-11-04"];
  const px = (...v: number[]) => ({ dates: cal.slice(0, v.length), adj: v });

  it("weights are units × price ÷ book value at the prior close, and drift with prices", () => {
    const a = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 200, 200) };
    const b = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 100, 100) };
    const { weights } = actualWeights(cal, [a, b]);
    expect(weights[0][0]).toBeCloseTo(0.5, 9);
    // A doubled, so it is two thirds of the book for the next day — no rebalancing back to target.
    expect(weights[0][1]).toBeCloseTo(2 / 3, 9);
    expect(weights[1][1]).toBeCloseTo(1 / 3, 9);
  });

  it("a name bought during the range has no weight before its trade", () => {
    const a = { steps: [{ from: "2026-11-03", units: 10 }], prices: px(100, 100, 110) };
    const b = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 100, 100) };
    const { weights } = actualWeights(cal, [a, b]);
    expect(weights[0]).toEqual([0, 0.5]);
    expect(weights[1]).toEqual([1, 0.5]);
  });

  it("a holding with no fresh price is left out rather than carried at a stale value", () => {
    const merged = { steps: [{ from: "2020-01-01", units: 232 }], prices: { dates: ["2020-08-01"], adj: [174] } };
    const live = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 100, 100) };
    const { weights, staleDays } = actualWeights(cal, [merged, live]);
    expect(staleDays).toEqual([2, 0]);
    expect(weights[0]).toEqual([0, 0]);
    expect(weights[1]).toEqual([1, 1]);
  });

  it("trade prices fill in only where the market series has nothing", () => {
    const m = mergedPrices({ dates: ["2026-04-13", "2026-04-14"], adj: [26, 27] }, [
      { date: "2026-03-23", price: 28.26 },
      { date: "2026-04-13", price: 25.96 },
      { date: "2026-05-25", price: 30.74 },
    ]);
    expect(m.dates).toEqual(["2026-03-23", "2026-04-13", "2026-04-14", "2026-05-25"]);
    expect(m.adj).toEqual([28.26, 26, 27, 30.74]);
    expect(mergedPrices({ dates: [], adj: [] }, [{ date: "2026-05-25", price: 30.74 }]).adj).toEqual([30.74]);
  });

  it("the contribution maths uses the actual daily weights and still adds up exactly", () => {
    const hold = (symbol: string, sleeve: HoldingInput["sleeve"], w: number[], prices: { dates: string[]; adj: number[] }): HoldingInput => ({ symbol, sleeve, currency: "CAD", steps: [], dailyWeights: w, prices });
    const a = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 200, 200) };
    const b = { steps: [{ from: "2026-01-01", units: 10 }], prices: px(100, 100, 110) };
    const { weights } = actualWeights(cal, [a, b]);
    const r = computeRangeAttribution(cal, [hold("A", "stocks", weights[0], a.prices), hold("B", "core", weights[1], b.prices)], null);
    // Book value: 2000 → 3000 → 3100 = +55%, exactly what a units book returns.
    expect(r.estimatedReturnPct).toBeCloseTo(55, 4);
    expect(r.holdings.reduce((s, h) => s + h.contributionPct, 0)).toBeCloseTo(55, 3);
    expect(r.avgWeightCoveredPct).toBeCloseTo(100, 6);
  });
});
