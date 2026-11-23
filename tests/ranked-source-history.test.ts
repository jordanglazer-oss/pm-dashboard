import { describe, expect, it } from "vitest";
import { mergeRankedHistory, trackingFor, type RankedHistory } from "@/app/lib/ranked-source-history";
import { rankResearch } from "@/app/lib/research-ranked";

const research = (o: Record<string, string[]>) => rankResearch(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((ticker) => ({ ticker }))])) as never, []);

describe("ranked-source history", () => {
  it("first run records a baseline, not 'new'", () => {
    const rows = research({ fundstratTop: ["AAPL", "MSFT"], rbcUsFocus: ["AAPL"], jpmUsAnalystFocus: ["AAPL"] });
    const { next } = mergeRankedHistory(null, rows, "2026-11-22");
    expect(next.startedAt).toBe("2026-11-22");
    expect(next.tickers.AAPL.lists.fundstratTop).toEqual([{ from: "2026-11-22", baseline: true }]);
    expect(next.tickers.AAPL.top).toEqual([{ from: "2026-11-22", baseline: true }]);
    expect(next.tickers.MSFT.top).toEqual([]);
    const tr = trackingFor(next, rows.find((r) => r.key === "AAPL")!, "2026-11-23");
    expect(tr.newOn).toEqual([]);
    expect(tr.sinceIsBaseline).toBe(true);
  });

  it("a later appearance opens a span today; a drop closes it today; earlier spans are untouched", () => {
    const d1 = mergeRankedHistory(null, research({ fundstratTop: ["AAPL", "MSFT", "NVDA", "AMD"] }), "2026-11-20").next;
    const rows2 = research({ fundstratTop: ["AAPL", "NVDA", "AMD", "TSLA"], rbcUsFocus: ["TSLA"], jpmUsAnalystFocus: ["TSLA"] });
    const d2 = mergeRankedHistory(d1, rows2, "2026-11-24").next;
    expect(d2.tickers.MSFT.lists.fundstratTop).toEqual([{ from: "2026-11-20", baseline: true, to: "2026-11-24" }]);
    expect(d2.tickers.AAPL.lists.fundstratTop).toEqual(d1.tickers.AAPL.lists.fundstratTop);
    expect(d2.tickers.TSLA.lists.fundstratTop).toEqual([{ from: "2026-11-24" }]);
    expect(d2.tickers.TSLA.top).toEqual([{ from: "2026-11-24" }]);
    const tr = trackingFor(d2, rows2.find((r) => r.key === "TSLA")!, "2026-11-26");
    expect([...tr.newOn].sort()).toEqual(["fundstratTop", "jpmUsAnalystFocus", "rbcUsFocus"]);
    expect(tr.topSince).toBe("2026-11-24");
    expect(trackingFor(d2, rows2.find((r) => r.key === "TSLA")!, "2026-12-10").newOn).toEqual([]);
    // Unchanged input → nothing changes.
    expect(mergeRankedHistory(d2, rows2, "2026-11-25").changed).toBe(0);
  });

  it("a name returning later gets a NEW span; one dropped and re-added the same day is re-opened", () => {
    const a = mergeRankedHistory(null, research({ fundstratTop: ["AAPL", "MSFT"] }), "2026-11-01").next;
    const b = mergeRankedHistory(a, research({ fundstratTop: ["AAPL"] }), "2026-11-05").next;
    const same = mergeRankedHistory(b, research({ fundstratTop: ["AAPL", "MSFT"] }), "2026-11-05").next;
    expect(same.tickers.MSFT.lists.fundstratTop).toEqual([{ from: "2026-11-01", baseline: true }]);
    const later = mergeRankedHistory(b, research({ fundstratTop: ["AAPL", "MSFT"] }), "2026-11-12").next;
    expect(later.tickers.MSFT.lists.fundstratTop).toEqual([{ from: "2026-11-01", baseline: true, to: "2026-11-05" }, { from: "2026-11-12" }]);
  });

  it("a list that comes back empty with 3+ open names closes nothing", () => {
    const a = mergeRankedHistory(null, research({ fundstratTop: ["A", "B", "C"], rbcUsFocus: ["A"] }), "2026-11-01").next;
    const frozen: RankedHistory = JSON.parse(JSON.stringify(a));
    const b = mergeRankedHistory(a, research({ rbcUsFocus: ["A"] }), "2026-11-02");
    expect(b.next.tickers.B.lists.fundstratTop).toEqual([{ from: "2026-11-01", baseline: true }]);
    expect(b.changed).toBe(0);
    expect(a).toEqual(frozen); // input never mutated
  });
});
