import { describe, expect, it } from "vitest";
import { STRATEGIST_SOURCES, fundstratKey, latestRead, reportsFor, resolveStance, sourceOf, stanceBucket, strategistRollup, unmatchedReports } from "@/app/lib/strategist-sources";
import type { StrategistReport } from "@/app/lib/strategist-reports";

const rep = (over: Partial<StrategistReport> & { id: string }): StrategistReport => ({
  date: "2026-11-20",
  receivedAt: "2026-11-20T15:00:00Z",
  firm: "Other",
  kind: "strategy",
  title: "Weekly",
  subject: "",
  source: "pdf",
  chars: 1000,
  ...over,
});
const withStance = (stance: string) => ({ stance, bullets: ["a"], full: [], levels: [], fx: [], topics: [], model: "m", at: "2026-11-20T15:00:00Z" });

describe("Strategist stance — read from the report's own wording", () => {
  it("maps the usual words to three buckets", () => {
    expect(stanceBucket("Constructive into year-end")).toBe("Positive");
    expect(stanceBucket("Bullish")).toBe("Positive");
    expect(stanceBucket("Overweight equities")).toBe("Positive");
    expect(stanceBucket("Cautious near term")).toBe("Negative");
    expect(stanceBucket("Defensive positioning")).toBe("Negative");
    expect(stanceBucket("Neutral")).toBe("Neutral");
    expect(stanceBucket("Mixed signals, range-bound")).toBe("Neutral");
  });
  it("the first stance word decides", () => {
    expect(stanceBucket("Cautious near term, constructive into year-end")).toBe("Negative");
    expect(stanceBucket("Constructive, though cautious on small caps")).toBe("Positive");
  });
  it("unclear or missing wording is not guessed", () => {
    expect(stanceBucket("")).toBeNull();
    expect(stanceBucket(undefined)).toBeNull();
    expect(stanceBucket("No overall stance stated")).toBeNull();
    expect(stanceBucket("Watching the Fed")).toBeNull();
    expect(stanceBucket("Buyback season")).toBeNull(); // "buy" only as a whole word
  });
  it("a hand-set stance wins and is marked", () => {
    expect(resolveStance("Cautious", "r1", { r1: { stance: "Positive", at: "x" } })).toEqual({ stance: "Positive", byHand: true });
    expect(resolveStance("Cautious", "r2", { r1: { stance: "Positive", at: "x" } })).toEqual({ stance: "Negative", byHand: false });
  });
});

