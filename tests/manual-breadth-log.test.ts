import { describe, expect, it } from "vitest";
import { breadthAsOfDate, breadthTypedFor, mergeBreadthSnapshot } from "@/app/lib/forward-looking";

// Late November is Eastern Standard Time (UTC-5).
const est = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`);
const stamp = (date: string, time: string) => est(date, time).toISOString();

describe("breadthAsOfDate — nobody sets the date", () => {
  it("is the most recent market close", () => {
    expect(breadthAsOfDate({}, est("2026-11-24", "09:30"))).toEqual({ date: "2026-11-23", explicit: false }); // Tue morning → Mon close
    expect(breadthAsOfDate({}, est("2026-11-24", "16:45"))).toEqual({ date: "2026-11-24", explicit: false }); // after the close → today
    expect(breadthAsOfDate({}, est("2026-11-23", "08:10"))).toEqual({ date: "2026-11-20", explicit: false }); // Mon morning → Fri close
    expect(breadthAsOfDate(null, est("2026-11-27", "10:00"))).toEqual({ date: "2026-11-25", explicit: false }); // day after Thanksgiving
  });
  it("ignores whatever date the form happens to hold", () => {
    expect(breadthAsOfDate({ date: "2026-11-10" }, est("2026-11-24", "09:30")).date).toBe("2026-11-23");
  });
  it("honours a catch-up date only on the day it was chosen", () => {
    const o = { manualDate: "2026-11-18", manualDateSetOn: "2026-11-24" };
    expect(breadthAsOfDate(o, est("2026-11-24", "11:00"))).toEqual({ date: "2026-11-18", explicit: true });
    expect(breadthAsOfDate(o, est("2026-11-25", "11:00"))).toEqual({ date: "2026-11-24", explicit: false }); // expired
  });
  it("refuses a malformed or future catch-up date", () => {
    expect(breadthAsOfDate({ manualDate: "11/18/2026", manualDateSetOn: "2026-11-24" }, est("2026-11-24", "11:00")).explicit).toBe(false);
    expect(breadthAsOfDate({ manualDate: "2026-12-05", manualDateSetOn: "2026-11-24" }, est("2026-11-24", "11:00")).explicit).toBe(false);
  });
});

describe("breadthTypedFor — only numbers typed for this close are logged under it", () => {
  const now = est("2026-11-25", "09:30"); // Wed morning → the close being entered is Tue Nov 24
  const asOf = { date: "2026-11-24", explicit: false };
  it("keeps numbers typed since that close, drops boxes still holding older ones", () => {
    const got = breadthTypedFor({ above200: 55.1, above50: 41.8, editedAt: { above200: stamp("2026-11-25", "09:20"), above50: stamp("2026-11-24", "09:10") } }, asOf, now);
    expect(got).toEqual({ date: "2026-11-24", above200: 55.1 }); // above50 was typed for Monday's close
  });
  it("a number typed the evening before, after that close, belongs to it too", () => {
    const got = breadthTypedFor({ above200: 55.1, editedAt: { above200: stamp("2026-11-24", "18:30") } }, asOf, now);
    expect(got).toEqual({ date: "2026-11-24", above200: 55.1 });
  });
  it("takes every number when the tab sent no stamps at all", () => {
    expect(breadthTypedFor({ above200: 55.1, above50: 41.8 }, asOf, now)).toEqual({ date: "2026-11-24", above200: 55.1, above50: 41.8 });
  });
  it("for a catch-up date, counts what was typed today", () => {
    const got = breadthTypedFor({ above200: 60, above50: 50, editedAt: { above200: stamp("2026-11-25", "09:25"), above50: stamp("2026-11-20", "09:00") } }, { date: "2026-11-18", explicit: true }, now);
    expect(got).toEqual({ date: "2026-11-18", above200: 60 });
  });
});

describe("mergeBreadthSnapshot — earlier closes are not rewritten", () => {
  const onFile = { date: "2026-11-20", above200: 54.2, above50: null };
  it("the close being entered can be corrected", () => {
    expect(mergeBreadthSnapshot({ ...onFile, above50: 41.8 }, { date: "2026-11-20", above200: 54.4, above50: null }, true)).toMatchObject({ above200: 54.4, above50: 41.8 });
  });
  it("an earlier close keeps its numbers and can only gain missing ones", () => {
    const got = mergeBreadthSnapshot(onFile, { date: "2026-11-20", above200: 51.0, above50: 41.8 }, false);
    expect(got.above200).toBe(54.2);
    expect(got.above50).toBe(41.8);
  });
  it("a reading with no numbers erases nothing, either way", () => {
    const full = { date: "2026-11-20", above200: 54.2, above50: 41.8 };
    for (const canCorrect of [true, false]) expect(mergeBreadthSnapshot(full, { date: "2026-11-20", above200: null, above50: null }, canCorrect)).toMatchObject({ above200: 54.2, above50: 41.8 });
  });
});
