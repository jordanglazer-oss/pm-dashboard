import { describe, expect, it } from "vitest";
import { analystTrend, mergeAnalystHistory } from "@/app/lib/analyst-history";

describe("analyst history", () => {
  it("adds one entry per ticker per day; the first reading of a day wins", () => {
    const a = mergeAnalystHistory({}, { aapl: { target: 250, count: 40, revUp: 5, revDown: 1 } }, "2026-11-19");
    expect(a.added).toBe(1);
    expect(a.next.AAPL).toEqual([{ date: "2026-11-19", target: 250, count: 40, revUp: 5, revDown: 1 }]);
    const b = mergeAnalystHistory(a.next, { AAPL: { target: 999, count: 1 } }, "2026-11-19");
    expect(b.added).toBe(0);
    expect(b.next.AAPL).toEqual(a.next.AAPL);
  });

  it("does not store an unchanged reading, an empty one, or a past-dated one; never rewrites history", () => {
    const prev = { AAPL: [{ date: "2026-11-18", target: 250, count: 40 }] };
    expect(mergeAnalystHistory(prev, { AAPL: { target: 250, count: 40 } }, "2026-11-19").added).toBe(0);
    expect(mergeAnalystHistory(prev, { AAPL: { target: null, count: null, revUp: 3 } }, "2026-11-19").added).toBe(0);
    expect(mergeAnalystHistory(prev, { AAPL: { target: 260, count: 40 } }, "2026-11-17").added).toBe(0);
    const c = mergeAnalystHistory(prev, { AAPL: { target: 260, count: 41 }, MSFT: { target: 500 } }, "2026-11-19");
    expect(c.added).toBe(2);
    expect(c.next.AAPL[0]).toEqual(prev.AAPL[0]);
    expect(prev.AAPL).toHaveLength(1);
  });

  it("reads the log as a trend", () => {
    const entries = [
      { date: "2026-08-01", target: 200, count: 30 },
      { date: "2026-10-10", target: 190, count: 29 },
      { date: "2026-11-10", target: 180, count: 27 },
      { date: "2026-11-19", target: 171, count: 27 },
    ];
    const t = analystTrend(entries, "2026-11-19");
    expect(t.d30).toEqual({ targetPct: -10, count: -2 });
    expect(t.d90).toEqual({ targetPct: -14.5, count: -3 });
    expect(t.targetStreak).toEqual({ direction: "down", changes: 3 });
    expect(analystTrend([], "2026-11-19").latest).toBeNull();
  });
});
