import { describe, expect, it } from "vitest";
import { checkSeries, isDailyUpdatedSeries } from "@/app/lib/health-report";
import type { PimPerformanceData } from "@/app/lib/pim-types";

const groups = [
  { id: "pim", profiles: { balanced: {}, growth: {}, allEquity: {} } },
  { id: "pc-usa", profiles: { balanced: {}, growth: {}, allEquity: {} } },
];
const h = (last: string) => [{ date: "2026-05-07", value: 100, dailyReturn: 0 }, { date: last, value: 101, dailyReturn: 1 }];

describe("health check: performance series", () => {
  it("only judges series the daily update maintains", () => {
    expect(isDailyUpdatedSeries({ groupId: "pim", profile: "core", history: h("2026-11-20") }, groups)).toBe(true);
    expect(isDailyUpdatedSeries({ groupId: "pim", profile: "balanced", history: h("2026-11-20") }, groups)).toBe(true);
    expect(isDailyUpdatedSeries({ groupId: "pc-usa", profile: "balanced", history: h("2026-11-20") }, groups)).toBe(true);
    expect(isDailyUpdatedSeries({ groupId: "pc-usa", profile: "core-balanced", history: h("2026-05-08") }, groups)).toBe(false);
    expect(isDailyUpdatedSeries({ groupId: "pc-usa", profile: "core", history: h("2026-05-08") }, groups)).toBe(false);
    expect(isDailyUpdatedSeries({ groupId: "gone", profile: "balanced", history: h("2026-05-08") }, groups)).toBe(false);
  });

  it("is green when only untracked legacy series are stale, red when a tracked one is", () => {
    const now = new Date("2026-11-23T14:00:00Z"); // Monday morning ET → expects Fri 2026-11-20
    const perf = {
      models: [
        { groupId: "pim", profile: "balanced", history: h("2026-11-20") },
        { groupId: "pc-usa", profile: "core-balanced", history: h("2026-05-08") },
      ],
    } as unknown as PimPerformanceData;
    expect(checkSeries(perf, now, groups)[0].status).toBe("green");
    // models unreadable → every series is judged
    expect(checkSeries(perf, now, null)[0].status).toBe("red");
    const stale = { models: [...perf.models, { groupId: "pc-usa", profile: "growth", history: h("2026-05-08") }] } as unknown as PimPerformanceData;
    expect(checkSeries(stale, now, groups)[0].status).toBe("red");
  });
});
