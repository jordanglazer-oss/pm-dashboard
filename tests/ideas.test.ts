import { describe, expect, it } from "vitest";
import { buildIdeas } from "@/app/lib/ideas";
import type { RankedRow } from "@/app/lib/research-ranked";

const row = (ticker: string, lists: string[], held?: "Portfolio" | "Watchlist"): RankedRow => ({ key: ticker, ticker, name: ticker, sector: "Tech", currency: "USD", listCount: lists.length, lists: lists.map((s) => ({ key: "alphaPicks", label: s, short: s, railKey: "x" })), bearish: [], held });
const base = { history: null, pinned: [], today: "2026-11-26", dropAfterDays: 90 };

describe("Ideas — one list", () => {
  it("merges list names, the watchlist and suggested names, with source tags", () => {
    const ideas = buildIdeas({ ...base, ranked: [row("AAA", ["FS Top", "JPM Focus"])], watchlist: [{ ticker: "AAA", name: "Alpha" }, { ticker: "BBB" }], suggested: [{ ticker: "CCC" }] });
    const a = ideas.find((i) => i.key === "AAA")!;
    expect(a.sources).toEqual(["Watchlist", "FS Top", "JPM Focus"]);
    expect(a.listCount).toBe(2);
    expect(ideas.map((i) => i.key).sort()).toEqual(["AAA", "BBB", "CCC"]);
  });
  it("a name we own is not an idea", () => {
    expect(buildIdeas({ ...base, ranked: [row("OWN", ["FS Top"], "Portfolio")], watchlist: [], suggested: [] })).toEqual([]);
  });
  it("off every list for over 90 days leaves the active view, unless pinned", () => {
    const wl = [{ ticker: "OLD", watch: { addedOn: "2026-06-01" } }, { ticker: "NEW", watch: { addedOn: "2026-11-01" } }];
    const ideas = buildIdeas({ ...base, ranked: [], watchlist: wl, suggested: [] });
    expect(ideas.find((i) => i.key === "OLD")!.stale).toBe(true);
    expect(ideas.find((i) => i.key === "NEW")!.stale).toBe(false);
    expect(buildIdeas({ ...base, pinned: ["OLD"], ranked: [], watchlist: wl, suggested: [] }).find((i) => i.key === "OLD")!.stale).toBe(false);
  });
  it("a name with no date on file is never dropped on a guess", () => {
    expect(buildIdeas({ ...base, ranked: [], watchlist: [{ ticker: "NODATE" }], suggested: [] })[0].stale).toBe(false);
  });
});
