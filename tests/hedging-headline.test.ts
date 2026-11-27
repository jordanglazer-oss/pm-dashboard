import { describe, expect, it } from "vitest";
import { costPct, hedgeHeadline } from "@/app/lib/hedging-headline";

const snap = (date: string, spot: number, otm5: number) => ({ date, spotPrice: spot, quotes: [{ expiry: "2026-12-18", atmPremium: 9, otm5Premium: 3, otm10Premium: 1 }, { expiry: "2027-02-19", atmPremium: 22, otm5Premium: otm5, otm10Premium: 6 }, { expiry: "2027-06-18", atmPremium: 40, otm5Premium: 25, otm10Premium: 15 }] });

describe("Hedging headline — 3-month, 5% out-of-the-money put as % of exposure", () => {
  it("uses the expiry nearest three months out and divides by SPY", () => {
    const c = costPct(snap("2026-11-24", 700, 14), 3, "otm5")!;
    expect(c.expiry).toBe("2027-02-19");
    expect(c.pct).toBeCloseTo(2, 6);
  });
  it("week over week, month over month and the 3-month average", () => {
    const history = [snap("2026-10-23", 700, 21), snap("2026-11-03", 700, 20), snap("2026-11-10", 700, 19), snap("2026-11-17", 700, 17.5), snap("2026-11-20", 700, 16)];
    const h = hedgeHeadline(snap("2026-11-24", 700, 14), history);
    expect(h.pct).toBeCloseTo(2, 6);
    expect(h.weekAgo?.date).toBe("2026-11-17");
    expect(h.weekAgo?.pct).toBeCloseTo(2.5, 6);
    expect(h.monthAgo?.date).toBe("2026-10-23");
    expect(h.avg3m?.days).toBe(5);
    expect(h.vsAvg).toBe("low");
  });
  it("no average from fewer than five saved days, and no figure when the term is not listed", () => {
    expect(hedgeHeadline(snap("2026-11-24", 700, 14), [snap("2026-11-17", 700, 15)]).avg3m).toBeNull();
    expect(costPct({ date: "2026-11-24", spotPrice: 700, quotes: [{ expiry: "2026-12-04", atmPremium: 5, otm5Premium: 1, otm10Premium: 0.3 }] }, 6, "otm5")).toBeNull();
  });
});
