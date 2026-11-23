import { describe, expect, it } from "vitest";
import {
  buildDaEmail,
  buildFactsBlock,
  daAdhocKey,
  daKey,
  DA_PREFIX,
  firstMondayOf,
  heldHoldings,
  heldStocks,
  isDueOn,
  normaliseAnswer,
  orderResults,
  reviewMonthFor,
  startDateFor,
  withAdhocHistory,
  type DaAdhocRecord,
  type DaResult,
} from "@/app/lib/agents/devils-advocate-shared";
import type { PimModelData } from "@/app/lib/pim-types";
import { group, h, stock } from "./helpers";

describe("devil's advocate — dates", () => {
  it("finds the first Monday of a month", () => {
    expect(firstMondayOf("2026-12")).toBe("2026-12-07");
    expect(firstMondayOf("2026-11")).toBe("2026-11-02");
    expect(firstMondayOf("2027-02")).toBe("2027-02-01"); // the 1st is a Monday
    expect(firstMondayOf("2027-03")).toBe("2027-03-01");
    expect(firstMondayOf("2026-06")).toBe("2026-06-01");
    expect(firstMondayOf("2027-01")).toBe("2027-01-04");
  });

  it("prepares for the first Monday that is today or still to come", () => {
    expect(reviewMonthFor("2026-11-22")).toBe("2026-12");
    expect(reviewMonthFor("2026-12-07")).toBe("2026-12"); // review day itself
    expect(reviewMonthFor("2026-12-08")).toBe("2027-01");
    expect(reviewMonthFor("2026-12-31")).toBe("2027-01");
    expect(reviewMonthFor("2026-11-01")).toBe("2026-11");
  });

  it("starts the Wednesday before the first Monday and stops after the review", () => {
    expect(startDateFor("2026-12")).toBe("2026-12-02");
    expect(new Date("2026-12-02T12:00:00Z").getUTCDay()).toBe(3); // a Wednesday
    expect(startDateFor("2027-02")).toBe("2027-01-27"); // crosses the month boundary
    expect(isDueOn("2026-12-01").due).toBe(false);
    expect(isDueOn("2026-12-02")).toMatchObject({ due: true, month: "2026-12", reviewOn: "2026-12-07" });
    expect(isDueOn("2026-12-07").due).toBe(true);
    expect(isDueOn("2026-12-08").due).toBe(false);
    expect(isDueOn("2027-01-27")).toMatchObject({ due: true, month: "2027-02" });
  });
});

