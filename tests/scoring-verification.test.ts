import { describe, expect, it } from "vitest";
import {
  appendVerification, growthArithmetic, parseVerificationInput, pickSpotCheckSet, qualityArithmetic, spotCheckCard, spotCheckCsv, verificationStatus,
  type SpotRow, type VerificationEntry,
} from "@/app/lib/scoring-verification";
import { buildQualityBands, computeQualityScore, deriveQualityInputs, QUALITY_EXPECTATIONS } from "@/app/lib/quality-score";
import { runCalibrationChecks, type CheckRow } from "@/app/lib/score-input-validation";

const entry = (over: Partial<VerificationEntry> = {}): VerificationEntry => ({ id: "a", date: "2026-11-22", at: "2026-11-22T12:00:00.000Z", score: "growth", who: "JG", result: "matched", tickers: ["AAPL", "RY"], notes: "", bandsCalibratedAt: "2026-09-20T00:00:00.000Z", ...over });

describe("verification log (append-only)", () => {
  it("validates the input", () => {
    expect(parseVerificationInput({})).toHaveProperty("error");
    expect(parseVerificationInput({ score: "growth", result: "matched", who: "", tickers: ["A"] })).toHaveProperty("error");
    expect(parseVerificationInput({ score: "growth", result: "matched", who: "JG", tickers: [] })).toHaveProperty("error");
    expect(parseVerificationInput({ score: "growth", result: "mismatched", who: "JG", tickers: ["A"], notes: "" })).toEqual({ error: expect.stringMatching(/mismatch needs a note/) });
    expect(parseVerificationInput({ score: "quality", result: "matched", who: " JG ", tickers: "aapl, ry aapl" })).toEqual({ score: "quality", who: "JG", result: "matched", tickers: ["AAPL", "RY"], notes: "" });
  });

  it("appends, never rewrites, and leaves an unreadable log alone", () => {
    const first = appendVerification(null, entry());
    expect(first).toEqual({ next: { entries: [entry()] } });
    const second = appendVerification({ entries: [entry()], other: 1 }, entry({ id: "b", who: "MD" }));
    expect("next" in second && second.next.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect("next" in second && (second.next as unknown as { other: number }).other).toBe(1); // unknown fields kept
    expect(appendVerification([], entry())).toHaveProperty("error");
    expect(appendVerification({ entries: "x" }, entry())).toHaveProperty("error");
    expect(appendVerification({ entries: [entry()] }, entry())).toHaveProperty("error"); // same id twice
  });

  it("says plainly when nothing is on file, and when a check predates a re-calibration", () => {
    expect(verificationStatus(null, "growth", "x")).toMatchObject({ verified: false, text: expect.stringMatching(/^Not verified/) });
    const log = { entries: [entry(), entry({ id: "q", score: "quality" })] };
    expect(verificationStatus(log, "growth", "2026-09-20T00:00:00.000Z")).toMatchObject({ verified: true, current: true, text: "Last verified 2026-11-22 by JG (2 companies)." });
    expect(verificationStatus(log, "growth", "2027-01-05T00:00:00.000Z")).toMatchObject({ verified: false, current: false, text: expect.stringMatching(/EARLIER calibration/) });
    const bad = { entries: [entry(), entry({ id: "c", result: "mismatched", notes: "RY: LTG 9.1 on the terminal vs 0.091 stored" })] };
    expect(verificationStatus(bad, "growth", "2026-09-20T00:00:00.000Z")).toMatchObject({ verified: false, text: expect.stringMatching(/MISMATCH.*0\.091/) });
  });
});

describe("spot-check set", () => {
  const row = (ticker: string, group: string, over: Partial<SpotRow> = {}): SpotRow => ({ ticker, group, sector: "S", country: "US", raw: { epsLtmA: 2, salesNtm: 110, salesLtmA: 100 }, ...over });
  const rows: SpotRow[] = [
    row("JPM", "Banks"), row("BAC", "Banks"), row("WFC", "Banks"), row("MET", "Insurance"), row("PLD", "REITs / Real Estate"),
    row("RY", "Banks", { country: "CA" }), row("SHOP", "Software", { country: "CA" }), row("CNQ", "Energy", { country: "CA" }), row("ENB", "Energy", { country: "CA" }),
    row("LOSS", "Biotech", { raw: { epsLtmA: -1.2 } }), row("GS", "Capital Markets", { salesBasis: "as-reported" }),
    ...["A", "B", "C", "D", "E"].map((t) => row(`SW${t}`, "Software")), ...["A", "B", "C"].map((t) => row(`IN${t}`, "Industrials")), row("PHA", "Pharma"),
  ];
  const picks = pickSpotCheckSet(rows);

  it("covers the awkward cases and is deterministic", () => {
    const of = (re: RegExp) => picks.filter((p) => re.test(p.why)).map((p) => p.ticker);
    expect(of(/^bank/)).toEqual(["BAC", "JPM"]);
    expect(of(/^insurer/)).toEqual(["MET"]);
    expect(of(/^REIT/)).toEqual(["PLD"]);
    expect(of(/^Canadian/)).toEqual(["CNQ", "ENB", "RY"]);
    expect(of(/^loss-maker/)).toEqual(["LOSS"]);
    expect(of(/as-reported/)).toEqual(["GS"]);
    expect(picks.length).toBeLessThanOrEqual(12);
    expect(new Set(picks.map((p) => p.ticker)).size).toBe(picks.length);
    expect(pickSpotCheckSet([...rows].reverse())).toEqual(picks);
    // Then the largest uncovered groups: Software (6), Industrials (3).
    expect(picks.map((p) => p.group)).toEqual(expect.arrayContaining(["Software", "Industrials"]));
  });

  it("writes the arithmetic out so it can be reproduced by hand", () => {
    const g = growthArithmetic({ salesNtm: 110, salesLtmA: 100, epsNtm: 0.4, epsLtmA: -0.1, ltg: 12, salesAnn0: 100, salesAnn3: 70 }, "Software");
    expect(g[0]).toEqual({ metric: "fwdSales", used: true, text: "(sales next 12m 110.00 − sales last 12m 100.00) ÷ 100.00 = +10.0%" });
    expect(g[1]).toMatchObject({ metric: "fwdEps", used: false, text: expect.stringMatching(/not used — trailing EPS base of -0\.10 is negative/) });
    expect(g[3].text).toMatch(/\(sales 100\.00 ÷ 70\.00 three years earlier\) \^ \(1\/3\) − 1 = \+12\.6%/);
    const bank = growthArithmetic({ epsNtm: 2.3, epsLtmA: 2, ltg: 8, bpsAnn0: 20, bpsAnn3: 15 }, "Banks");
    expect(bank[3].text).toMatch(/book value per share 20\.00 ÷ 15\.00/);
    const q = qualityArithmetic({ roicAnn0: 18, roicAnn2: 15, operMgnLtm0: 22, operMgnLtm8: 25 }, "Software");
    expect(q.find((l) => l.metric === "returnsTrend")).toEqual({ metric: "returnsTrend", used: true, text: "ROIC 18.00% − 15.00% two fiscal years earlier = 3.00 points" });
    expect(qualityArithmetic({ roeAnn0: 9 }, "REITs / Real Estate")).toEqual([{ metric: "all", used: false, text: expect.stringMatching(/^not ranked/) }]);
  });

  it("the CSV has one row per field with a blank column to fill in at the terminal", () => {
    const r = row("JPM", "Banks", { raw: { epsNtm: 18, epsLtmA: 16.5, ltg: 6, bpsAnn0: 110, bpsAnn3: 88 } });
    const csv = spotCheckCsv("growth", [spotCheckCard("growth", r, { ticker: "JPM", group: "Banks", why: "bank, check" })], "2026-09-20T00:00:00.000Z");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/value on the terminal \(fill in\)/);
    expect(lines.find((l) => l.includes("FE_ESTIMATE(EPS,MEAN,NTMA,0,NOW,'')"))).toMatch(/growth,2026-09-20,JPM,Banks,"bank, check","EPS, next 12 months","FE_ESTIMATE\(EPS,MEAN,NTMA,0,NOW,''\)",per share,18,,/);
    expect(lines.some((l) => l.includes("derived: delivered"))).toBe(true);
  });
});

