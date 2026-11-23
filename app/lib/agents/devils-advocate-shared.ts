import { bucketTests, type BucketStock } from "@/app/lib/sleeve-targets";
import type { PimModelData } from "@/app/lib/pim-types";

/**
 * Devil's advocate — the pure parts (dates, who is covered, ordering, the
 * facts block). No Redis, no network, so the Monitor page and the tests can
 * import it. The runner lives in ./devils-advocate.ts.
 */

export const DA_WATCHER = "devils-advocate";
export const DA_PREFIX = "pm:agent-run:devils-advocate:";
export const daKey = (month: string, ticker: string) => `${DA_PREFIX}${month}:${ticker.toUpperCase()}`;

export type DaVerdict = "would buy today" | "hold, would not add" | "would not buy today";
export const DA_VERDICTS: DaVerdict[] = ["would not buy today", "hold, would not add", "would buy today"];

export type DaResult = {
  ticker: string;
  name?: string;
  month: string; // YYYY-MM — the review month (its first Monday is the meeting)
  at: string;
  verdict: DaVerdict;
  /** 3-5 points, each tied to a fact on file. */
  strongestCaseAgainst: string[];
  whatWouldChangeMind: string;
  weakestPillar: string;
  confidence: "low" | "medium" | "high";
  /** What was on file when it was written, so a thin answer can be told from a thin file. */
  onFile: { thesis: boolean; pillars: number; alerts: number; previews: number; analystHistory: number; scoreHistory: number };
  model: string;
  usd: number;
};

export type DaMonthView = {
  month: string;
  reviewOn: string;
  startsOn: string;
  held: { symbol: string; name: string }[];
  results: DaResult[];
  pending: string[];
  /** Results on file for stocks no longer held (kept as the record). */
  noLongerHeld: string[];
  usd: number;
};

export type DaRunResult = {
  ok: boolean;
  month: string;
  reviewOn: string;
  skipped?: string;
  error?: string;
  written: string[];
  failed: { ticker: string; reason: string }[];
  pending: string[];
  complete: boolean;
  announced: boolean;
  usd: number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000));

