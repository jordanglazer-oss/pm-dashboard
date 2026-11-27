import { describe, expect, it } from "vitest";
import { cleanPoints, draftFromOnFile, mergeWhy, type WhyStore } from "@/app/lib/why-we-own";

describe("Why we own it", () => {
  it("keeps at most five non-empty points", () => {
    expect(cleanPoints(["a", " ", "b", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("drafts from thesis pillars first, then the fund one-pager", () => {
    expect(draftFromOnFile({ pillars: [{ title: "Cloud", claim: "Growing 25% a year." }] }, null)).toEqual({ points: ["Cloud: Growing 25% a year."], source: "from thesis" });
    expect(draftFromOnFile(null, { whyWeOwn: ["Low cost", "Broad market"] })).toEqual({ points: ["Low cost", "Broad market"], source: "from one-pager" });
    expect(draftFromOnFile(null, null)).toBeNull();
  });
  it("saving keeps the prior version in history and leaves other holdings alone", () => {
    const store: WhyStore = { entries: { AAA: { points: ["old"], status: "draft", source: "written by hand", updatedAt: "2026-11-01T00:00:00Z" }, BBB: { points: ["keep"], status: "approved", source: "written by hand", updatedAt: "2026-11-01T00:00:00Z" } } };
    const next = mergeWhy(store, "aaa", { points: ["new"], status: "approved", source: "written by hand", updatedAt: "2026-11-26T00:00:00Z" });
    expect(next.entries.AAA.points).toEqual(["new"]);
    expect(next.entries.AAA.history?.[0].points).toEqual(["old"]);
    expect(next.entries.BBB).toEqual(store.entries.BBB);
  });
});
