import { describe, expect, it } from "vitest";
import {
  compositeFrom, currentRevisionContribution, LEVEL_MAX, LIST_COUNTRY, shadowAnalystConsensus, shadowResearchMentions, shadowRevision, sizeBucket, summarise, type ListDef,
} from "@/app/lib/scoring-shadow";
import { SOURCES } from "@/app/lib/research-mentions";
import { MAX_SCORE } from "@/app/lib/types";
import type { TickerSnapshot } from "@/app/lib/analyst-snapshots";

const LISTS: ListDef[] = SOURCES.map((l) => ({ source: l.source, direction: l.direction }));

describe("revisions as a share of the panel", () => {
  it("the same share scores the same whatever the panel size", () => {
    // 10 of 40 up vs 2 of 8 up: both 25% of the panel.
    expect(shadowRevision(10, 0, 40)!.contribution).toBe(1);
    expect(shadowRevision(2, 0, 8)!.contribution).toBe(1);
    // Today's raw-count rule treats them differently.
    expect(currentRevisionContribution(10)).toBe(1);
    expect(currentRevisionContribution(2)).toBe(0.5);
  });
  it("a big panel with a handful of revisions no longer earns the full point", () => {
    // 4 net up of 45 analysts = 9%: under the half-point line.
    expect(currentRevisionContribution(4)).toBe(1);
    expect(shadowRevision(4, 0, 45)!.contribution).toBe(0);
    expect(shadowRevision(5, 0, 45)!.contribution).toBe(0.5); // 11%
  });
  it("is symmetric, and a tiny panel is capped at a half point", () => {
    expect(shadowRevision(0, 5, 10)!.contribution).toBe(-1);
    expect(shadowRevision(3, 0, 3)!.contribution).toBe(0.5);
    expect(shadowRevision(0, 2, 2)!.contribution).toBe(-0.5);
    expect(shadowRevision(3, 3, 20)!.contribution).toBe(0);
  });
  it("no revisions on file → null (absent is not bearish); no analyst count → today's rule, flagged", () => {
    expect(shadowRevision(undefined, undefined, 20)).toBeNull();
    const r = shadowRevision(4, 0, undefined)!;
    expect(r.contribution).toBe(1);
    expect(r.basis).toMatch(/raw count/);
  });
  it("revisions outnumbering the estimate count cannot exceed a full point", () => {
    expect(shadowRevision(30, 0, 12)!.share).toBe(1);
    expect(shadowRevision(30, 0, 12)!.contribution).toBe(1);
  });
});

describe("analyst consensus with a missing report as no data", () => {
  const snap = (o: Partial<TickerSnapshot>): TickerSnapshot => o as TickerSnapshot;
  it("two Outperforms + 25% upside = the full level, as today", () => {
    const c = shadowAnalystConsensus(snap({ rbc: { rating: "outperform" }, jpm: { rating: "outperform" }, factset: { averageTarget: 125 } } as never), 100);
    expect(c.level!.rescaled).toBeCloseTo(LEVEL_MAX, 9);
    expect(c.score).toBe(2.25);
  });
  it("one Outperform and nothing else on file is rescaled, not marked down for the gaps", () => {
    const c = shadowAnalystConsensus(snap({ rbc: { rating: "outperform" } } as never), 100);
    expect(c.level).toMatchObject({ onFile: ["RBC rating"], missing: ["JPM rating", "Street target"], earned: 0.75, outOf: 0.75 });
    expect(c.score).toBe(2.25);
  });
  it("a real Underperform still counts against the name", () => {
    const c = shadowAnalystConsensus(snap({ rbc: { rating: "underperform" }, jpm: { rating: "not-covered" }, factset: { averageTarget: 130 } } as never), 100);
    expect(c.level!.onFile).toEqual(["RBC rating", "Street target"]);
    expect(c.score).toBe(1.13); // (0 + 0.75) / 1.5 × 2.25 = 1.125 → 1.13
  });
  it("nothing on file at all → null, so the category leaves the composite", () => {
    expect(shadowAnalystConsensus(undefined, 100).score).toBeNull();
    expect(shadowAnalystConsensus(snap({ factset: { revUp: 9, revDown: 0, analystCount: 10 } } as never), 100).score).toBeNull();
  });
  it("revisions and Morningstar stars still modify the level, held to 0–3", () => {
    const c = shadowAnalystConsensus(snap({ rbc: { rating: "outperform" }, jpm: { rating: "outperform" }, factset: { averageTarget: 140, revUp: 8, revDown: 0, analystCount: 20 }, morningstar: { stars: 5 } } as never), 100);
    expect(c.score).toBe(3);
    const d = shadowAnalystConsensus(snap({ rbc: { rating: "neutral" }, factset: { revUp: 0, revDown: 6, analystCount: 12 }, morningstar: { stars: 1 } } as never), 100);
    expect(d.score).toBe(0); // 1.125 − 1 − 0.5 → held at 0
  });
});

