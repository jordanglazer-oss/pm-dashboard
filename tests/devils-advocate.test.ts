import { describe, expect, it } from "vitest";
import {
  buildDaEmail,
  buildFactsBlock,
  daKey,
  firstMondayOf,
  heldStocks,
  isDueOn,
  normaliseAnswer,
  orderResults,
  reviewMonthFor,
  startDateFor,
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

  it("covers the individual stocks only — not Core, not Managed Alpha, not a zero weight", () => {
    expect(heldStocks(models, stocks).map((x) => x.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(heldStocks(null, stocks)).toEqual([]);
  });

  it("the model's own bucket wins over the stock list", () => {
    const tagged = { groups: [group("pim", [h("XIC", 0.9), h("AAPL", 0.05, { bucket: "thematic" }), h("MSFT", 0.05)])] } as unknown as PimModelData;
    expect(heldStocks(tagged, stocks).map((x) => x.symbol)).toEqual(["MSFT"]);
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
    expect(e.subject).toBe("Devil's advocate ready — 2026-12-07 review (2 stocks)");
    expect(e.text.indexOf("NVDA — WOULD NOT BUY TODAY")).toBeLessThan(e.text.indexOf("MSFT — WOULD BUY TODAY"));
    expect(e.text).toContain("1 would not buy today · 0 hold, would not add · 1 would buy today.");
    expect(e.text).toContain("NVDA point one");
    expect(e.text).not.toContain("two");
  });
});
