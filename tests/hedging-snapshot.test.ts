import { describe, expect, it } from "vitest";
import { mergeHedgingSnapshot, snapshotDateFor } from "@/app/lib/hedging-snapshot";

const now = new Date("2026-11-26T21:15:00Z"); // Thursday, 4:15 pm Eastern
const snap = (date: string, spot: number) => ({ date, spotPrice: spot });

describe("Hedging history — filing a snapshot", () => {
  it("is dated by the day the prices are from, not the day they were fetched", () => {
    expect(snapshotDateFor({ quotesAsOfDate: "2026-11-24" })).toBe("2026-11-24");
  });

  it("adds an earlier day when it is missing", () => {
    const r = mergeHedgingSnapshot([snap("2026-11-20", 700)], snap("2026-11-24", 715), now);
    expect(r.wrote).toBe(true);
    expect(r.snapshots.map((s) => s.date)).toEqual(["2026-11-20", "2026-11-24"]);
  });

  it("never replaces an earlier day already on file", () => {
    const prior = [snap("2026-11-24", 714)];
    const r = mergeHedgingSnapshot(prior, snap("2026-11-24", 999), now);
    expect(r.wrote).toBe(false);
    expect(r.snapshots).toBe(prior);
  });

  it("replaces today's entry with a newer reading", () => {
    const r = mergeHedgingSnapshot([snap("2026-11-24", 714), snap("2026-11-26", 716)], snap("2026-11-26", 717), now);
    expect(r.wrote).toBe(true);
    expect(r.snapshots).toEqual([snap("2026-11-24", 714), snap("2026-11-26", 717)]);
  });

  it("keeps the list in date order", () => {
    const r = mergeHedgingSnapshot([snap("2026-11-20", 700), snap("2026-11-25", 716)], snap("2026-11-24", 715), now);
    expect(r.snapshots.map((s) => s.date)).toEqual(["2026-11-20", "2026-11-24", "2026-11-25"]);
  });
});
