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
/** On-demand write-ups for a book name we do NOT hold (a pre-buy read). A
 *  separate prefix, so they never mix with or block the monthly review record
 *  (`pm:agent-run:devils-advocate:<month>:*` does not match it). */
export const DA_ADHOC_PREFIX = "pm:agent-run:devils-advocate-adhoc:";
export const daAdhocKey = (ticker: string) => `${DA_ADHOC_PREFIX}${ticker.toUpperCase()}`;
export const DA_ADHOC_HISTORY = 3;

/** A stock (thesis, alerts, consensus) or a Managed Alpha fund (one-pager, record vs category). */
export type DaKind = "stock" | "fund";

export type DaVerdict = "would buy today" | "hold, would not add" | "would not buy today";
export const DA_VERDICTS: DaVerdict[] = ["would not buy today", "hold, would not add", "would buy today"];

export type DaResult = {
  ticker: string;
  name?: string;
  /** Absent on records written before Managed Alpha funds were covered = "stock". */
  kind?: DaKind;
  month: string; // YYYY-MM — the review month (its first Monday is the meeting)
  at: string;
  verdict: DaVerdict;
  /** 3-5 points, each tied to a fact on file. */
  strongestCaseAgainst: string[];
  whatWouldChangeMind: string;
  weakestPillar: string;
  confidence: "low" | "medium" | "high";
  /** What was on file when it was written, so a thin answer can be told from a thin file. */
  onFile: { thesis: boolean; pillars: number; alerts: number; previews: number; analystHistory: number; scoreHistory: number; onePager?: boolean; fundData?: boolean; managerReview?: boolean };
  model: string;
  usd: number;
};

/** The latest on-demand write-up for one name, with the few before it. */
export type DaAdhocRecord = DaResult & { adhoc: true; history?: DaResult[] };

/** Put a new on-demand write-up on top; the previous one moves into `history` (newest first, capped). Pure. */
export function withAdhocHistory(prev: DaAdhocRecord | null | undefined, next: DaResult): DaAdhocRecord {
  const older: DaResult[] = [];
  if (prev) {
    const last: Record<string, unknown> = { ...prev };
    delete last.history;
    delete last.adhoc;
    older.push(last as DaResult, ...(Array.isArray(prev.history) ? prev.history : []));
  }
  return { ...next, adhoc: true, ...(older.length ? { history: older.slice(0, DA_ADHOC_HISTORY) } : {}) };
}

export type DaMonthView = {
  month: string;
  reviewOn: string;
  startsOn: string;
  held: { symbol: string; name: string; kind?: DaKind }[];
  results: DaResult[];
  pending: string[];
  /** Results on file for holdings no longer held (kept as the record). */
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

export type DaHeld = { symbol: string; name: string; weightInClass: number; kind: DaKind };

/**
 * Every individual holding we actually own: PIM equity outside Core — the
 * individual stocks AND the Managed Alpha funds (bucket "thematic"). Core
 * ETFs, bonds and alternatives (anything that is not equity) are not
 * covered; neither is a zero weight, the watchlist or a suggested name.
 */
export function heldHoldings(models: PimModelData | null, stocks: BucketStock[]): DaHeld[] {
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!pim || !models) return [];
  const tests = bucketTests(stocks, models);
  return pim.holdings
    .filter((h) => h.assetClass === "equity" && h.weightInClass > 0 && !tests.isCore(h.symbol))
    .map((h) => ({ symbol: h.symbol.toUpperCase(), name: h.name, weightInClass: h.weightInClass, kind: tests.isThematic(h.symbol) ? ("fund" as const) : ("stock" as const) }));
}

/** The individual stocks alone (no Managed Alpha funds). */
export function heldStocks(models: PimModelData | null, stocks: BucketStock[]): { symbol: string; name: string; weightInClass: number }[] {
  return heldHoldings(models, stocks)
    .filter((h) => h.kind === "stock")
    .map(({ symbol, name, weightInClass }) => ({ symbol, name, weightInClass }));
}

/** "Would not buy today" first, then "hold", then "would buy"; ties by ticker. */
export function orderResults<T extends { verdict: DaVerdict; ticker: string }>(list: T[]): T[] {
  const rank = (v: DaVerdict) => {
    const i = DA_VERDICTS.indexOf(v);
    return i < 0 ? DA_VERDICTS.length : i;
  };
  return [...list].sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.ticker.localeCompare(b.ticker));
}

/** What is on file for a Managed Alpha fund. */
export type DaFundFacts = {
  onePager?: {
    signedOn?: string;
    headline?: string;
    whyWeOwn: string[];
    manager?: string;
    philosophy?: string;
    process?: string;
    role?: string;
    record?: string;
    fees?: string;
    risks: string[];
    /** The internal "what would make us reconsider" line. */
    watch?: string;
  } | null;
  data?: {
    category?: string;
    expenseRatio?: number;
    starRating?: number;
    perf?: { oneYear?: number; threeYear?: number; fiveYear?: number };
    categoryPerf?: { oneYear?: number; threeYear?: number; fiveYear?: number };
  } | null;
  /** The quarterly manager watch's last review of this fund. */
  managerReview?: { quarter: string; severity: string; findings: string[]; read?: string } | null;
};

