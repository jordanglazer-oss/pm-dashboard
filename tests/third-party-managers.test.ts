import { describe, expect, it } from "vitest";
import {
  HISTORY_KEEP,
  mergeManager,
  missingSeeds,
  nextScreenDue,
  parseStore,
  sanitizeScreen,
  screenStatus,
  setStatus,
  toleranceFlag,
  trailingYears,
  upsertScreen,
  yearsOnList,
  type Manager,
  type ManagerScreen,
} from "@/app/lib/third-party-managers";

const NOW = "2026-11-26T22:00:00.000Z";
const screen = (date: string, onList = true): ManagerScreen => ({ date, onList, enteredAt: NOW });
const base = (over: Partial<Manager> = {}): Manager => ({ id: "abc", manager: "A Manager", firm: "Firm", fundName: "Fund", fundCode: "ABC123", category: "Global equity", goAnywhere: false, status: "Owned", screens: [], annual: [], updatedAt: NOW, ...over });
const yr = (year: number, fund: number, index: number) => ({ year, fund, index });

describe("Third-Party Managers — years trailing the index", () => {
  it("counts back from the newest year and stops at the first year ahead", () => {
    expect(trailingYears({ annual: [yr(2022, 12, 10), yr(2023, 5, 8), yr(2024, 3, 9), yr(2025, 1, 4)] })).toBe(3);
    expect(trailingYears({ annual: [yr(2024, 3, 9), yr(2025, 10, 4)] })).toBe(0);
  });
  it("a missing year ends the run", () => {
    expect(trailingYears({ annual: [yr(2022, 1, 5), yr(2024, 1, 5), yr(2025, 1, 5)] })).toBe(2);
  });
  it("matching the index is not trailing it", () => {
    expect(trailingYears({ annual: [yr(2025, 6, 6)] })).toBe(0);
  });
  it("nothing entered is zero, never a flag", () => {
    expect(trailingYears({})).toBe(0);
    expect(toleranceFlag(base()).flagged).toBe(false);
  });
});

describe("Third-Party Managers — tolerance flag", () => {
  it("is not raised after one year behind", () => {
    expect(toleranceFlag(base({ annual: [yr(2025, 1, 4)] }))).toEqual({ flagged: false, years: 1 });
  });
  it("is raised for an owned manager after two years behind", () => {
    expect(toleranceFlag(base({ annual: [yr(2024, 2, 6), yr(2025, 1, 4)] }))).toEqual({ flagged: true, years: 2 });
  });
  it("stays raised at three", () => {
    expect(toleranceFlag(base({ annual: [yr(2023, 0, 3), yr(2024, 2, 6), yr(2025, 1, 4)] }))).toEqual({ flagged: true, years: 3 });
  });
  it("is only for managers we own", () => {
    const annual = [yr(2024, 2, 6), yr(2025, 1, 4)];
    expect(toleranceFlag(base({ status: "Watching", annual })).flagged).toBe(false);
    expect(toleranceFlag(base({ status: "Removed", annual })).flagged).toBe(false);
  });
});

describe("Third-Party Managers — years on the list", () => {
  it("two screens make a year; the run counts back from the newest", () => {
    const y = yearsOnList({ screens: [screen("2024-06-30"), screen("2024-12-31"), screen("2025-06-30"), screen("2025-12-31")] });
    expect(y).toEqual({ screens: 4, consecutive: 4, years: 2, since: "2024-06-30" });
  });
  it("a missed screen breaks the run but the total is kept", () => {
    const y = yearsOnList({ screens: [screen("2024-06-30"), screen("2024-12-31", false), screen("2025-06-30"), screen("2025-12-31"), screen("2026-06-30")] });
    expect(y.screens).toBe(4);
    expect(y.consecutive).toBe(3);
    expect(y.years).toBe(1.5);
    expect(y.since).toBe("2025-06-30");
  });
  it("off the newest screen is zero in a row", () => {
    expect(yearsOnList({ screens: [screen("2025-12-31"), screen("2026-06-30", false)] }).consecutive).toBe(0);
  });
  it("order of entry does not matter", () => {
    expect(yearsOnList({ screens: [screen("2026-06-30"), screen("2025-12-31")] }).since).toBe("2025-12-31");
  });
});

