import { describe, expect, it } from "vitest";
import { parseReportSubject } from "@/app/lib/strategist-reports";
import { classifySubject } from "@/app/lib/inbox-dispatch";

describe("parseReportSubject", () => {
  it("reads kind, firm and title", () => {
    expect(parseReportSubject("Strategy: RBC – Calvasina weekly")).toMatchObject({ kind: "strategy", firm: "RBC", title: "Calvasina weekly" });
    expect(parseReportSubject("Technical: JPM - chart book 2026-11-20")).toMatchObject({ kind: "technical", firm: "JPM", date: "2026-11-20" });
    expect(parseReportSubject("FX: J.P. Morgan – FX markets weekly")).toMatchObject({ kind: "fx", firm: "JPM" });
    expect(parseReportSubject("Currency: RBC Capital Markets: monthly forecasts")).toMatchObject({ kind: "fx", firm: "RBC", title: "monthly forecasts" });
  });
  it("files anything else under Other, with the firm when named", () => {
    expect(parseReportSubject("Strategy: Other – BCA Research – 2027 outlook")).toMatchObject({ firm: "Other", firmName: "BCA Research" });
    expect(parseReportSubject("Strategy: Yardeni morning briefing")).toMatchObject({ firm: "Other", title: "Yardeni morning briefing" });
  });
  it("does not mistake RBC-prefixed words or other subjects", () => {
    expect(parseReportSubject("Strategy: RBCX note")?.firm).toBe("Other");
    expect(parseReportSubject("Strategist deck")).toBeNull();
    expect(parseReportSubject("FYI: thanks")).toBeNull();
    expect(parseReportSubject("Newton 2026-11-24")).toBeNull();
  });
});

describe("classifySubject", () => {
  it("routes the new report subjects, including forwards", () => {
    expect(classifySubject("FW: Strategy: RBC – weekly")).toBe("strategy-report");
    expect(classifySubject("FX: RBC – monthly forecasts")).toBe("strategy-report");
    expect(classifySubject("Technical: Other – chart pack")).toBe("strategy-report");
  });
  it("leaves the existing conventions alone", () => {
    expect(classifySubject("Strategist note from Newton")).toBe("strategist");
    expect(classifySubject("Newton 2026-11-24")).toBe("newton-note");
    expect(classifySubject("Lee - daily")).toBe("lee-note");
    expect(classifySubject("RBC Canadian Focus List")).toEqual({ kind: "research", source: "rbc-focus" });
    expect(classifySubject("News: AVGO raises guidance")).toBe("street-takeaways");
    expect(classifySubject("SIA weekly")).toBe("sia");
  });
});
