/**
 * Verification kit for the COMPUTED scores (growth — live; quality — shadow).
 *
 * Code can prove the arithmetic and the internal consistency of a calibration.
 * It CANNOT prove that a FactSet formula returns what its name says. The only
 * proof of that is a person comparing a sample of companies with a FactSet
 * terminal. This file makes that check fast and leaves a record of it:
 *
 *   - `pickSpotCheckSet` chooses ~12 companies that cover the awkward cases
 *     (two banks, an insurer, a REIT, three Canadian names, a loss-maker, a
 *     name measured on as-reported sales, then the largest remaining groups).
 *   - `growthArithmetic` / `qualityArithmetic` write out each derived metric
 *     with the numbers it was built from, so it can be reproduced by hand.
 *   - `pm:scoring-verification` is the APPEND-ONLY record of each check:
 *     `{ entries: [{ id, date, at, score, who, result, tickers, notes, bandsCalibratedAt }] }`.
 *     Written only by POST /api/scoring-verification (one entry appended per
 *     call; nothing is edited or removed). No entry on file means NOT
 *     VERIFIED — the pages say so plainly.
 *
 * Pure except for the key name; the route does the I/O.
 */

import { deriveGrowthInputs, GROWTH_SOURCE_FIELDS, type GrowthMetricKey, type RawGrowthRow } from "./growth-score";
import { deriveQualityInputs, QUALITY_SOURCE_FIELDS, type QualityMetricKey, type RawQualityRow } from "./quality-score";

export const SCORING_VERIFICATION_KEY = "pm:scoring-verification";
export const MAX_VERIFICATIONS = 300;

export type VerifiedScore = "growth" | "quality";
export type VerificationEntry = {
  id: string;
  /** YYYY-MM-DD (server UTC) the check was recorded. */
  date: string;
  at: string;
  score: VerifiedScore;
  who: string;
  result: "matched" | "mismatched";
  tickers: string[];
  notes: string;
  /** Which calibration the check was made against. */
  bandsCalibratedAt: string | null;
};
export type VerificationLog = { entries: VerificationEntry[] };

/** Validate + normalise a POST body. Returns an error string or the entry fields. */
export function parseVerificationInput(body: unknown): { error: string } | { score: VerifiedScore; who: string; result: "matched" | "mismatched"; tickers: string[]; notes: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.score !== "growth" && b.score !== "quality") return { error: "score must be \"growth\" or \"quality\"" };
  if (b.result !== "matched" && b.result !== "mismatched") return { error: "result must be \"matched\" or \"mismatched\"" };
  const who = typeof b.who === "string" ? b.who.trim().slice(0, 60) : "";
  if (!who) return { error: "who checked it is required" };
  const tickers = (Array.isArray(b.tickers) ? b.tickers : typeof b.tickers === "string" ? b.tickers.split(/[\s,]+/) : [])
    .filter((t): t is string => typeof t === "string").map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  if (!tickers.length) return { error: "list at least one company that was checked" };
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 2000) : "";
  if (b.result === "mismatched" && !notes) return { error: "a mismatch needs a note saying which figure differed" };
  return { score: b.score, who, result: b.result, tickers: [...new Set(tickers)], notes };
}

/** Append one entry. Never edits or removes an existing one; an unreadable log is NOT replaced. */
export function appendVerification(prev: unknown, entry: VerificationEntry): { next: VerificationLog } | { error: string } {
  if (prev == null) return { next: { entries: [entry] } };
  const p = prev as Partial<VerificationLog>;
  if (typeof prev !== "object" || Array.isArray(prev) || !Array.isArray(p.entries)) return { error: "the verification log on file has an unexpected shape — left alone" };
  if (p.entries.some((e) => e.id === entry.id)) return { error: "an entry with this id is already on file" };
  return { next: { ...(prev as object), entries: [...p.entries, entry].slice(-MAX_VERIFICATIONS) } };
}

export type VerificationStatus = { verified: boolean; last: VerificationEntry | null; current: boolean; text: string };

