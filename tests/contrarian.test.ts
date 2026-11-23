import { describe, expect, it } from "vitest";
import { isCanadianListing, isOutOfFavour, readContrarian, testCheap, testEstimates, testInsiders, testWashedOut, type ContrarianInput } from "@/app/lib/contrarian";
import { contrarianUniverse, thesisFrom, valuationFrom } from "@/app/lib/contrarian-load";
import type { FavourRead } from "@/app/lib/favour";
import type { AnalystTrend } from "@/app/lib/analyst-history";

const today = "2026-11-22";
const favour = (fromHighPct: number | null, m6: number | null, m12: number | null = null, state: FavourRead["state"] = "out"): FavourRead => ({ state, rel: { m1: null, m3: null, m6, m12 }, fromHighPct, reasons: [] });
const OUT = favour(-30, -18, -25);
const STRONG = favour(-3, 12, 20, "in");
const trend = (targetPct: number | null, streak: AnalystTrend["targetStreak"] = null): AnalystTrend => ({ latest: { date: today, target: 100 }, d30: targetPct == null ? null : { targetPct, count: 0 }, d90: null, targetStreak: streak });
const insiders = (buyCount: number, buy: number, sellCount: number, sell: number) => ({ buyCount, sellCount, totalBuyValue: buy, totalSellValue: sell, windowDays: 90 });

describe("contrarian — cheap versus its own history", () => {
  it("met when the multiple sits 15%+ below its 5-year average", () => {
    expect(testCheap({ ntmPe: 16, ntmPeFiveYrAvg: 20, asOf: "2026-10-30" }, today).status).toBe("met");
  });
  it("not met when only a little below, or above", () => {
    expect(testCheap({ ntmPe: 18.5, ntmPeFiveYrAvg: 20 }, today).status).toBe("not-met");
    expect(testCheap({ ntmPe: 25, ntmPeFiveYrAvg: 20 }, today).status).toBe("not-met");
  });
  it("averages the two multiples when both are on file", () => {
    // P/E 30% below, EV/EBITDA 10% above → average 10% below → not met
    expect(testCheap({ ntmPe: 14, ntmPeFiveYrAvg: 20, evEbitda: 11, evEbitdaFiveYrAvg: 10 }, today).status).toBe("not-met");
  });
  it("no data without a 5-year average, with nothing on file, with a negative multiple, or when stale", () => {
    expect(testCheap(null, today).status).toBe("no-data");
    expect(testCheap({ ntmPe: 16 }, today).status).toBe("no-data");
    expect(testCheap({ ntmPe: -5, ntmPeFiveYrAvg: 20 }, today).status).toBe("no-data");
    expect(testCheap({ ntmPe: 10, ntmPeFiveYrAvg: 20, asOf: "2026-01-01" }, today).status).toBe("no-data");
  });
});

describe("contrarian — estimates have stopped falling", () => {
  it("met when revisions are not net negative and the target has held", () => {
    expect(testEstimates({ revUp: 5, revDown: 3, analystCount: 20 }, trend(-1)).status).toBe("met");
    expect(testEstimates({ revUp: 2, revDown: 2, analystCount: 10 }, trend(0.5)).status).toBe("met");
  });
  it("still decided by revisions when the target log is too short — and says so", () => {
    const t = testEstimates({ revUp: 4, revDown: 1, analystCount: 12 }, null);
    expect(t.status).toBe("met");
    expect(t.summary).toMatch(/too short/);
  });
  it("not met while cuts outnumber raises, or the target is still being cut", () => {
    expect(testEstimates({ revUp: 1, revDown: 6, analystCount: 20 }, trend(0)).status).toBe("not-met");
    expect(testEstimates({ revUp: 5, revDown: 3, analystCount: 20 }, trend(-8)).status).toBe("not-met");
  });
  it("no data with no revisions or a panel under four analysts", () => {
    expect(testEstimates(null, trend(0)).status).toBe("no-data");
    expect(testEstimates({ analystCount: 20 }, trend(0)).status).toBe("no-data");
    expect(testEstimates({ revUp: 2, revDown: 0, analystCount: 3 }, trend(0)).status).toBe("no-data");
    expect(testEstimates({ revUp: 2, revDown: 0 }, trend(0)).status).toBe("no-data");
  });
});

