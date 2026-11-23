import { describe, expect, it } from "vitest";
import { reviewFund, shouldFlagFund, monthOf, type FundSnapshot } from "@/app/lib/agents/manager-watch";

const lagging: FundSnapshot = {
  symbol: "ABC100",
  perf: { oneYear: 2, threeYear: 4, fiveYear: 5 },
  categoryPerf: { oneYear: 3, threeYear: 6, fiveYear: 7 },
  dataAsOf: "2026-11-01",
};

describe("Manager Evaluator (monthly)", () => {
  it("names the review period by Eastern month", () => {
    expect(monthOf(new Date("2026-11-23T15:00:00Z"))).toBe("2026-11");
    // 02:00 UTC on Dec 1 is still Nov 30 in New York
    expect(monthOf(new Date("2026-12-01T02:00:00Z"))).toBe("2026-11");
  });

  it("tags each tripped rule with a stable kind", () => {
    const r = reviewFund(lagging, { ...lagging, expenseRatio: 0.8 }, "2026-11-23");
    expect(r.severity).toBe("concern");
    expect(r.kinds).toEqual(["sustained-3y-5y"]);
  });

  it("calls out stale fund data without changing the severity", () => {
    const fresh = reviewFund(lagging, undefined, "2026-11-23");
    const stale = reviewFund({ ...lagging, dataAsOf: "2026-08-01" }, undefined, "2026-11-23");
    expect(stale.severity).toBe(fresh.severity);
    expect(stale.findings.some((f) => f.includes("days old"))).toBe(true);
    expect(fresh.findings.some((f) => f.includes("days old"))).toBe(false);
  });

  it("does not re-flag an unchanged trip mid-quarter", () => {
    const last = reviewFund(lagging, undefined, "2026-10-23");
    const now = reviewFund(lagging, lagging, "2026-11-23");
    expect(shouldFlagFund(now, last, "2026-11")).toBe(false);
  });

  it("flags a new rule, a higher severity, a first review or a quarter's first month", () => {
    const watch = reviewFund({ ...lagging, perf: { ...lagging.perf, fiveYear: 7 } }, undefined, "2026-11-23");
    expect(watch.severity).toBe("watch");
    const concern = reviewFund(lagging, undefined, "2026-11-23");
    expect(shouldFlagFund(concern, watch, "2026-11")).toBe(true); // worse
    const feeUp = reviewFund({ ...lagging, expenseRatio: 1.0 }, { ...lagging, expenseRatio: 0.8 }, "2026-11-23");
    expect(shouldFlagFund(feeUp, concern, "2026-11")).toBe(true); // new rule
    expect(shouldFlagFund(concern, undefined, "2026-11")).toBe(true); // no earlier review
    expect(shouldFlagFund(concern, { ...concern, kinds: undefined }, "2026-11")).toBe(true); // pre-monthly record
    expect(shouldFlagFund(concern, concern, "2027-01")).toBe(true); // quarterly reminder
  });

  it("never flags a fund that passed", () => {
    const ok = reviewFund({ ...lagging, perf: { oneYear: 3, threeYear: 6, fiveYear: 7 } }, undefined, "2026-11-23");
    expect(ok.severity).toBe("ok");
    expect(shouldFlagFund(ok, undefined, "2027-01")).toBe(false);
  });
});
