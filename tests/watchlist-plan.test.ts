import { describe, expect, it } from "vitest";
import { addedByOptions, watchAlerts, watchRows } from "@/app/lib/watchlist-plan";

const stocks = [
  { ticker: "AAA", name: "Alpha", bucket: "Watchlist", watch: { priceAtAdd: 100, targetBuyPrice: 85, addedBy: "Jordan", thesis: "Cheap" } },
  { ticker: "BBB", name: "Beta", bucket: "Watchlist", watch: { priceAtAdd: 50, targetBuyPrice: 40, addedBy: "Jordan" } },
  { ticker: "CCC", name: "Gamma", bucket: "Watchlist" },
  { ticker: "DDD", name: "Held", bucket: "Portfolio", watch: { priceAtAdd: 10, targetBuyPrice: 100, addedBy: "Sam" } },
];
const prices = { AAA: 80, BBB: 55, CCC: 20, DDD: 5 };

describe("watchlist plan", () => {
  it("lists watchlist names only, the ones down the most since added first", () => {
    const rows = watchRows(stocks, prices);
    expect(rows.map((r) => r.ticker)).toEqual(["AAA", "BBB", "CCC"]);
    expect(rows[0]).toMatchObject({ sinceAddPct: -20, aboveTargetPct: -5.88, atTarget: true });
    expect(rows[1]).toMatchObject({ sinceAddPct: 10, aboveTargetPct: 37.5, atTarget: false });
    expect(rows[2]).toMatchObject({ sinceAddPct: null, aboveTargetPct: null, atTarget: false });
  });

  it("a missing price or a missing target never reads as 'at target'", () => {
    const rows = watchRows(stocks, { AAA: null });
    expect(rows.every((r) => !r.atTarget)).toBe(true);
  });

  it("alerts: target reached (medium) and newly on 2+ lists (low), keyed per name per month", () => {
    const alerts = watchAlerts(watchRows(stocks, prices), { BBB: { count: 2, joined: ["RBC US Focus"] }, CCC: { count: 1, joined: ["FS Top"] } }, "2026-11");
    expect(alerts.map((a) => `${a.rule}:${a.ticker}:${a.priority}`)).toEqual(["target-reached:AAA:medium", "new-on-lists:BBB:low"]);
    expect(alerts[0].dedupeKey).toBe("watchlist-target-AAA-2026-11");
  });

  it("offers names already used as 'added by', most used first", () => {
    expect(addedByOptions(stocks)).toEqual(["Jordan", "Sam"]);
  });
});