/** The latest check for one score, and whether it was made against the bands in use. */
export function verificationStatus(log: unknown, score: VerifiedScore, bandsCalibratedAt: string | null): VerificationStatus {
  const entries = (log && typeof log === "object" && Array.isArray((log as VerificationLog).entries) ? (log as VerificationLog).entries : []).filter((e) => e.score === score);
  const last = entries[entries.length - 1] ?? null;
  if (!last) return { verified: false, last: null, current: false, text: "Not verified: nobody has recorded a spot check of these figures against a FactSet terminal." };
  const current = !!bandsCalibratedAt && last.bandsCalibratedAt === bandsCalibratedAt;
  const base = `${last.result === "matched" ? "Last verified" : "Last check found a MISMATCH"} ${last.date} by ${last.who} (${last.tickers.length} compan${last.tickers.length === 1 ? "y" : "ies"})`;
  return {
    verified: last.result === "matched" && current,
    last, current,
    text: last.result === "mismatched" ? `${base}: ${last.notes}` : current ? `${base}.` : `${base}, against an EARLIER calibration — the bands have been re-calibrated since and have not been re-checked.`,
  };
}

// ── Spot-check set ────────────────────────────────────────────────────────

export type SpotRow = { ticker: string; group: string; sector: string | null; country?: "CA" | "US"; salesBasis?: string | null; raw: Record<string, number | null | undefined> };
export type SpotPick = { ticker: string; group: string; why: string };

const CANADIAN_SUFFIX = /(\.TO|\.V|\.NE|\.CN|-T)$/i;
const isCanadian = (r: SpotRow) => r.country === "CA" || (r.country == null && CANADIAN_SUFFIX.test(r.ticker));

/**
 * ~12 companies that cover the cases most likely to hide an error. Deterministic
 * (alphabetical within each rule) so the same calibration always gives the same set.
 * NOT covered: "a company that just rolled its fiscal year" — fiscal year-end
 * dates are not in the data on file, so pick one by hand (any company that
 * reported its fourth quarter in the last few weeks).
 */
export function pickSpotCheckSet(rows: SpotRow[], size = 12): SpotPick[] {
  const sorted = [...rows].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const picks: SpotPick[] = [];
  const have = new Set<string>();
  const take = (r: SpotRow | undefined, why: string) => { if (r && !have.has(r.ticker)) { have.add(r.ticker); picks.push({ ticker: r.ticker, group: r.group, why }); } };
  const first = (f: (r: SpotRow) => boolean, n: number, why: string) => sorted.filter((r) => f(r) && !have.has(r.ticker)).slice(0, n).forEach((r) => take(r, why));

  first((r) => r.group === "Banks", 2, "bank — ranked on EPS, the long-term estimate and book value (growth) / ROE and ROA (quality)");
  first((r) => r.group === "Insurance", 1, "insurer — sales is not used; book value and ROE are");
  first((r) => r.group === "REITs / Real Estate", 1, "REIT — the EPS measures are dropped (growth) and it is not ranked at all (quality)");
  first(isCanadian, 3, "Canadian listing — check the currency and that FactSet matched the right company");
  first((r) => typeof r.raw.epsLtmA === "number" && r.raw.epsLtmA < 0, 1, "loss-maker — forward EPS growth must read as a data gap, not a number");
  first((r) => typeof r.raw.roicAnn0 === "number" && r.raw.roicAnn0 < 0, 1, "negative returns on capital — must score 0, not rank");
  first((r) => r.salesBasis === "as-reported", 1, "forward sales measured from as-reported trailing sales (the estimates figure was missing) — check both are on the same basis and currency");

  // Then one company from each remaining group, largest groups first.
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.group, (counts.get(r.group) ?? 0) + 1);
  const covered = new Set(picks.map((p) => p.group));
  for (const [g] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (picks.length >= size) break;
    if (covered.has(g)) continue;
    take(sorted.find((r) => r.group === g), `largest uncovered peer group (${counts.get(g)} companies)`);
    covered.add(g);
  }
  return picks;
}

// ── Arithmetic, written out ───────────────────────────────────────────────

const n2 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)) : "missing");
const p1 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

export type ArithmeticLine = { metric: string; used: boolean; text: string };

