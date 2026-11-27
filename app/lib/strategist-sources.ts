/**
 * The Strategists page's source list (Nov 26 2026 team session) — PURE, no I/O.
 *
 * THIS IS THE ONE PLACE A SOURCE IS DEFINED. To add a strategist or a
 * technician, add an entry to STRATEGIST_SOURCES; the page, the stance counts
 * and the Market Brief roll-up all follow from it. No economists.
 *
 * A report on file (pm:strategist-report:<id>, read-only here) belongs to the
 * FIRST source whose `match` it satisfies; a report matching none is still
 * shown on the page under "Other reports on file".
 *
 * The three-way stance (Positive / Neutral / Negative) is READ FROM THE
 * REPORT'S OWN WORDING (`summary.stance`, a few words in the strategist's
 * terms) by keyword — it is their view, never ours — and a person can set it
 * by hand (pm:strategist-stance-overrides). Wording that fits no bucket is
 * "Not stated", never guessed.
 */

import type { ReportFirm, ReportKind, StrategistReport } from "./strategist-reports";

export type SourceGroup = "strategists" | "technicals";
export type Stance = "Positive" | "Neutral" | "Negative";

export type StrategistSource = {
  id: string;
  name: string;
  /** The firm as shown on the card. */
  firm: string;
  group: SourceGroup;
  /** Every field given must match. `author` / `title` are case-insensitive RegExp sources. */
  match: { firm?: ReportFirm; author?: string; title?: string; kind?: ReportKind };
  /** Fundstrat dailies: the latest read comes from the Fundstrat notes (Newton / Lee), not an emailed report. */
  fundstrat?: "newton" | "lee";
  /** No feed yet: the reason, shown as "source pending" until a report matches. */
  pending?: string;
  /** The email subject that files a report under this source. */
  subject?: string;
};

export const STRATEGIST_SOURCES: StrategistSource[] = [
  // ── Strategists ──
  { id: "lee", name: "Tom Lee", firm: "Fundstrat", group: "strategists", match: { firm: "Fundstrat", author: "tom\\s+lee|\\blee\\b" }, fundstrat: "lee", subject: "Strategist Lee (the daily note, pasted in)" },
  { id: "cembalest", name: "Michael Cembalest", firm: "J.P. Morgan", group: "strategists", match: { firm: "JPM", author: "cembalest", title: "cembalest|eye on the market" }, subject: "Strategy: JPM – Cembalest – Eye on the Market" },
  { id: "timmer", name: "Jurrien Timmer", firm: "Fidelity", group: "strategists", match: { author: "timmer", title: "timmer" }, pending: "no feed yet", subject: "Strategy: Other – Fidelity – Timmer" },
  { id: "rbc-strategist", name: "RBC strategist", firm: "RBC", group: "strategists", match: { firm: "RBC", kind: "strategy" }, pending: "strategist to be chosen by the team", subject: "Strategy: RBC – …" },
  { id: "sia-action", name: "SIA equity action call", firm: "SIA Charts", group: "strategists", match: { title: "SIA.*equity action" }, pending: "no report on file yet", subject: "Strategy: Other – SIA – Equity Action Call" },
  { id: "rbc-fx", name: "RBC FX forecast", firm: "RBC · Currency Outlook", group: "strategists", match: { firm: "RBC", kind: "fx" }, subject: "FX: RBC – …" },
  // ── Technicals ──
  { id: "newton", name: "Mark Newton", firm: "Fundstrat", group: "technicals", match: { firm: "Fundstrat", author: "newton" }, fundstrat: "newton", subject: "Strategist Newton (the daily note, pasted in)" },
  { id: "sluymer", name: "Robert Sluymer", firm: "RBC", group: "technicals", match: { firm: "RBC", kind: "technical" }, subject: "Technical: RBC – Sluymer – …" },
];

export const GROUP_LABEL: Record<SourceGroup, string> = { strategists: "Strategists", technicals: "Technicals" };

const re = (src: string) => new RegExp(src, "i");

/**
 * Does this report belong to this source? `firm` and `kind` must both hold
 * when given. `author` and `title` are alternatives: when either is given, at
 * least one of them must match (a report names its author in one place or the
 * other, rarely both).
 */
export function matchesSource(source: StrategistSource, r: Pick<StrategistReport, "firm" | "kind" | "author" | "title" | "subject">): boolean {
  const m = source.match;
  if (m.firm && r.firm !== m.firm) return false;
  if (m.kind && r.kind !== m.kind) return false;
  if (m.author || m.title) {
    const byAuthor = m.author ? re(m.author).test(r.author ?? "") : false;
    const byTitle = m.title ? re(m.title).test(`${r.title} ${r.subject ?? ""}`) : false;
    if (!byAuthor && !byTitle) return false;
  }
  return Boolean(m.firm || m.kind || m.author || m.title);
}

/** The source a report belongs to: the most specific match (author / title beats firm + kind alone), else null. */
export function sourceOf(r: StrategistReport, sources: StrategistSource[] = STRATEGIST_SOURCES): StrategistSource | null {
  const hits = sources.filter((s) => matchesSource(s, r));
  return hits.find((s) => s.match.author || s.match.title) ?? hits[0] ?? null;
}

/** A source's reports, newest first. */
export function reportsFor(source: StrategistSource, reports: StrategistReport[], sources: StrategistSource[] = STRATEGIST_SOURCES): StrategistReport[] {
  return reports.filter((r) => sourceOf(r, sources)?.id === source.id).sort((a, b) => b.date.localeCompare(a.date) || b.receivedAt.localeCompare(a.receivedAt));
}