describe("Third-Party Managers — when the next screen is due", () => {
  it("picks the Jun 30 / Dec 31 either side of today", () => {
    expect(nextScreenDue("2026-11-26")).toEqual({ last: "2026-06-30", next: "2026-12-31" });
    expect(nextScreenDue("2026-03-01")).toEqual({ last: "2025-12-31", next: "2026-06-30" });
    expect(nextScreenDue("2026-06-30")).toEqual({ last: "2026-06-30", next: "2026-12-31" });
    expect(nextScreenDue("2026-12-31")).toEqual({ last: "2026-12-31", next: "2027-06-30" });
  });
  it("is due when nothing on file is as recent as the last screen date", () => {
    const store = { managers: { abc: base({ screens: [screen("2025-12-31")] }) } };
    expect(screenStatus(store, "2026-11-26")).toEqual({ due: true, last: "2026-06-30", next: "2026-12-31", onFile: "2025-12-31" });
    expect(screenStatus(store, "2026-03-01").due).toBe(false);
  });
  it("is due on an empty list", () => {
    expect(screenStatus({ managers: {} }, "2026-11-26")).toMatchObject({ due: true, onFile: null });
  });
});

describe("Third-Party Managers — saving", () => {
  it("a missing or unreadable store reads as empty and is never seeded", () => {
    expect(parseStore(null)).toEqual({ managers: {} });
    expect(parseStore("not json")).toEqual({ managers: {} });
    expect(parseStore("[]")).toEqual({ managers: {} });
  });
  it("an edit keeps the screens on file and records the prior version", () => {
    const prior = base({ screens: [screen("2025-12-31")], notes: "old" });
    const next = mergeManager({ id: "abc", manager: "A Manager", fundName: "Fund", notes: "new", status: "Watching", screens: [] }, prior, NOW);
    if ("error" in next) throw new Error(next.error);
    expect(next.screens).toEqual(prior.screens);
    expect(next.notes).toBe("new");
    expect(next.status).toBe("Watching");
    expect(next.history).toHaveLength(1);
    expect(next.history![0].notes).toBe("old");
  });
  it("unknown stored fields survive an edit", () => {
    const prior = { ...base(), future: "kept" } as Manager & { future: string };
    const next = mergeManager({ id: "abc", manager: "A Manager" }, prior, NOW) as Manager & { future?: string };
    expect(next.future).toBe("kept");
  });
  it("needs a manager or a fund name", () => {
    expect(mergeManager({ firm: "Firm" }, undefined, NOW)).toHaveProperty("error");
  });
  it("a sector fund is marked as one", () => {
    const m = mergeManager({ fundName: "Energy Fund", category: "Sector", sectorName: "Energy" }, undefined, NOW);
    if ("error" in m) throw new Error(m.error);
    expect(m.sectorFund).toBe(true);
    expect(m.sectorName).toBe("Energy");
  });
  it("a screen for a date on file replaces it; other dates are untouched", () => {
    const m = base({ screens: [screen("2025-12-31"), screen("2026-06-30")] });
    const s = sanitizeScreen({ date: "2026-06-30", onList: false, ret5y: "8.25%", idx5y: 6 }, NOW);
    if ("error" in s) throw new Error(s.error);
    const next = upsertScreen(m, s, NOW);
    expect(next.screens.map((x) => x.date)).toEqual(["2025-12-31", "2026-06-30"]);
    expect(next.screens[1]).toMatchObject({ onList: false, ret5y: 8.25, idx5y: 6 });
    expect(next.screens[0]).toEqual(m.screens[0]);
  });
  it("a screen needs a real date, and blank returns are left out rather than stored as zero", () => {
    expect(sanitizeScreen({ date: "June 30" }, NOW)).toHaveProperty("error");
    const s = sanitizeScreen({ date: "2026-06-30", ret5y: "", idx5y: "abc" }, NOW) as ManagerScreen;
    expect(s.ret5y).toBeUndefined();
    expect(s.idx5y).toBeUndefined();
    expect(s.onList).toBe(true);
  });
  it("history is capped", () => {
    let m = base();
    for (let i = 0; i < HISTORY_KEEP + 4; i++) m = setStatus(m, i % 2 ? "Owned" : "Watching", NOW);
    expect(m.history).toHaveLength(HISTORY_KEEP);
  });
  it("seed entries are offered only where missing", () => {
    const all = missingSeeds({ managers: {} }, NOW);
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.status)).toEqual(["Watching", "Watching", "Owned"]);
    const store = { managers: { [all[0].id]: { ...all[0], notes: "edited" } } };
    const rest = missingSeeds(store, NOW);
    expect(rest).toHaveLength(2);
    expect(rest.some((m) => m.id === all[0].id)).toBe(false);
  });
});