describe("contrarian — insiders buying", () => {
  it("met when open-market purchases outweigh sales and clear the minimum", () => {
    expect(testInsiders(insiders(2, 750_000, 1, 200_000), true).status).toBe("met");
  });
  it("not met when sales outweigh, purchases are tiny, or there were no trades", () => {
    expect(testInsiders(insiders(1, 300_000, 3, 2_000_000), true).status).toBe("not-met");
    expect(testInsiders(insiders(1, 40_000, 0, 0), true).status).toBe("not-met");
    expect(testInsiders(insiders(0, 0, 0, 0), true).status).toBe("not-met");
    expect(testInsiders(insiders(0, 0, 2, 500_000), true).status).toBe("not-met");
  });
  it("no data for a Canadian listing or when nothing is cached", () => {
    expect(testInsiders(insiders(5, 5_000_000, 0, 0), false).status).toBe("no-data");
    expect(testInsiders(null, true).status).toBe("no-data");
    expect(isCanadianListing("SHOP-T")).toBe(true);
    expect(isCanadianListing("CNR.TO")).toBe(true);
    expect(isCanadianListing("AAPL")).toBe(false);
  });
});

describe("contrarian — out of favour, business not broken", () => {
  it("met when well off the high and lagging, with the thesis intact or absent", () => {
    expect(testWashedOut(OUT, { brokenPillars: [], trippedBreakers: [] }).status).toBe("met");
    expect(testWashedOut(OUT, null).status).toBe("met");
    // 12-month lag alone is enough alongside the drawdown
    expect(testWashedOut(favour(-22, -4, -20, "neutral"), null).status).toBe("met");
  });
  it("not met for a strong stock, or when our own thesis says something is broken", () => {
    expect(testWashedOut(STRONG, null).status).toBe("not-met");
    expect(testWashedOut(favour(-25, -2, -3, "neutral"), null).status).toBe("not-met"); // off the high but not lagging
    expect(testWashedOut(OUT, { brokenPillars: ["Margin structure"], trippedBreakers: [] }).status).toBe("not-met");
    expect(testWashedOut(OUT, { brokenPillars: [], trippedBreakers: ["RPO falls"] }).status).toBe("not-met");
  });
  it("no data without a price read", () => {
    expect(testWashedOut(null, null).status).toBe("no-data");
    expect(testWashedOut(favour(null, null, null, "thin"), null).status).toBe("no-data");
    expect(isOutOfFavour(null)).toBeNull();
  });
});

describe("contrarian — the label", () => {
  const base: ContrarianInput = { today, valuation: null, revisions: null, trend: null, usFiler: true, insiders: null, favour: OUT, thesis: null };
  const cheap = { ntmPe: 14, ntmPeFiveYrAvg: 20 };
  const revs = { revUp: 5, revDown: 2, analystCount: 15 };
  const buying = insiders(2, 900_000, 0, 0);

  it("'Contrarian setup' needs out of favour AND two supporting signs", () => {
    const r = readContrarian({ ...base, valuation: cheap, revisions: revs });
    expect(r.label).toBe("Contrarian setup");
    expect(r.score).toBe(3);
    expect(r.of).toBe(3);
    expect(readContrarian({ ...base, valuation: cheap, revisions: revs, insiders: buying }).score).toBe(4);
  });
  it("one supporting sign is 'Partial'; none is 'Not a contrarian setup'", () => {
    expect(readContrarian({ ...base, valuation: cheap, revisions: { revUp: 0, revDown: 9, analystCount: 15 } }).label).toBe("Partial");
    expect(readContrarian({ ...base, valuation: { ntmPe: 25, ntmPeFiveYrAvg: 20 } }).label).toBe("Not a contrarian setup");
  });
  it("a strong stock is never a contrarian setup, however many other tests pass", () => {
    const r = readContrarian({ ...base, favour: STRONG, valuation: cheap, revisions: revs, insiders: buying });
    expect(r.label).toBe("Not a contrarian setup");
    expect(r.why).toMatch(/not out of favour/);
  });
  it("an out-of-favour stock with a broken pillar is flagged as impaired, not contrarian", () => {
    const r = readContrarian({ ...base, valuation: cheap, revisions: revs, thesis: { brokenPillars: ["Demand"], trippedBreakers: [] } });
    expect(r.label).toBe("Not a contrarian setup");
    expect(r.why).toMatch(/impaired/);
  });
  it("'Not enough data' without a price read, or out of favour with nothing else on file", () => {
    expect(readContrarian({ ...base, favour: null, valuation: cheap, revisions: revs }).label).toBe("Not enough data");
    expect(readContrarian(base).label).toBe("Not enough data");
  });
  it("always carries the caution", () => {
    expect(readContrarian(base).caution).toMatch(/not a buy signal/);
  });
});

