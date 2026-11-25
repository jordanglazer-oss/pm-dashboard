import { describe, expect, it } from "vitest";
import { findDistributions, parseFundFeed, returnSinceDate, totalReturnIndex, ytdReturn, isFundCode, bareFundCode, type NavPoint } from "@/app/lib/fund-nav";
import { mergeFundLog } from "@/app/lib/fund-nav-log";

// A fund at 10.00 that earns nothing, then pays 0.50 on Jan 28: the plain NAV
// drops to 9.50; the adjusted series scales every earlier day by 9.5 / 10.
const plain: NavPoint[] = [
  { date: "2025-12-31", nav: 10 },
  { date: "2026-01-27", nav: 10 },
  { date: "2026-01-28", nav: 9.5 },
  { date: "2026-01-29", nav: 9.69 }, // +2% the day after
];
const adjusted: NavPoint[] = [
  { date: "2025-12-31", nav: 9.5 },
  { date: "2026-01-27", nav: 9.5 },
  { date: "2026-01-28", nav: 9.5 },
  { date: "2026-01-29", nav: 9.69 },
];

describe("fund distributions", () => {
  it("finds the distribution day and its size", () => {
    const d = findDistributions(plain, adjusted);
    expect(d).toHaveLength(1);
    expect(d[0].date).toBe("2026-01-28");
    expect(d[0].perUnit).toBeCloseTo(0.5, 4);
    expect(d[0].pctOfNav).toBeCloseTo(5.2632, 3); // 0.50 on a 9.50 NAV
  });
  it("finds none when the two series move together", () => {
    expect(findDistributions(plain, plain)).toEqual([]);
  });
});

describe("fund returns", () => {
  it("plain NAV understates; the adjusted series and our own rebuild agree", () => {
    expect(ytdReturn(plain)).toBeCloseTo(-3.1, 6); // what the dashboard used to record
    expect(ytdReturn(adjusted)).toBeCloseTo(2, 6); // the true return: +2%
    const ours = totalReturnIndex(plain, findDistributions(plain, adjusted));
    expect(ytdReturn(ours)).toBeCloseTo(2, 4);
  });
  it("does not invent a return for a period the series does not reach", () => {
    expect(returnSinceDate(adjusted, "2024-01-01")).toBeNull();
    expect(returnSinceDate(adjusted, "2026-01-27")).toBeCloseTo(2, 6);
  });
});

describe("feed parsing and codes", () => {
  it("reads both date formats, skips junk, sorts ascending", () => {
    const rows = parseFundFeed("FID5982.CF,2026-11-23,0,0,0,67.4441,0\nFID5982.CF,11/20/2026,0,0,0,65.4049,0\nbad line\nFID5982.CF,2026-11-19,0,0,0,abc,0");
    expect(rows).toEqual([{ date: "2026-11-20", nav: 65.4049 }, { date: "2026-11-23", nav: 67.4441 }]);
  });
  it("recognises fund codes", () => {
    expect(isFundCode("FID5982")).toBe(true);
    expect(isFundCode("FID5982-T")).toBe(true);
    expect(isFundCode("XIU-T")).toBe(false);
    expect(isFundCode("NVDA")).toBe(false);
    expect(bareFundCode("fid5982-t")).toBe("FID5982");
  });
});

describe("the log only adds", () => {
  const now = "2026-11-24T22:00:00.000Z";
  it("seeds, then adds new days and never rewrites one on file", () => {
    const first = mergeFundLog(undefined, plain.slice(0, 3), findDistributions(plain.slice(0, 3), adjusted.slice(0, 3)), now);
    expect(first.navAdded).toBe(3);
    expect(first.distributionsAdded.map((d) => d.date)).toEqual(["2026-01-28"]);

    // Next run: one new day, and the feed now reports a DIFFERENT value for a day already on file.
    const restated = [{ date: "2026-01-27", nav: 9.99 }, ...plain.slice(2)];
    const second = mergeFundLog(first.next, restated, [], "2026-11-25T22:00:00.000Z");
    expect(second.navAdded).toBe(1);
    expect(second.changedUpstream).toBe(1);
    expect(second.next.nav.find(([d]) => d === "2026-01-27")?.[1]).toBe(10); // ours stands
    expect(second.next.dists).toHaveLength(1); // nothing removed
    expect(second.next.firstLoggedAt).toBe(now);
  });
  it("does not log the same distribution twice", () => {
    const d = findDistributions(plain, adjusted);
    const first = mergeFundLog(undefined, plain, d, now);
    const again = mergeFundLog(first.next, plain, d, now);
    expect(again.distributionsAdded).toEqual([]);
    expect(again.navAdded).toBe(0);
  });
});