export type DaFacts = {
  ticker: string;
  name?: string;
  /** Default "stock". */
  kind?: DaKind;
  /** False for an on-demand read of a name we do not own. Default true. */
  held?: boolean;
  /** Fund only. */
  fund?: DaFundFacts;
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

const pct = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}%` : "n/a");
const gap = (a: number | undefined, b: number | undefined) => (typeof a === "number" && typeof b === "number" ? `${a - b >= 0 ? "+" : ""}${(a - b).toFixed(1)} pts` : "n/a");

/** A Managed Alpha fund's facts as one text block. Pure. */
function buildFundBlock(f: DaFacts): string {
  const held = f.held !== false;
  const lines: string[] = [
    held ? "=== POSITION (a Managed Alpha fund we own) ===" : "=== CANDIDATE (a fund we do NOT own — a pre-buy read) ===",
    `${f.ticker}${f.name ? ` (${f.name})` : ""}${f.weightInClass != null ? `, ${(f.weightInClass * 100).toFixed(2)}% of PIM equity` : ""}${f.heldSince ? `, first bought ${f.heldSince}` : ""}`,
    "",
    "=== OUR SIGNED ONE-PAGER (why we own it) ===",
  ];
  const p = f.fund?.onePager;
  if (!p) lines.push(held ? "NONE ON FILE — we hold this fund with no signed one-pager." : "NONE ON FILE.");
  else {
    if (p.signedOn) lines.push(`Signed ${p.signedOn}`);
    if (p.headline) lines.push(`Headline: ${clip(p.headline, 300)}`);
    if (p.whyWeOwn.length) lines.push("Why we own it:", ...p.whyWeOwn.slice(0, 6).map((x) => `- ${clip(x, 300)}`));
    if (p.manager) lines.push(`Manager: ${clip(p.manager, 300)}`);
    if (p.philosophy) lines.push(`Philosophy: ${clip(p.philosophy, 600)}`);
    if (p.process) lines.push(`How they invest: ${clip(p.process, 600)}`);
    if (p.role) lines.push(`Its role in our portfolio: ${clip(p.role, 500)}`);
    if (p.record) lines.push(`Track record as we wrote it: ${clip(p.record, 500)}`);
    if (p.fees) lines.push(`Cost as we wrote it: ${clip(p.fees, 300)}`);
    if (p.risks.length) lines.push("Risks we listed:", ...p.risks.slice(0, 6).map((x) => `- ${clip(x, 300)}`));
    if (p.watch) lines.push(`What we said would make us reconsider: ${clip(p.watch, 500)}`);
  }
  lines.push("", "=== THE RECORD VS ITS CATEGORY (annualised, from the fund data on file) ===");
  const d = f.fund?.data;
  if (!d || (!d.perf && !d.categoryPerf && d.expenseRatio == null && !d.category)) lines.push("Nothing on file.");
  else {
    if (d.category) lines.push(`Category: ${d.category}`);
    for (const [label, k] of [["1 year", "oneYear"], ["3 years", "threeYear"], ["5 years", "fiveYear"]] as const)
      lines.push(`${label}: fund ${pct(d.perf?.[k])}, category ${pct(d.categoryPerf?.[k])}, difference ${gap(d.perf?.[k], d.categoryPerf?.[k])}`);
    if (d.expenseRatio != null) lines.push(`Fee (MER): ${d.expenseRatio}%`);
    if (d.starRating != null) lines.push(`Morningstar rating: ${d.starRating} stars`);
  }
  lines.push("", "=== OUR QUARTERLY MANAGER WATCH ===");
  const r = f.fund?.managerReview;
  if (!r) lines.push("Nothing on file.");
  else {
    lines.push(`${r.quarter}: ${r.severity}`);
    if (r.findings.length) lines.push(...r.findings.slice(0, 8).map((x) => `- ${clip(x, 300)}`));
    if (r.read) lines.push(`Read: ${clip(r.read, 600)}`);
  }
  return lines.join("\n");
}

/** The facts the model is allowed to use, as one text block. Pure. */
export function buildFactsBlock(f: DaFacts): string {
  if (f.kind === "fund") return buildFundBlock(f);
  const held = f.held !== false;
  const lines: string[] = [
    held ? "=== POSITION ===" : "=== CANDIDATE (a stock we do NOT own — a pre-buy read) ===",
    `${f.ticker}${f.name ? ` (${f.name})` : ""}${f.weightInClass != null ? `, ${(f.weightInClass * 100).toFixed(2)}% of PIM equity` : ""}${f.heldSince ? `, first bought ${f.heldSince}` : ""}`,
    "",
    held ? "=== OUR SIGNED THESIS ===" : "=== OUR THESIS FOR IT (if one has been written) ===",
  ];
  if (!f.thesis) lines.push(held ? "NONE ON FILE — we hold this stock with no signed thesis." : "NONE ON FILE — no thesis has been signed for this name.");
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
    `Devil's advocate for the ${reviewOn} portfolio review — every individual stock and Managed Alpha fund we hold, argued against.`,
    `${count("would not buy today")} would not buy today · ${count("hold, would not add")} hold, would not add · ${count("would buy today")} would buy today.`,
    "",
  ];
  for (const r of ordered)
    lines.push(`${r.ticker}${r.kind === "fund" ? " (fund)" : ""} — ${r.verdict.toUpperCase()}`, `  ${r.strongestCaseAgainst[0]}`, ...(r.weakestPillar ? [`  Weakest ${r.kind === "fund" ? "point" : "pillar"}: ${r.weakestPillar}`] : []), "");
  lines.push("Full write-up: https://pm-dashboard-7rr9.vercel.app/monitor", "", "These are arguments to test our thinking, not instructions. Nothing was traded or changed.");
  return { subject: `Devil's advocate ready — ${reviewOn} review (${ordered.length} holdings)`, text: lines.join("\n") };
}