/** First Monday of a YYYY-MM month, as YYYY-MM-DD. */
export function firstMondayOf(month: string): string {
  const dow = new Date(`${month}-01T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return addDays(`${month}-01`, (8 - dow) % 7);
}

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The review this date is preparing for: the month whose first Monday is
 *  today or the next one to come. */
export function reviewMonthFor(today: string): string {
  const month = today.slice(0, 7);
  return firstMondayOf(month) >= today ? month : nextMonth(month);
}

/** The Wednesday before the review's first Monday — the first evening the nightly run works on it. */
export function startDateFor(month: string): string {
  return addDays(firstMondayOf(month), -5);
}

/** Should the nightly job work on the devil's advocate tonight? */
export function isDueOn(today: string): { due: boolean; month: string; startsOn: string; reviewOn: string } {
  const month = reviewMonthFor(today);
  const startsOn = startDateFor(month);
  const reviewOn = firstMondayOf(month);
  return { due: today >= startsOn && today <= reviewOn, month, startsOn, reviewOn };
}

/** Every individual stock held: PIM equity outside Core and Managed Alpha. */
export function heldStocks(models: PimModelData | null, stocks: BucketStock[]): { symbol: string; name: string; weightInClass: number }[] {
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!pim || !models) return [];
  const tests = bucketTests(stocks, models);
  return pim.holdings
    .filter((h) => h.assetClass === "equity" && h.weightInClass > 0 && !tests.isCore(h.symbol) && !tests.isThematic(h.symbol))
    .map((h) => ({ symbol: h.symbol.toUpperCase(), name: h.name, weightInClass: h.weightInClass }));
}

/** "Would not buy today" first, then "hold", then "would buy"; ties by ticker. */
export function orderResults<T extends { verdict: DaVerdict; ticker: string }>(list: T[]): T[] {
  const rank = (v: DaVerdict) => {
    const i = DA_VERDICTS.indexOf(v);
    return i < 0 ? DA_VERDICTS.length : i;
  };
  return [...list].sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.ticker.localeCompare(b.ticker));
}

export type DaFacts = {
  ticker: string;
  name?: string;
  weightInClass?: number;
  heldSince?: string | null;
  thesis?: { why?: string; signedOn?: string; pillars: { title: string; claim: string; status?: string; statusSince?: string; statusNote?: string }[]; breakers: string[] } | null;
  /** Pre-formatted, dated FactSet alert text (results, street reaction, news). */
  alerts?: string;
  previews?: string[];
  analyst?: string[];
  scoreTrend?: string[];
};

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

/** The facts the model is allowed to use, as one text block. Pure. */
export function buildFactsBlock(f: DaFacts): string {
  const lines: string[] = [
    "=== POSITION ===",
    `${f.ticker}${f.name ? ` (${f.name})` : ""}${f.weightInClass != null ? `, ${(f.weightInClass * 100).toFixed(2)}% of PIM equity` : ""}${f.heldSince ? `, first bought ${f.heldSince}` : ""}`,
    "",
    "=== OUR SIGNED THESIS ===",
  ];
  if (!f.thesis) lines.push("NONE ON FILE — we hold this stock with no signed thesis.");
  else {
    if (f.thesis.signedOn) lines.push(`Signed ${f.thesis.signedOn}`);
    if (f.thesis.why) lines.push(`Why we own it: ${clip(f.thesis.why, 1200)}`);
    if (!f.thesis.pillars.length) lines.push("No pillars written.");
    for (const p of f.thesis.pillars)
      lines.push(`- Pillar "${p.title}": ${clip(p.claim, 400)} [status: ${p.status ?? "not assessed"}${p.statusSince ? ` since ${p.statusSince}` : ""}${p.statusNote ? ` — ${clip(p.statusNote, 300)}` : ""}]`);
    if (f.thesis.breakers.length) lines.push("Breakers (what we said would make us sell):", ...f.thesis.breakers.map((b) => `- ${clip(b, 300)}`));
  }
  const section = (title: string, rows: string[] | undefined) => {
    lines.push("", title);
    if (rows?.length) lines.push(...rows);
    else lines.push("Nothing on file.");
  };
  lines.push("", "=== FACTSET ALERTS, LAST 120 DAYS (results, street reaction, news) ===", f.alerts?.trim() ? clip(f.alerts.trim(), 14_000) : "Nothing on file.");
  section("=== UPCOMING EARNINGS PREVIEW ===", f.previews);
  section("=== SELL-SIDE CONSENSUS ===", f.analyst);
  section("=== OUR OWN SCORE OVER TIME (context only — do not lean on it) ===", f.scoreTrend);
  return lines.join("\n");
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Validate the model's JSON into the stored fields. Null when unusable. */
export function normaliseAnswer(raw: unknown): Pick<DaResult, "verdict" | "strongestCaseAgainst" | "whatWouldChangeMind" | "weakestPillar" | "confidence"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const v = str(r.verdict, 40).toLowerCase();
  const verdict: DaVerdict | null =
    DA_VERDICTS.find((x) => x === v) ?? (v.startsWith("would not") ? "would not buy today" : v.startsWith("hold") ? "hold, would not add" : v.startsWith("would buy") ? "would buy today" : null);
  const points = (Array.isArray(r.strongestCaseAgainst) ? r.strongestCaseAgainst : [])
    .map((p) => str(p, 500))
    .filter(Boolean)
    .slice(0, 5);
  if (!verdict || !points.length) return null;
  const c = str(r.confidence, 10).toLowerCase();
  return {
    verdict,
    strongestCaseAgainst: points,
    whatWouldChangeMind: str(r.whatWouldChangeMind, 600),
    weakestPillar: str(r.weakestPillar, 300),
    confidence: c === "high" || c === "low" ? c : "medium",
  };
}

/** The plain-text email sent when the month is complete. Pure. */
export function buildDaEmail(reviewOn: string, results: DaResult[]): { subject: string; text: string } {
  const ordered = orderResults(results);
  const count = (v: DaVerdict) => ordered.filter((r) => r.verdict === v).length;
  const lines = [
    `Devil's advocate for the ${reviewOn} portfolio review — every individual stock we hold, argued against.`,
    `${count("would not buy today")} would not buy today · ${count("hold, would not add")} hold, would not add · ${count("would buy today")} would buy today.`,
    "",
  ];
  for (const r of ordered) lines.push(`${r.ticker} — ${r.verdict.toUpperCase()}`, `  ${r.strongestCaseAgainst[0]}`, ...(r.weakestPillar ? [`  Weakest pillar: ${r.weakestPillar}`] : []), "");
  lines.push("Full write-up: https://pm-dashboard-7rr9.vercel.app/monitor", "", "These are arguments to test our thinking, not instructions. Nothing was traded or changed.");
  return { subject: `Devil's advocate ready — ${reviewOn} review (${ordered.length} stocks)`, text: lines.join("\n") };
}