describe("Strategist sources — which card a report lands on", () => {
  const sluymer = rep({ id: "s1", firm: "RBC", kind: "technical", author: "Robert Sluymer", title: "Chart book" });
  const rbcFx = rep({ id: "f1", firm: "RBC", kind: "fx", title: "Monthly forecast update" });
  const cemb = rep({ id: "c1", firm: "JPM", title: "Eye on the Market" });
  const flows = rep({ id: "j1", firm: "JPM", title: "Flows & Liquidity", author: "Nikolaos Panigirtzoglou" });
  const sia = rep({ id: "a1", firm: "Other", firmName: "SIA", title: "SIA Equity Action Call" });
  const newtonNote = rep({ id: "2026-11-20-fundstrat-newton", firm: "Fundstrat", kind: "technical", author: "Mark Newton", source: "note" });
  const bca = rep({ id: "b1", firm: "Other", firmName: "BCA Research", title: "2027 outlook" });
  const all = [sluymer, rbcFx, cemb, flows, sia, newtonNote, bca];

  it("matches by firm, type, author or title", () => {
    expect(sourceOf(sluymer)?.id).toBe("sluymer");
    expect(sourceOf(rbcFx)?.id).toBe("rbc-fx");
    expect(sourceOf(cemb)?.id).toBe("cembalest");
    expect(sourceOf(sia)?.id).toBe("sia-action");
    expect(sourceOf(newtonNote)?.id).toBe("newton");
  });
  it("a report that fits no source is kept as unmatched, not dropped", () => {
    expect(sourceOf(flows)).toBeNull();
    expect(sourceOf(bca)).toBeNull();
    expect(unmatchedReports(all).map((r) => r.id).sort()).toEqual(["b1", "j1"]);
  });
  it("lists a source's reports newest first", () => {
    const older = rep({ id: "s0", firm: "RBC", kind: "technical", date: "2026-11-01" });
    const src = STRATEGIST_SOURCES.find((s) => s.id === "sluymer")!;
    expect(reportsFor(src, [older, sluymer]).map((r) => r.id)).toEqual(["s1", "s0"]);
  });
  it("there are no economists and every source has a group", () => {
    expect(STRATEGIST_SOURCES.every((s) => s.group === "strategists" || s.group === "technicals")).toBe(true);
    expect(STRATEGIST_SOURCES.map((s) => s.id)).toEqual(["lee", "cembalest", "timmer", "rbc-strategist", "sia-action", "rbc-fx", "newton", "sluymer"]);
  });
  it("Newton and Lee read from the Fundstrat view, under the note's own id", () => {
    const src = STRATEGIST_SOURCES.find((s) => s.id === "newton")!;
    expect(latestRead(src, [], { newton: { stance: "neutral", date: "2026-11-25" } })).toEqual({ stanceText: "neutral", date: "2026-11-25", key: fundstratKey("newton", "2026-11-25") });
    expect(latestRead(src, [newtonNote], {})).toBeNull(); // an archived note alone carries no summary
  });
});

describe("Strategist roll-up — the Market Brief lines", () => {
  const fundstrat = { newton: { stance: "neutral", date: "2026-11-25" }, lee: { stance: "constructive", date: "2026-11-24" } };
  it("names each read when there are three or fewer", () => {
    const sluymer = rep({ id: "s1", firm: "RBC", kind: "technical", date: "2026-11-21", summary: withStance("Positive on the trend") });
    const tech = strategistRollup(STRATEGIST_SOURCES, [sluymer], {}, fundstrat).find((g) => g.group === "technicals")!;
    expect(tech.line).toBe("Newton neutral, Sluymer positive");
    expect(tech.total).toBe(2);
    expect(tech.newest).toBe("2026-11-25");
    expect(tech.counts).toEqual({ Positive: 1, Neutral: 1, Negative: 0, notStated: 0 });
  });
  it("counts when there are more than three", () => {
    const reports = [
      rep({ id: "c1", firm: "JPM", title: "Eye on the Market", summary: withStance("Constructive") }),
      rep({ id: "r1", firm: "RBC", kind: "strategy", summary: withStance("Bullish") }),
      rep({ id: "f1", firm: "RBC", kind: "fx", summary: withStance("Cautious on the loonie") }),
      rep({ id: "t1", firm: "Other", author: "Jurrien Timmer", summary: withStance("Watching breadth") }),
    ];
    const strat = strategistRollup(STRATEGIST_SOURCES, reports, {}, fundstrat).find((g) => g.group === "strategists")!;
    expect(strat.total).toBe(5);
    expect(strat.counts).toEqual({ Positive: 3, Neutral: 0, Negative: 1, notStated: 1 });
    expect(strat.line).toBe("Mostly positive (3 of 5)");
  });
  it("a hand-set stance changes the count", () => {
    const sluymer = rep({ id: "s1", firm: "RBC", kind: "technical", summary: withStance("Positive") });
    const tech = strategistRollup(STRATEGIST_SOURCES, [sluymer], { s1: { stance: "Negative", at: "x" } }, {}).find((g) => g.group === "technicals")!;
    expect(tech.line).toBe("Sluymer negative");
  });
  it("says so when nothing is on file", () => {
    expect(strategistRollup(STRATEGIST_SOURCES, [], {}, {}).map((g) => g.line)).toEqual(["no data yet", "no data yet"]);
  });
});