/** Each growth metric with the numbers it was built from. */
export function growthArithmetic(raw: RawGrowthRow, group: string | null): ArithmeticLine[] {
  const { inputs, excluded, salesBasis } = deriveGrowthInputs(raw, group);
  const why = (m: GrowthMetricKey) => excluded.filter((e) => e.metric === m).map((e) => e.reason).join("; ");
  const base = salesBasis === "as-reported" ? raw.salesLtm : raw.salesLtmA ?? raw.salesLtm;
  const book = inputs.delivered != null && raw.bpsAnn0 != null && raw.bpsAnn3 != null && why("delivered") === "" && group != null && (group === "Banks" || group === "Insurance");
  const line = (m: GrowthMetricKey, formula: string): ArithmeticLine => inputs[m] != null ? { metric: m, used: true, text: `${formula} = ${p1(inputs[m]!)}` } : { metric: m, used: false, text: `not used — ${why(m) || "could not be formed"} (inputs: ${formula})` };
  return [
    line("fwdSales", `(sales next 12m ${n2(raw.salesNtm)} − sales last 12m ${n2(base)}${salesBasis === "as-reported" ? " [as reported]" : ""}) ÷ ${n2(base)}`),
    line("fwdEps", `(EPS next 12m ${n2(raw.epsNtm)} − EPS last 12m ${n2(raw.epsLtmA)}) ÷ ${n2(raw.epsLtmA)}`),
    line("ltg", `long-term growth estimate ${n2(raw.ltg)}% a year, taken as returned`),
    line("delivered", book ? `(book value per share ${n2(raw.bpsAnn0)} ÷ ${n2(raw.bpsAnn3)} three years earlier) ^ (1/3) − 1` : `(sales ${n2(raw.salesAnn0)} ÷ ${n2(raw.salesAnn3)} three years earlier) ^ (1/3) − 1`),
  ];
}

/** Each quality measure with the numbers it was built from. */
export function qualityArithmetic(raw: RawQualityRow, group: string | null): ArithmeticLine[] {
  const { inputs, excluded, parked, returnsBasis } = deriveQualityInputs(raw, group);
  if (parked) return [{ metric: "all", used: false, text: `not ranked — ${parked}` }];
  const why = (m: QualityMetricKey) => excluded.filter((e) => e.metric === m).map((e) => e.reason).join("; ");
  const now = returnsBasis === "ROE" ? raw.roeAnn0 : raw.roicAnn0, then = returnsBasis === "ROE" ? raw.roeAnn2 : raw.roicAnn2;
  const line = (m: QualityMetricKey, formula: string, unit: string): ArithmeticLine => inputs[m] != null ? { metric: m, used: true, text: `${formula} = ${inputs[m]!.toFixed(2)}${unit}` } : { metric: m, used: false, text: `not used — ${why(m) || "not applicable to this business model"} (inputs: ${formula})` };
  return [
    line("returns", `${returnsBasis} latest fiscal year ${n2(now)}%, taken as returned`, "%"),
    line("returnsTrend", `${returnsBasis} ${n2(now)}% − ${n2(then)}% two fiscal years earlier`, " points"),
    line("roa", `return on assets ${n2(raw.roaAnn0)}%, taken as returned`, "%"),
    line("operMargin", `operating margin last 12m ${n2(raw.operMgnLtm0)}%, taken as returned`, "%"),
    line("marginTrend", `operating margin ${n2(raw.operMgnLtm0)}% − ${n2(raw.operMgnLtm8)}% two years earlier`, " points"),
  ];
}

/** One spot-check company, ready to compare with a terminal: every raw field with its exact formula, then the arithmetic. */
export function spotCheckCard(score: VerifiedScore, row: SpotRow, pick: SpotPick) {
  const fields = score === "growth" ? GROWTH_SOURCE_FIELDS : QUALITY_SOURCE_FIELDS;
  return {
    ticker: row.ticker, group: row.group, why: pick.why,
    fields: fields.map((f) => ({ label: f.label, formula: f.formula, unit: f.unit, value: row.raw[f.key] ?? null })),
    arithmetic: score === "growth" ? growthArithmetic(row.raw as RawGrowthRow, row.group) : qualityArithmetic(row.raw as RawQualityRow, row.group),
  };
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** The spot-check set as CSV: one row per company per FactSet field, with a blank column to fill in from the terminal. */
export function spotCheckCsv(score: VerifiedScore, cards: ReturnType<typeof spotCheckCard>[], calibratedAt: string): string {
  const out = [["score", "calibrated", "ticker", "peer group", "why this one", "field", "FactSet formula", "unit", "value we stored", "value on the terminal (fill in)", "matches? (Y/N)"].join(",")];
  for (const c of cards) {
    for (const f of c.fields) out.push([score, calibratedAt.slice(0, 10), c.ticker, c.group, c.why, f.label, f.formula, f.unit, f.value ?? "missing", "", ""].map(csvCell).join(","));
    for (const a of c.arithmetic) out.push([score, calibratedAt.slice(0, 10), c.ticker, c.group, c.why, `derived: ${a.metric}`, a.text, "", "", "", ""].map(csvCell).join(","));
  }
  return out.join("\n") + "\n";
}
