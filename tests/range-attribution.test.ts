import { describe, expect, it } from "vitest";
import { computeRangeAttribution, scheduleFromTrades, seriesReturnPct, weightAt, type HoldingInput, type PriceSeries } from "@/app/lib/range-attribution";
import { eventsFromTransactions } from "@/app/lib/range-attribution-load";
import type { PimTransaction } from "@/app/lib/pim-types";

const cal = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
const px = (...v: number[]): PriceSeries => ({ dates: cal.slice(0, v.length), adj: v });
const hold = (symbol: string, sleeve: HoldingInput["sleeve"], weight: number, prices: PriceSeries, extra: Partial<HoldingInput> = {}): HoldingInput => ({ symbol, sleeve, currency: "CAD", steps: [{ from: "0000-00-00", weight }], prices, ...extra });

describe("computeRangeAttribution", () => {
  it("contributions add up exactly to the compounded book return", () => {
    const r = computeRangeAttribution(cal, [hold("A", "stocks", 0.5, px(100, 110, 99, 108.9)), hold("B", "core", 0.5, px(50, 50, 55, 55))], null);
    // Day returns: A +10%, −10%, +10%; B 0, +10%, 0 → book +5%, 0%, +5%.
    expect(r.estimatedReturnPct).toBeCloseTo(10.25, 4);
    expect(r.holdings.reduce((s, h) => s + h.contributionPct, 0)).toBeCloseTo(r.estimatedReturnPct, 3);
    expect(r.sleeves.reduce((s, x) => s + x.contributionPct, 0)).toBeCloseTo(r.estimatedReturnPct, 3);
    expect(r.avgWeightCoveredPct).toBeCloseTo(100, 4);
    expect(r.days).toBe(3);
  });

  it("a weight change takes effect the day AFTER the trade date", () => {
    const steps = [
      { from: "0000-00-00", weight: 0.1 },
      { from: "2026-11-03", weight: 0.3 },
    ];
    expect(weightAt(steps, "2026-11-02")).toBe(0.1);
    expect(weightAt(steps, "2026-11-03")).toBe(0.3);
    const r = computeRangeAttribution(cal, [{ ...hold("A", "stocks", 0, px(100, 110, 121, 133.1)), steps }], null);
    // +10% each day: 0.1×10% then 0.3×10% twice, linked through the book.
    const g1 = 1.01;
    const g2 = g1 * 1.03;
    expect(r.estimatedReturnPct).toBeCloseTo((g2 * 1.03 - 1) * 100, 3);
    expect(r.holdings[0].avgWeightPct).toBeCloseTo((0.1 + 0.3 + 0.3) / 3 * 100, 3);
  });

  it("a name bought or sold inside the range only counts for the days it was held", () => {
    const bought: HoldingInput = { ...hold("NEW", "stocks", 0, px(10, 20, 22, 24.2)), steps: [{ from: "2026-11-03", weight: 0.2 }] };
    const sold: HoldingInput = { ...hold("OLD", "thematic", 0, px(100, 90, 45, 10)), steps: [{ from: "0000-00-00", weight: 0.5 }, { from: "2026-11-03", weight: 0 }] };
    const r = computeRangeAttribution(cal, [bought, sold], null);
    const n = r.holdings.find((h) => h.symbol === "NEW")!;
    const o = r.holdings.find((h) => h.symbol === "OLD")!;
    // NEW misses the +100% day before it was bought; OLD misses the falls after it was sold.
    expect(n.daysHeld).toBe(2);
    expect(n.returnPct).toBeCloseTo(21, 3);
    expect(n.openedInRange).toBe(true);
    expect(n.status).toBe("held");
    expect(o.daysHeld).toBe(1);
    expect(o.returnPct).toBeCloseTo(-10, 3);
    expect(o.status).toBe("closed");
    expect(o.contributionPct).toBeCloseTo(-5, 3);
    expect(r.bottom.map((h) => h.symbol)).toEqual(["OLD"]);
    expect(r.top.map((h) => h.symbol)).toEqual(["NEW"]);
  });

  it("converts a US-dollar holding with USD/CAD on each date", () => {
    const fx: PriceSeries = { dates: cal, adj: [1.4, 1.4, 1.26, 1.26] };
    const usd = hold("US", "stocks", 1, px(100, 100, 100, 110), { currency: "USD" });
    const r = computeRangeAttribution(cal, [usd], fx);
    // Flat in US$, then the US dollar falls 10% → −10% in C$; then +10% in US$.
    expect(r.holdings[0].returnPct).toBeCloseTo((0.9 * 1.1 - 1) * 100, 3);
    // No FX series → the USD holding has no C$ price: counted as 0%, and flagged.
    const none = computeRangeAttribution(cal, [usd], null);
    expect(none.holdings[0].missingPriceDays).toBe(3);
    expect(none.estimatedReturnPct).toBe(0);
    expect(none.holdings[0].notes.join(" ")).toMatch(/no price/);
  });

  it("ranks the top 5 and bottom 5 and reports the sleeve's own return", () => {
    const moves = [30, 20, 10, 5, 2, 1, -1, -3, -6, -12, -25, -40];
    const hs = moves.map((m, i) => hold(`S${i}`, i % 2 ? "core" : "stocks", 1 / moves.length, px(100, 100 + m)));
    const r = computeRangeAttribution(cal.slice(0, 2), hs, null);
    expect(r.top.map((h) => h.symbol)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
    expect(r.bottom.map((h) => h.symbol)).toEqual(["S11", "S10", "S9", "S8", "S7"]);
    const core = r.sleeves.find((s) => s.sleeve === "core")!;
    expect(core.returnPct).toBeCloseTo((20 + 5 + 1 - 3 - 12 - 40) / 6, 3);
    expect(core.avgWeightPct).toBeCloseTo(50, 3);
  });

  it("reconciliation reads the recorded series between the same two closes", () => {
    const h = [{ date: "2026-11-02", value: 100 }, { date: "2026-11-05", value: 104 }];
    expect(seriesReturnPct(h, "2026-11-02", "2026-11-05")).toBe(4);
    expect(seriesReturnPct(h, "2026-11-01", "2026-11-05")).toBeNull();
  });
});

describe("scheduleFromTrades", () => {
  it("no trades → today's model weight for the whole period, noted", () => {
    const s = scheduleFromTrades([], { currentWeight: 0.05, heldAtTrackingStart: false });
    expect(s.steps).toEqual([{ from: "0000-00-00", weight: 0.05 }]);
    expect(s.notes[0]).toMatch(/no trades on file/);
    expect(scheduleFromTrades([], { currentWeight: null, heldAtTrackingStart: false }).steps).toEqual([]);
  });

  it("a name first bought in the log is zero before, then follows its rebalances", () => {
    const s = scheduleFromTrades(
      [
        { date: "2026-10-21", kind: "rebalance", direction: "buy", weight: 0.02 },
        { date: "2026-11-10", kind: "rebalance", direction: "buy", weight: 0.03 },
      ],
      { currentWeight: 0.03, heldAtTrackingStart: false },
    );
    expect(weightAt(s.steps, "2026-10-20")).toBe(0);
    expect(weightAt(s.steps, "2026-10-21")).toBe(0.02);
    expect(weightAt(s.steps, "2026-11-10")).toBe(0.03);
    expect(s.notes).toEqual([]);
  });

  it("a full sale of a name held before the log: held at the sold weight, then zero", () => {
    const s = scheduleFromTrades([{ date: "2026-11-05", kind: "trade", direction: "sell", moved: 0.018 }], { currentWeight: null, heldAtTrackingStart: true });
    expect(weightAt(s.steps, "2026-11-04")).toBe(0.018);
    expect(weightAt(s.steps, "2026-11-05")).toBe(0);
    expect(s.notes[0]).toMatch(/held before its first trade/);
  });

  it("a partial sale leaves today's weight; a switch moves the sold weight into the name bought", () => {
    const partial = scheduleFromTrades([{ date: "2026-11-05", kind: "trade", direction: "sell", moved: 0.01 }], { currentWeight: 0.02, heldAtTrackingStart: true });
    expect(weightAt(partial.steps, "2026-11-04")).toBeCloseTo(0.03, 9);
    expect(weightAt(partial.steps, "2026-11-05")).toBeCloseTo(0.02, 9);
    const switched = scheduleFromTrades([{ date: "2026-11-05", kind: "trade", direction: "buy", moved: 0.018 }], { currentWeight: 0.018, heldAtTrackingStart: false });
    expect(weightAt(switched.steps, "2026-11-04")).toBe(0);
    expect(weightAt(switched.steps, "2026-11-05")).toBe(0.018);
  });

  it("a plain buy with no weight on file uses the next weight on file, and says so", () => {
    const s = scheduleFromTrades([{ date: "2026-11-05", kind: "trade", direction: "buy", moved: 0 }], { currentWeight: 0.0182, heldAtTrackingStart: false });
    expect(weightAt(s.steps, "2026-11-04")).toBe(0);
    expect(weightAt(s.steps, "2026-11-05")).toBe(0.0182);
    expect(s.notes[0]).toMatch(/no weight on file/);
  });
});

describe("eventsFromTransactions", () => {
  const t = (o: Partial<PimTransaction>): PimTransaction => ({ id: "x", date: "2026-11-05T21:00:00.000Z", groupId: "pim", type: "rebalance", symbol: "AAPL", direction: "buy", price: 100, targetWeight: 0, ...o });
  const share = (p: string) => ({ allEquity: 1, growth: 0.83, balanced: 0.66, conservative: 0.3 } as Record<string, number>)[p] ?? null;

  it("takes the All-Equity row of a rebalance, ignores the sleeve books, and scales another model's weight up", () => {
    const all = eventsFromTransactions([t({ profile: "balanced", targetWeight: 0.0132 }), t({ profile: "allEquity", targetWeight: 0.02 }), t({ profile: "stocks", targetWeight: 0.09 })], share);
    expect(all.events).toEqual([{ date: "2026-11-05", kind: "rebalance", direction: "buy", weight: 0.02 }]);
    expect(all.scaledFrom).toEqual([]);
    const bal = eventsFromTransactions([t({ profile: "balanced", targetWeight: 0.0132 }), t({ profile: "alpha", targetWeight: 0.09 })], share);
    expect(bal.events[0]).toMatchObject({ kind: "rebalance" });
    expect((bal.events[0] as { weight: number }).weight).toBeCloseTo(0.02, 9);
    expect(bal.scaledFrom).toEqual(["balanced"]);
    expect(eventsFromTransactions([t({ profile: "core", targetWeight: 0.4 })], share).events).toEqual([]);
  });

  it("a buy / sell / switch row carries the weight that moved, on its Eastern date", () => {
    const e = eventsFromTransactions([t({ type: "sell", direction: "sell", targetWeight: 0.018, date: "2026-11-06T01:30:00.000Z" })], share);
    expect(e.events).toEqual([{ date: "2026-11-05", kind: "trade", direction: "sell", moved: 0.018 }]);
  });
});

// ── Rules that need the WHOLE log (found on real data, Nov 2026): the first
// version dropped every name that was TOPPED UP in the log's first rebalance.
import { scheduleWithLog, type LogContext, type TradeEvent } from "@/app/lib/range-attribution";
import { logContext } from "@/app/lib/range-attribution-load";

describe("scheduleWithLog", () => {
  const ctx: LogContext = { firstRebalance: "2026-04-13", rebalanceDates: ["2026-04-13", "2026-10-21"], switchWeightOn: (d) => (d === "2026-04-24" ? 0.01818 : null) };
  const reb = (date: string, direction: "buy" | "sell", weight: number): TradeEvent => ({ date, kind: "rebalance", direction, weight });
  const sw = (date: string, direction: "buy" | "sell", moved: number): TradeEvent => ({ date, kind: "trade", direction, moved });

  it("the first rebalance's direction stands: a 'buy' is a first purchase, a 'sell' was held before (PM-confirmed)", () => {
    const bought = scheduleWithLog([reb("2026-04-13", "buy", 0.01818), reb("2026-10-21", "sell", 0.01667)], { currentWeight: 0.01667, heldAtTrackingStart: false }, ctx);
    const trimmed = scheduleWithLog([reb("2026-04-13", "sell", 0.01818), reb("2026-10-21", "sell", 0.01667)], { currentWeight: 0.01667, heldAtTrackingStart: false }, ctx);
    expect(weightAt(bought.steps, "2026-04-10")).toBe(0);
    expect(weightAt(bought.steps, "2026-04-13")).toBeCloseTo(0.01818, 6);
    expect(weightAt(trimmed.steps, "2026-04-10")).toBeCloseTo(0.01818, 6);
    for (const x of [bought, trimmed]) expect(weightAt(x.steps, "2026-11-02")).toBeCloseTo(0.01667, 6);
  });

  it("a name first bought in a LATER rebalance is zero before it", () => {
    const s = scheduleWithLog([reb("2026-10-21", "buy", 0.05)], { currentWeight: 0.05, heldAtTrackingStart: false }, ctx);
    expect(weightAt(s.steps, "2026-10-20")).toBe(0);
    expect(weightAt(s.steps, "2026-10-21")).toBeCloseTo(0.05, 6);
  });

  it("a switch buy with no weight on file takes that day's usual switch weight, then exits at its zero rebalance row", () => {
    const s = scheduleWithLog([sw("2026-04-24", "buy", 0), reb("2026-10-21", "sell", 0)], { currentWeight: null, heldAtTrackingStart: false }, ctx);
    expect(weightAt(s.steps, "2026-04-23")).toBe(0);
    expect(weightAt(s.steps, "2026-05-01")).toBeCloseTo(0.01818, 6);
    expect(weightAt(s.steps, "2026-10-21")).toBe(0);
    expect(s.notes.join(" ")).toMatch(/usual switch weight/);
  });

  it("a partial-looking sale is a FULL sale when the name is absent from the next rebalance", () => {
    const s = scheduleWithLog([reb("2026-04-13", "sell", 0.01818), sw("2026-04-24", "sell", 0.012)], { currentWeight: null, heldAtTrackingStart: false }, ctx);
    expect(weightAt(s.steps, "2026-04-20")).toBeCloseTo(0.01818, 6);
    expect(weightAt(s.steps, "2026-04-24")).toBe(0);
    expect(s.notes.join(" ")).toMatch(/full sale/);
  });

  it("a fund trimmed by a switch and still held keeps the remainder (not a full sale)", () => {
    const s = scheduleWithLog([reb("2026-04-13", "sell", 0.05), sw("2026-08-19", "sell", 0.01818), reb("2026-10-21", "buy", 0.05)], { currentWeight: 0.05, heldAtTrackingStart: false }, ctx);
    expect(weightAt(s.steps, "2026-09-01")).toBeCloseTo(0.03182, 6);
    expect(weightAt(s.steps, "2026-11-02")).toBeCloseTo(0.05, 6);
  });

  it("a name never sold on file but absent from the next rebalance is counted until that rebalance", () => {
    const s = scheduleWithLog([reb("2026-04-13", "buy", 0.01818)], { currentWeight: null, heldAtTrackingStart: false }, ctx);
    expect(weightAt(s.steps, "2026-08-01")).toBeCloseTo(0.01818, 6);
    expect(weightAt(s.steps, "2026-10-21")).toBe(0);
    expect(s.notes.join(" ")).toMatch(/no sale on file/);
  });

  it("logContext finds the full-rebalance days and a day's usual switch weight", () => {
    const t = (o: Partial<PimTransaction>): PimTransaction => ({ id: "x", date: "2026-04-13T20:00:00.000Z", groupId: "pim", type: "rebalance", symbol: "A", direction: "buy", price: 1, targetWeight: 0.01, ...o });
    const c = logContext([
      t({ profile: "allEquity" }),
      t({ profile: "alpha" }),
      t({ date: "2026-10-21T20:00:00.000Z", profile: "balanced" }),
      t({ date: "2026-04-24T15:00:00.000Z", type: "switch", targetWeight: 0.01818 }),
      t({ date: "2026-04-24T15:00:00.000Z", type: "switch", targetWeight: 0 }),
      t({ date: "2026-04-24T15:00:00.000Z", type: "switch", targetWeight: 0.01818 }),
    ]);
    expect(c.rebalanceDates).toEqual(["2026-04-13", "2026-10-21"]);
    expect(c.firstRebalance).toBe("2026-04-13");
    expect(c.switchWeightOn("2026-04-24")).toBeCloseTo(0.01818, 6);
    expect(c.switchWeightOn("2026-05-01")).toBeNull();
  });
});

import { checkByMonth } from "@/app/lib/range-attribution";

describe("checkByMonth", () => {
  it("compounds the estimate inside each month and reads the record over the same days", () => {
    const daily = [
      { date: "2026-01-30", book: 0.01, core: 0.02, nonCore: 0 },
      { date: "2026-02-02", book: 0.1, core: 0.1, nonCore: 0.1 },
      { date: "2026-02-03", book: -0.1, core: null, nonCore: -0.1 },
    ];
    const rec = new Map([["2026-01-29", 100], ["2026-01-30", 102], ["2026-02-03", 91.8]]);
    const out = checkByMonth("2026-01-29", daily, (p) => (p === "allEquity" ? rec : new Map()));
    expect(out.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(out[0].book).toEqual({ est: 1, rec: 2 });
    // February: +10% then −10% = −1%; the record runs from the January month-end close.
    expect(out[1].book.est).toBeCloseTo(-1, 4);
    expect(out[1].book.rec).toBeCloseTo(-10, 4);
    expect(out[1].days).toBe(2);
    expect(out[1].core.rec).toBeNull();
  });
});
