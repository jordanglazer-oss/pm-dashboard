import { describe, expect, it } from "vitest";
import { breadthTypedOn, mergeBreadthSnapshot, planManualBreadth } from "@/app/lib/forward-looking";

const TODAY = "2026-11-25";
const at = (day: string) => `${day}T15:00:00.000Z`; // 10 am Eastern on that day
const row = (date: string, above200: number, loggedOn?: string) => ({ date, above200, above50: null, ...(loggedOn ? { loggedOn } : {}) });

describe("breadthTypedOn — only numbers typed today are logged today", () => {
  it("drops boxes that still hold an earlier day's number", () => {
    const got = breadthTypedOn({ date: "2026-11-24", above200: 55.1, above50: 41.8, editedAt: { above200: at(TODAY), above50: at("2026-11-24") } }, TODAY);
    expect(got).toEqual({ date: "2026-11-24", above200: 55.1 });
  });
  it("takes every number when the tab sent no stamps at all", () => {
    expect(breadthTypedOn({ date: TODAY, above200: 55.1, above50: 41.8 }, TODAY)).toEqual({ date: TODAY, above200: 55.1, above50: 41.8 });
  });
  it("a date change alone carries no numbers", () => {
    expect(breadthTypedOn({ date: TODAY, above200: 55.1, editedAt: { above200: at("2026-11-24") } }, TODAY)).toEqual({ date: TODAY });
  });
});

describe("planManualBreadth — which date a saved entry is filed under", () => {
  it("logs nothing without a number", () => {
    expect(planManualBreadth([], { date: TODAY }, TODAY)).toBeNull();
    expect(planManualBreadth([], null, TODAY)).toBeNull();
  });
  it("files a fresh entry under its own as-of date", () => {
    const p = planManualBreadth([], { date: "2026-11-24", above200: 54.2 }, TODAY)!;
    expect(p.date).toBe("2026-11-24");
    expect(p.advanced).toBe(false);
    expect(p.snapshot.source).toBe("manual");
  });
  it("uses today when the date is missing, malformed or in the future", () => {
    expect(planManualBreadth([], { above200: 54.2 }, TODAY)!.date).toBe(TODAY);
    expect(planManualBreadth([], { date: "11/24/2026", above200: 54.2 }, TODAY)!.date).toBe(TODAY);
    expect(planManualBreadth([], { date: "2026-12-01", above200: 54.2 }, TODAY)!.date).toBe(TODAY);
  });
  it("a new day's numbers under an un-advanced date go under TODAY, so yesterday's row survives", () => {
    const history = [row("2026-11-23", 54.2, "2026-11-24")]; // as of the 23rd, typed on the 24th
    const p = planManualBreadth(history, { date: "2026-11-23", above200: 51.0 }, TODAY)!;
    expect(p.date).toBe(TODAY);
    expect(p.advanced).toBe(true);
  });
  it("a same-day correction stays on its date", () => {
    const history = [row("2026-11-24", 54.2, TODAY)]; // typed earlier today
    const p = planManualBreadth(history, { date: "2026-11-24", above200: 54.4 }, TODAY)!;
    expect(p.date).toBe("2026-11-24");
    expect(p.advanced).toBe(false);
  });
  it("re-saving the same numbers never moves the date", () => {
    const history = [row("2026-11-23", 54.2, "2026-11-24")];
    expect(planManualBreadth(history, { date: "2026-11-23", above200: 54.2 }, TODAY)!.advanced).toBe(false);
  });
  it("a row from before 'loggedOn' existed is treated as logged the day after its date", () => {
    expect(planManualBreadth([row("2026-11-20", 54.2)], { date: "2026-11-20", above200: 50.0 }, TODAY)!.advanced).toBe(true); // logged the 21st → earlier day
    expect(planManualBreadth([row("2026-11-24", 54.2)], { date: "2026-11-24", above200: 50.0 }, TODAY)!.advanced).toBe(false); // logged "today"
  });
});

describe("mergeBreadthSnapshot — history is not rewritten", () => {
  const prevDay = { date: "2026-11-20", above200: 54.2, above50: null, loggedOn: "2026-11-21" };
  it("a row logged on an earlier day keeps its numbers and can only gain missing ones", () => {
    const got = mergeBreadthSnapshot(prevDay, { date: "2026-11-20", above200: 51.0, above50: 41.8 }, TODAY);
    expect(got.above200).toBe(54.2); // frozen
    expect(got.above50).toBe(41.8); // an empty field can still be filled
    expect(got.loggedOn).toBe("2026-11-21");
  });
  it("a row logged today can be corrected", () => {
    const today = { date: "2026-11-24", above200: 54.2, above50: 41.8, loggedOn: TODAY };
    expect(mergeBreadthSnapshot(today, { date: "2026-11-24", above200: 54.4, above50: null }, TODAY)).toMatchObject({ above200: 54.4, above50: 41.8 });
  });
  it("a reading with no numbers erases nothing", () => {
    const today = { date: "2026-11-24", above200: 54.2, above50: 41.8, loggedOn: TODAY };
    expect(mergeBreadthSnapshot(today, { date: "2026-11-24", above200: null, above50: null }, TODAY)).toMatchObject({ above200: 54.2, above50: 41.8 });
  });
});