describe("research mentions vs eligible lists", () => {
  it("every list has a market, and the bullish count is 9 US / 5 Canadian", () => {
    for (const l of LISTS) expect(LIST_COUNTRY[l.source]).toMatch(/^(US|CA)$/);
    const bull = LISTS.filter((l) => l.direction === "bullish");
    expect(bull.filter((l) => LIST_COUNTRY[l.source] === "US")).toHaveLength(9);
    expect(bull.filter((l) => LIST_COUNTRY[l.source] === "CA")).toHaveLength(5);
  });
  it("a US name scores exactly as today", () => {
    expect(shadowResearchMentions("US", ["upticks"], LISTS).score).toBe(1);
    expect(shadowResearchMentions("US", ["upticks", "fundstrat-top", "rbc-us-focus"], LISTS).score).toBe(3);
    expect(shadowResearchMentions("US", ["upticks", "fundstrat-bottom"], LISTS).score).toBe(0);
    expect(shadowResearchMentions("US", [], LISTS).score).toBe(0);
  });
  it("a Canadian name is measured against 5 lists, not 14", () => {
    const one = shadowResearchMentions("CA", ["rbc-focus"], LISTS);
    expect(one).toMatchObject({ eligibleBullish: 5, referenceBullish: 9, multiplier: 1.8, score: 1.8 });
    expect(shadowResearchMentions("CA", ["rbc-focus", "veritas-vlist"], LISTS).score).toBe(3);
    expect(shadowResearchMentions("CA", [], LISTS).score).toBe(0);
  });
  it("an interlisted Canadian name on a US list: that list becomes one it could be on", () => {
    const r = shadowResearchMentions("CA", ["rbc-focus", "fundstrat-top"], LISTS);
    expect(r.eligibleBullish).toBe(6);
    expect(r.multiplier).toBe(1.5);
    expect(r.score).toBe(3);
  });
  it("a bearish list still subtracts", () => {
    expect(shadowResearchMentions("CA", ["rbc-focus", "fundstrat-bottom"], LISTS).score).toBe(0.8);
  });
});

describe("composite", () => {
  const full = { brand: 0 } as Record<string, number>;
  it("rescales over the categories that apply (the live composite's rule)", () => {
    const scores = { analystConsensus: 3, researchMentions: 3, growth: 3, returnsMargins: 2, ownershipTrends: 2 };
    const all = compositeFrom(scores, []);
    expect(all.effectiveMax).toBe(MAX_SCORE);
    expect(all.composite).toBe(13);
    const noOwn = compositeFrom(scores, ["ownershipTrends"]);
    expect(noOwn.effectiveMax).toBe(MAX_SCORE - 2);
    expect(noOwn.composite).toBe(Math.round(11 * (MAX_SCORE / (MAX_SCORE - 2)) * 10) / 10);
    expect(compositeFrom(full, []).composite).toBe(0);
  });
  it("dropping a category with no data raises a name that was carrying a zero for it", () => {
    const scores = { analystConsensus: 0, growth: 3, returnsMargins: 2, relativeValuation: 3 };
    expect(compositeFrom(scores, ["analystConsensus"]).composite).toBeGreaterThan(compositeFrom(scores, []).composite);
  });
});

describe("summary", () => {
  it("size buckets", () => {
    expect(sizeBucket(3_000_000)).toBe("Mega (≥ 200B)");
    expect(sizeBucket(50_000)).toBe("Large (10–200B)");
    expect(sizeBucket(5_000)).toBe("Mid (2–10B)");
    expect(sizeBucket(900)).toBe("Small (< 2B)");
    expect(sizeBucket(undefined)).toBe("Size unknown");
  });
  it("averages the shift per group", () => {
    const rows = [{ c: "US", current: 20, shadow: 20 }, { c: "US", current: 22, shadow: 21 }, { c: "Canada", current: 18, shadow: 20 }];
    const s = summarise(rows, (r) => r.c, ["US", "Canada"]);
    expect(s[0]).toMatchObject({ label: "US", names: 2, avgShift: -0.5, up: 0, down: 1 });
    expect(s[1]).toMatchObject({ label: "Canada", names: 1, avgShift: 2, up: 1, down: 0 });
  });
});