describe("contrarian — loader helpers", () => {
  it("takes the newest alert that has a multiple with its 5-year average", () => {
    const store = {
      AAPL: [
        { id: "1", ticker: "AAPL", kind: "news", date: "2026-11-10", firms: [] },
        { id: "2", ticker: "AAPL", kind: "takeaways", date: "2026-08-01", firms: [], valuation: { ntmPe: 30, ntmPeFiveYrAvg: 27 } },
        { id: "3", ticker: "AAPL", kind: "takeaways", date: "2026-10-30", firms: [], valuation: { ntmPe: 28, ntmPeFiveYrAvg: 27 } },
        { id: "4", ticker: "AAPL", kind: "takeaways", date: "2026-11-05", firms: [], valuation: { ntmPe: 29 } },
      ],
    } as never;
    expect(valuationFrom(store, "AAPL")).toMatchObject({ ntmPe: 28, asOf: "2026-10-30" });
    expect(valuationFrom(store, "MSFT")).toBeNull();
  });
  it("finds a Canadian name under either listing form", () => {
    const store = { "CLS.TO": [{ id: "1", ticker: "CLS", kind: "takeaways", date: "2026-10-30", firms: [], valuation: { evEbitda: 9, evEbitdaFiveYrAvg: 12 } }] } as never;
    expect(valuationFrom(store, "CLS-T")).toMatchObject({ evEbitda: 9 });
  });
  it("reads broken pillars and tripped long-term breakers only; no thesis → null", () => {
    expect(thesisFrom(undefined)).toBeNull();
    const t = thesisFrom({
      pillars: [{ id: "a", title: "Demand", claim: "c", status: "broken" }, { id: "b", title: "Margins", claim: "c", status: "watch" }],
      killConditions: [
        { id: "k1", kind: "custom", note: "RPO falls", addedAt: "2026-01-01", trippedAt: "2026-10-01" },
        { id: "k2", kind: "ma200", addedAt: "2026-01-01", trippedAt: "2026-10-01" },
        { id: "k3", kind: "metric", addedAt: "2026-01-01" },
      ],
    } as never);
    expect(t).toEqual({ brokenPillars: ["Demand"], trippedBreakers: ["RPO falls"] });
  });
  it("covers individual stocks in the book only", () => {
    const names = contrarianUniverse([
      { ticker: "AAPL", bucket: "Portfolio" },
      { ticker: "SHOP-T", bucket: "Watchlist", instrumentType: "stock" },
      { ticker: "XIC-T", bucket: "Portfolio", instrumentType: "etf" },
      { ticker: "FID5982", bucket: "Portfolio" },
      { ticker: "NVDA", bucket: "Suggested" },
    ]).map((n) => n.ticker);
    expect(names).toEqual(["AAPL", "SHOP-T"]);
  });
});