/** Reports that match no configured source (still shown, so nothing disappears). */
export function unmatchedReports(reports: StrategistReport[], sources: StrategistSource[] = STRATEGIST_SOURCES): StrategistReport[] {
  return reports.filter((r) => !sourceOf(r, sources)).sort((a, b) => b.date.localeCompare(a.date));
}

// ── Stance ────────────────────────────────────────────────────────

const POSITIVE = /\b(bullish|constructive|positive|overweight|buy|upbeat|optimistic|risk[- ]on|favou?rable)\b/i;
const NEGATIVE = /\b(cautious|caution|bearish|negative|defensive|underweight|sell|pessimistic|risk[- ]off|wary)\b/i;
const NEUTRAL = /\b(neutral|mixed|balanced|range[- ]?bound|range|sideways|market[- ]weight|hold)\b/i;
const NONE = /no overall stance|no stance|not stated/i;

/**
 * The strategist's own wording → one of three buckets, by keyword. The FIRST
 * keyword in the text decides, so "Cautious near term, constructive into
 * year-end" reads Negative (their lead view). Null = "Not stated".
 */
export function stanceBucket(text: string | null | undefined): Stance | null {
  const t = (text ?? "").trim();
  if (!t || NONE.test(t)) return null;
  const at = (rx: RegExp) => {
    const i = t.search(rx);
    return i < 0 ? Infinity : i;
  };
  const p = at(POSITIVE), n = at(NEGATIVE), u = at(NEUTRAL);
  const first = Math.min(p, n, u);
  if (first === Infinity) return null;
  return first === p ? "Positive" : first === n ? "Negative" : "Neutral";
}

export type StanceOverride = { stance: Stance; by?: string; at: string };
export type StanceOverrides = Record<string, StanceOverride>;

/** The stance shown for a read: a hand-set one wins over the wording. */
export function resolveStance(text: string | null | undefined, key: string | null | undefined, overrides: StanceOverrides = {}): { stance: Stance | null; byHand: boolean } {
  const o = key ? overrides[key] : undefined;
  if (o) return { stance: o.stance, byHand: true };
  return { stance: stanceBucket(text), byHand: false };
}

// ── Latest read per source, and the roll-up ───────────────────────

/** The latest thing a source said. `key` is what a hand-set stance is stored under. */
export type SourceRead = { stanceText: string; date: string; key: string };
/** Fundstrat views from /api/fundstrat-view (their stance word, their date). */
export type FundstratReads = { newton?: { stance: string; date: string } | null; lee?: { stance: string; date: string } | null };

/** The override key for a Fundstrat daily read — the archived note's own id. */
export const fundstratKey = (who: "newton" | "lee", date: string) => `${date}-fundstrat-${who}`;

/** The latest read for a source: the Fundstrat view for Newton / Lee, else the newest emailed report with a summary. */
export function latestRead(source: StrategistSource, reports: StrategistReport[], fundstrat: FundstratReads = {}, sources: StrategistSource[] = STRATEGIST_SOURCES): SourceRead | null {
  if (source.fundstrat) {
    const v = fundstrat[source.fundstrat];
    if (v) return { stanceText: v.stance, date: v.date, key: fundstratKey(source.fundstrat, v.date) };
  }
  const r = reportsFor(source, reports, sources).find((x) => x.source !== "note");
  return r ? { stanceText: r.summary?.stance ?? "", date: r.date, key: r.id } : null;
}

export type GroupRollup = {
  group: SourceGroup;
  counts: { Positive: number; Neutral: number; Negative: number; notStated: number };
  /** Sources with a read on file. */
  total: number;
  /** Date of the newest read in the group. */
  newest: string | null;
  /** One line for the Market Brief, e.g. "Mostly positive (5 of 7)" or "Newton neutral, Sluymer positive". */
  line: string;
};

const lastName = (name: string) => name.split(/\s+/).pop() ?? name;

/**
 * One line per group for the Market Brief roll-up. Counts only sources with a
 * read on file. Three or fewer reads are named one by one ("Newton neutral,
 * Sluymer positive"); more are counted ("Mostly positive (5 of 7)").
 */
export function strategistRollup(sources: StrategistSource[], reports: StrategistReport[], overrides: StanceOverrides = {}, fundstrat: FundstratReads = {}): GroupRollup[] {
  return (["strategists", "technicals"] as SourceGroup[]).map((group) => {
    const counts = { Positive: 0, Neutral: 0, Negative: 0, notStated: 0 };
    const named: string[] = [];
    let newest: string | null = null;
    let total = 0;
    for (const s of sources.filter((x) => x.group === group)) {
      const read = latestRead(s, reports, fundstrat, sources);
      if (!read) continue;
      total++;
      if (!newest || read.date > newest) newest = read.date;
      const { stance } = resolveStance(read.stanceText, read.key, overrides);
      if (stance) counts[stance]++;
      else counts.notStated++;
      named.push(`${lastName(s.name)} ${stance ? stance.toLowerCase() : "not stated"}`);
    }
    let line: string;
    if (!total) line = "no data yet";
    else if (total <= 3) line = named.join(", ");
    else {
      const stated = total - counts.notStated;
      const order: Stance[] = ["Positive", "Neutral", "Negative"];
      const top = order.reduce((a, b) => (counts[b] > counts[a] ? b : a));
      const tie = order.filter((k) => counts[k] === counts[top]).length > 1;
      if (!stated) line = `Not stated (${total} on file)`;
      else if (tie) line = `Mixed (${counts.Positive} positive, ${counts.Neutral} neutral, ${counts.Negative} negative)`;
      else line = `${counts[top] === stated ? "All" : counts[top] > stated / 2 ? "Mostly" : "Leaning"} ${top.toLowerCase()} (${counts[top]} of ${total})`;
    }
    return { group, counts, total, newest, line };
  });
}