describe("devil's advocate — who is covered and in what order", () => {
  const stocks = [stock("AAPL"), stock("MSFT"), stock("XIC", { instrumentType: "etf", designation: "core" }), stock("GRNJ", { instrumentType: "mutual-fund", designation: "thematic" })];
  const models = { groups: [group("pim", [h("XIC", 0.86), h("AAPL", 0.02), h("MSFT", 0.02), h("GRNJ", 0.1), h("ZERO", 0)])] } as unknown as PimModelData;

  it("covers the individual stocks AND the Managed Alpha funds — not Core, not a zero weight", () => {
    expect(heldHoldings(models, stocks).map((x) => `${x.symbol}:${x.kind}`)).toEqual(["AAPL:stock", "MSFT:stock", "GRNJ:fund"]);
    expect(heldStocks(models, stocks).map((x) => x.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(heldHoldings(null, stocks)).toEqual([]);
  });

  it("leaves out bonds and alternatives (anything that is not equity), even when tagged Managed Alpha", () => {
    const mixed = {
      groups: [group("pim", [h("XIC", 0.88), h("AAPL", 0.02), h("GRNJ", 0.1), h("XBB", 1, { assetClass: "fixedIncome" }), h("GOLD", 1, { assetClass: "alternative", bucket: "thematic" })])],
    } as unknown as PimModelData;
    expect(heldHoldings(mixed, stocks).map((x) => x.symbol)).toEqual(["AAPL", "GRNJ"]);
  });

  it("the model's own bucket wins over the stock list", () => {
    const tagged = { groups: [group("pim", [h("XIC", 0.9), h("AAPL", 0.05, { bucket: "thematic" }), h("MSFT", 0.05), h("GRNJ", 0.0, { bucket: "core" })])] } as unknown as PimModelData;
    expect(heldHoldings(tagged, stocks).map((x) => `${x.symbol}:${x.kind}`)).toEqual(["AAPL:fund", "MSFT:stock"]);
    const coreTagged = { groups: [group("pim", [h("XIC", 0.9), h("GRNJ", 0.1, { bucket: "core" })])] } as unknown as PimModelData;
    expect(heldHoldings(coreTagged, stocks)).toEqual([]);
  });

  it("orders 'would not buy today' first, then hold, then would buy; ties by ticker", () => {
    const list = [
      { ticker: "MSFT", verdict: "would buy today" as const },
      { ticker: "NVDA", verdict: "would not buy today" as const },
      { ticker: "AAPL", verdict: "hold, would not add" as const },
      { ticker: "AMZN", verdict: "would not buy today" as const },
    ];
    expect(orderResults(list).map((x) => x.ticker)).toEqual(["AMZN", "NVDA", "AAPL", "MSFT"]);
    expect(list[0].ticker).toBe("MSFT"); // input untouched
  });

  it("keys one entry per stock per month", () => {
    expect(daKey("2026-12", "aapl")).toBe("pm:agent-run:devils-advocate:2026-12:AAPL");
  });
});

describe("devil's advocate — on demand, for a name we do not hold", () => {
  const rec = (at: string, verdict: DaResult["verdict"]): DaResult => ({
    ticker: "SHOP", kind: "stock", month: at.slice(0, 7), at, verdict, strongestCaseAgainst: ["p"], whatWouldChangeMind: "", weakestPillar: "",
    confidence: "medium", onFile: { thesis: false, pillars: 0, alerts: 0, previews: 0, analystHistory: 0, scoreHistory: 0 }, model: "m", usd: 0.03,
  });

  it("uses its own key, which the monthly record's scan can never match", () => {
    expect(daAdhocKey("shop")).toBe("pm:agent-run:devils-advocate-adhoc:SHOP");
    // The monthly reader scans `${DA_PREFIX}<month>:*`.
    expect(daAdhocKey("shop").startsWith(DA_PREFIX)).toBe(false);
    expect(daKey("2026-12", "shop").startsWith("pm:agent-run:devils-advocate-adhoc:")).toBe(false);
  });

  it("keeps the latest on top and at most three earlier ones, newest first", () => {
    const first = withAdhocHistory(null, rec("2026-11-01T10:00:00Z", "would buy today"));
    expect(first).toMatchObject({ adhoc: true, at: "2026-11-01T10:00:00Z" });
    expect(first.history).toBeUndefined();

    let cur: DaAdhocRecord = first;
    for (const d of ["02", "03", "04", "05"]) cur = withAdhocHistory(cur, rec(`2026-11-${d}T10:00:00Z`, "hold, would not add"));
    expect(cur.at).toBe("2026-11-05T10:00:00Z");
    expect(cur.history!.map((x) => x.at.slice(0, 10))).toEqual(["2026-11-04", "2026-11-03", "2026-11-02"]);
    // History entries are plain write-ups: no nested history, no adhoc flag.
    expect(cur.history!.every((x) => !("history" in x) && !("adhoc" in x))).toBe(true);
    expect(first.history).toBeUndefined(); // the earlier record was not changed
  });

  it("frames a name we do not own as a candidate, not a position", () => {
    const b = buildFactsBlock({ ticker: "SHOP", name: "Shopify", held: false, thesis: null });
    expect(b).toContain("=== CANDIDATE (a stock we do NOT own — a pre-buy read) ===");
    expect(b).toContain("NONE ON FILE — no thesis has been signed for this name.");
    expect(b).not.toContain("we hold this stock");
    expect(b).not.toContain("% of PIM equity");
  });
});

describe("devil's advocate — a Managed Alpha fund", () => {
  it("is argued from the one-pager, the record vs its category and the manager watch", () => {
    const b = buildFactsBlock({
      ticker: "FID5982",
      name: "Fidelity Global Innovators",
      kind: "fund",
      weightInClass: 0.1,
      heldSince: "2026-10-21",
      fund: {
        onePager: {
          signedOn: "2026-11-10", headline: "Concentrated global growth", whyWeOwn: ["Manager's long record", "Fills a gap in Core"], manager: "Fidelity — Mark Schmehl — 2017",
          philosophy: "Change-driven growth", process: "Bottom-up", role: "Global growth satellite", record: "Ahead of category over 5 years", fees: "MER 1.1%", risks: ["High turnover"], watch: "Two years behind category",
        },
        data: { category: "Global Equity", expenseRatio: 1.1, starRating: 4, perf: { oneYear: 12, threeYear: 8.5, fiveYear: 11 }, categoryPerf: { oneYear: 15, threeYear: 9, fiveYear: 9.5 } },
        managerReview: { quarter: "2026-Q4", severity: "watch", findings: ["Behind its category by 3 pts over the last year"], read: "One weak year." },
      },
    });
    expect(b).toContain("=== POSITION (a Managed Alpha fund we own) ===");
    expect(b).toContain("FID5982 (Fidelity Global Innovators), 10.00% of PIM equity, first bought 2026-10-21");
    expect(b).toContain("Signed 2026-11-10");
    expect(b).toContain("- Manager's long record");
    expect(b).toContain("What we said would make us reconsider: Two years behind category");
    expect(b).toContain("1 year: fund 12.0%, category 15.0%, difference -3.0 pts");
    expect(b).toContain("5 years: fund 11.0%, category 9.5%, difference +1.5 pts");
    expect(b).toContain("Fee (MER): 1.1%");
    expect(b).toContain("2026-Q4: watch");
    expect(b).not.toContain("OUR SIGNED THESIS");
    expect(b).not.toContain("FACTSET ALERTS");
  });

  it("says so plainly when nothing is on file for the fund", () => {
    const b = buildFactsBlock({ ticker: "GRNJ", kind: "fund", fund: { onePager: null, data: null, managerReview: null } });
    expect(b).toContain("NONE ON FILE — we hold this fund with no signed one-pager.");
    expect(b.match(/Nothing on file\./g)).toHaveLength(2); // the record and the manager watch
    expect(b).not.toContain("1 year:");
  });

  it("a missing figure reads n/a, never a made-up zero", () => {
    const b = buildFactsBlock({ ticker: "GRNJ", kind: "fund", fund: { data: { category: "US Small/Mid Cap Equity", perf: { oneYear: -4 } } } });
    expect(b).toContain("1 year: fund -4.0%, category n/a, difference n/a");
    expect(b).toContain("3 years: fund n/a, category n/a, difference n/a");
  });
});

describe("devil's advocate — what the model is given and what is kept", () => {
  it("says so plainly when there is no thesis and nothing on file", () => {
    const b = buildFactsBlock({ ticker: "AAPL", name: "Apple", weightInClass: 0.0182, thesis: null });
    expect(b).toContain("AAPL (Apple), 1.82% of PIM equity");
    expect(b).toContain("NONE ON FILE — we hold this stock with no signed thesis.");
    expect(b.match(/Nothing on file\./g)).toHaveLength(4);
  });

  it("carries pillar statuses, tripped breakers and the dated facts", () => {
    const b = buildFactsBlock({
      ticker: "MSFT",
      heldSince: "2026-10-21",
      thesis: {
        why: "Cloud share gains",
        signedOn: "2026-10-01",
        pillars: [{ title: "Cloud growth", claim: "Azure grows 30%+", status: "watch", statusSince: "2026-11-01", statusNote: "Growth slowed to 27%" }, { title: "Margins", claim: "Stable" }],
        breakers: ["Cloud growth: Azure below 25% — TRIPPED 2026-11-05"],
      },
      alerts: "2026-10-29 Q1 results: revenue beat",
      analyst: ["Change over 30 days: mean target -6%, analyst count -2."],
      scoreTrend: ["2026-09-01: 24 of 33"],
    });
    expect(b).toContain("first bought 2026-10-21");
    expect(b).toContain('Pillar "Cloud growth": Azure grows 30%+ [status: watch since 2026-11-01 — Growth slowed to 27%]');
    expect(b).toContain('Pillar "Margins": Stable [status: not assessed]');
    expect(b).toContain("TRIPPED 2026-11-05");
    expect(b).toContain("2026-10-29 Q1 results: revenue beat");
    expect(b).toContain("mean target -6%");
    expect(b).toContain("context only — do not lean on it");
    expect(b.match(/Nothing on file\./g)).toHaveLength(1); // only the earnings preview is empty
  });

  it("accepts a well-formed answer and refuses an unusable one", () => {
    const ok = normaliseAnswer({ verdict: "Would not buy today", strongestCaseAgainst: ["a", "b", "c", "d", "e", "f"], whatWouldChangeMind: "x", weakestPillar: "y", confidence: "HIGH" });
    expect(ok).toMatchObject({ verdict: "would not buy today", confidence: "high" });
    expect(ok!.strongestCaseAgainst).toHaveLength(5);
    expect(normaliseAnswer({ verdict: "hold", strongestCaseAgainst: ["a"] })).toMatchObject({ verdict: "hold, would not add", confidence: "medium" });
    expect(normaliseAnswer({ verdict: "sell", strongestCaseAgainst: ["a"] })).toBeNull();
    expect(normaliseAnswer({ verdict: "would buy today", strongestCaseAgainst: [] })).toBeNull();
    expect(normaliseAnswer("nope")).toBeNull();
  });

  it("writes the review email with the hardest verdicts first", () => {
    const r = (ticker: string, verdict: DaResult["verdict"]): DaResult => ({
      ticker, month: "2026-12", at: "2026-12-02T22:00:00Z", verdict, strongestCaseAgainst: [`${ticker} point one`, "two"], whatWouldChangeMind: "", weakestPillar: "Margins",
      confidence: "medium", onFile: { thesis: true, pillars: 3, alerts: 2, previews: 0, analystHistory: 1, scoreHistory: 0 }, model: "m", usd: 0.03,
    });
    const e = buildDaEmail("2026-12-07", [r("MSFT", "would buy today"), r("NVDA", "would not buy today")]);
    expect(e.subject).toBe("Devil's advocate ready — 2026-12-07 review (2 holdings)");
    expect(e.text.indexOf("NVDA — WOULD NOT BUY TODAY")).toBeLessThan(e.text.indexOf("MSFT — WOULD BUY TODAY"));
    expect(e.text).toContain("1 would not buy today · 0 hold, would not add · 1 would buy today.");
    expect(e.text).toContain("NVDA point one");
    expect(e.text).not.toContain("two");
    const withFund = buildDaEmail("2026-12-07", [{ ...r("GRNJ", "hold, would not add"), kind: "fund" }]);
    expect(withFund.text).toContain("GRNJ (fund) — HOLD, WOULD NOT ADD");
    expect(withFund.text).toContain("Weakest point: Margins");
  });
});