describe("quality (shadow) — the same guards", () => {
  it("out-of-range inputs are dropped through the shared check, never ranked", () => {
    const r = deriveQualityInputs({ roicAnn0: 4000, operMgnLtm0: 20 }, "Software");
    expect(r.inputs.returns).toBeUndefined();
    expect(r.excluded.find((e) => e.metric === "returns")!.reason).toMatch(/believable range/);
  });

  it("unusable bands park the score with the reason", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ group: "Software", sector: "Technology", parked: null, values: { returns: 5 + i, returnsTrend: i - 5, operMargin: 10 + i, marginTrend: i - 6 } }));
    const fresh = buildQualityBands(rows, { calibratedAt: new Date().toISOString(), listVersion: "t" });
    const raw = { roicAnn0: 14, roicAnn2: 12, operMgnLtm0: 18, operMgnLtm8: 17 };
    expect(computeQualityScore({ raw, playbookGroup: "Software", sector: "Technology", bands: fresh }).computedScore).not.toBeNull();
    const failed = { ...fresh, selfChecks: { ranAt: fresh.calibratedAt, passed: false, hardFailures: ["Operating margin (%): do not look like the expected unit"], warnings: [] } };
    const w = computeQualityScore({ raw, playbookGroup: "Software", sector: "Technology", bands: failed });
    expect(w.computedScore).toBeNull();
    expect(w.gapReason).toMatch(/failed their own checks/);
    const stale = { ...fresh, calibratedAt: new Date(Date.now() - 500 * 86_400_000).toISOString() };
    expect(computeQualityScore({ raw, playbookGroup: "Software", sector: "Technology", bands: stale }).gapReason).toMatch(/days old/);
  });

  it("calibration self-checks: return on assets is expected only for banks; a ratio-for-percent pull fails", () => {
    const rows: CheckRow[] = Array.from({ length: 400 }, (_, i) => {
      const bank = i % 8 === 0;
      return { ticker: `Q${i}`, group: bank ? "Banks" : "Software", excluded: [], country: "US", marketCap: 5000 + i, values: bank ? { returns: 8 + (i % 9), returnsTrend: (i % 7) - 3, roa: 0.7 + (i % 10) / 10 } : { returns: 4 + (i % 30), returnsTrend: (i % 9) - 4, operMargin: 6 + (i % 28), marginTrend: (i % 9) - 4 } };
    });
    const ok = runCalibrationChecks({ rows, expectations: QUALITY_EXPECTATIONS, requested: 400, failedChunks: 0, unmatched: [] });
    expect(ok.selfChecks.hardFailures).toEqual([]);
    expect(ok.metrics.roa).toMatchObject({ expected: 50, withValue: 50 });
    expect(ok.metrics.operMargin).toMatchObject({ expected: 350, withValue: 350 });
    const ratio = rows.map((r) => ({ ...r, values: { ...r.values, operMargin: r.values.operMargin == null ? undefined : (r.values.operMargin as number) / 100 } }));
    expect(runCalibrationChecks({ rows: ratio, expectations: QUALITY_EXPECTATIONS, requested: 400, failedChunks: 0, unmatched: [] }).selfChecks.hardFailures.join(" ")).toMatch(/Operating margin \(%\).*expected unit/);
  });
});
