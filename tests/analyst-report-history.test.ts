import { describe, expect, it } from "vitest";
import {
  FULL_DETAIL_KEEP,
  MAX_PER_SOURCE,
  changeBetween,
  entryFromReport,
  mergeReportEntry,
  mergeReports,
  reportHistoryKey,
} from "@/app/lib/analyst-report-history";
import type { ReportMeta } from "@/app/lib/analyst-snapshots";

const meta = (hash: string, asOf: string, over: Partial<ReportMeta["extracted"]> = {}): ReportMeta => ({
  id: "AAPL-rbc",
  label: `${asOf} note`,
  uploadedAt: `${asOf}T12:00:00.000Z`,
  extractedAt: `${asOf}T12:00:00.000Z`,
  hash,
  extracted: { rating: "outperform", target: 200, targetCurrency: "USD", asOf, thesis: ["a", "b"], risks: ["r"], ...over },
});

describe("analyst report history", () => {
  it("keys by canonical ticker", () => {
    expect(reportHistoryKey("aapl")).toBe("pm:analyst-report-history:AAPL");
  });

  it("builds a compact entry with the text kept as detail", () => {
    const e = entryFromReport(meta("h1", "2026-10-01", { valuationBasis: "20x FY27 EPS" }), "2026-11-23T00:00:00.000Z", 180);
    expect(e).toMatchObject({ hash: "h1", asOf: "2026-10-01", rating: "outperform", target: 200, targetCurrency: "USD", priceAtReport: 180, valuationBasis: "20x FY27 EPS" });
    expect(e.detail?.thesis).toEqual(["a", "b"]);
  });

  it("skips the same PDF and a re-sent copy with identical facts", () => {
    const first = mergeReportEntry([], entryFromReport(meta("h1", "2026-10-01"), "t"));
    expect(first.added).toBe(true);
    expect(mergeReportEntry(first.list, entryFromReport(meta("h1", "2026-10-01"), "t")).added).toBe(false);
    expect(mergeReportEntry(first.list, entryFromReport(meta("h2", "2026-10-01"), "t")).added).toBe(false);
    // Same date but a different target is a different report.
    expect(mergeReportEntry(first.list, entryFromReport(meta("h3", "2026-10-01", { target: 210 }), "t")).added).toBe(true);
  });

  it("keeps oldest → newest even when an older report arrives later (backfill)", () => {
    let list = mergeReportEntry([], entryFromReport(meta("new", "2026-11-01"), "t")).list;
    list = mergeReportEntry(list, entryFromReport(meta("old", "2026-08-01"), "t")).list;
    expect(list.map((e) => e.hash)).toEqual(["old", "new"]);
  });

  it("keeps full text only on the newest reports and caps the list", () => {
    let list: ReturnType<typeof mergeReportEntry>["list"] = [];
    for (let i = 0; i < MAX_PER_SOURCE + 5; i++) {
      const d = new Date(Date.UTC(2020, 0, 1 + i * 7)).toISOString().slice(0, 10);
      list = mergeReportEntry(list, entryFromReport(meta(`h${i}`, d, { target: 100 + i }), "t")).list;
    }
    expect(list).toHaveLength(MAX_PER_SOURCE);
    expect(list[list.length - 1].hash).toBe(`h${MAX_PER_SOURCE + 4}`);
    expect(list.filter((e) => e.detail).length).toBe(FULL_DETAIL_KEEP);
    expect(list.slice(-FULL_DETAIL_KEEP).every((e) => e.detail)).toBe(true);
    // Compact facts survive on the older entries.
    expect(list[0].target).toBeDefined();
    expect(list[0].rating).toBe("outperform");
  });

  it("records the replaced report and the new one; ignores junk", () => {
    const { history, added } = mergeReports(
      {},
      [
        { source: "rbc", meta: meta("old", "2026-08-01") },
        { source: "rbc", meta: meta("new", "2026-11-01", { rating: "neutral", target: 150 }) },
        { source: "rbc", meta: { nope: true } as unknown as ReportMeta },
      ],
      "2026-11-23T00:00:00.000Z",
    );
    expect(added).toBe(2);
    expect(history.rbc?.map((e) => e.hash)).toEqual(["old", "new"]);
  });

  it("describes what changed between two reports", () => {
    const a = entryFromReport(meta("a", "2026-08-01", { valuationBasis: "20x" }), "t");
    const b = entryFromReport(meta("b", "2026-11-01", { rating: "neutral", target: 150, valuationBasis: "15x" }), "t");
    expect(changeBetween(a, b)).toEqual({ rating: { from: "outperform", to: "neutral" }, targetPct: -25, valuationBasisChanged: true });
    // Different currencies: no target % (not comparable).
    const c = entryFromReport(meta("c", "2026-12-01", { targetCurrency: "CAD", target: 210 }), "t");
    expect(changeBetween(b, c).targetPct).toBeUndefined();
  });
});
