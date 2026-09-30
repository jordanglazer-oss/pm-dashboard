import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { parseModelJson } from "./json-repair";
import { callAnthropicWithRetry } from "./anthropic-retry";
import { easternToday } from "./date-eastern";
import { buildImageBlocks, type AttachmentInput } from "./screenshot-extractors";
import { enqueueMail } from "./mail-outbox";
import {
  GICS_SECTORS,
  defaultResearch,
  type ResearchState,
  type SectorView,
  type SectorViewEntry,
  type SectorViewLogEntry,
  type SectorViewSource,
} from "./defaults";

/**
 * Fundstrat sector views (Newton + Lee) — the two automated writers of
 * pm:research.newtonSectors / leeSectors:
 *
 *   1. MONTHLY: the Fundstrat sector table screenshot (emailed as a reply to
 *      the reminder queued on the 3rd) sets every sector for both strategists.
 *   2. DAILY:   a Newton / Lee daily note that EXPLICITLY states a rating
 *      change ("Lowering Consumer Discretionary to Underweight") moves that
 *      one sector. Anything short of an overt statement is ignored, and every
 *      accepted change must quote a sentence that is verbatim in the note.
 *
 * Both write through applySectorChanges: a fresh read-merge-write of
 * pm:research that touches only the sector fields, stamps sectorViewsAt (so a
 * stale Research tab can't PUT the old views back — see the kv/research
 * route) and logs every change with its prior value in sectorViewLog.
 *
 * Model inputs here are UNTRUSTED third-party content: data to extract, never
 * instructions to follow.
 */

const log = createLogger("SectorViews");
const client = new Anthropic();

const RESEARCH_KEY = "pm:research";
const REMINDER_KEY = "pm:sector-views-reminder";
const LOG_CAP = 100;

export type Strategist = "newton" | "lee";

// ── Normalisation ───────────────────────────────────────────────────

/** Aliases → the GICS label the tile stores. Word-boundary matched. */
const SECTOR_ALIASES: Record<(typeof GICS_SECTORS)[number], string[]> = {
  Technology: ["information technology", "info tech", "technology", "tech", "xlk"],
  "Health Care": ["health care", "healthcare", "xlv"],
  Financials: ["financials", "financial", "xlf"],
  "Consumer Discretionary": ["consumer discretionary", "discretionary", "xly"],
  "Consumer Staples": ["consumer staples", "staples", "xlp"],
  Energy: ["energy", "xle"],
  Utilities: ["utilities", "xlu"],
  Industrials: ["industrials", "industrial", "xli"],
  Materials: ["basic materials", "materials", "xlb"],
  "Communication Services": ["communication services", "communications", "comm services", "xlc"],
  "Real Estate": ["real estate", "reits", "xlre"],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aliasRe = (alias: string) => new RegExp(`\\b${escapeRe(alias).replace(/\s+/g, "\\s+")}\\b`, "i");

/** Map a free-text sector name to one of the 11 GICS labels, or null. Exact
 *  alias match only — "semiconductors" or "banks" are NOT sectors. */
export function normalizeSector(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [sector, aliases] of Object.entries(SECTOR_ALIASES)) {
    if (sector.toLowerCase() === s || aliases.includes(s)) return sector;
  }
  return null;
}

function quoteNamesSector(quote: string, sector: string): boolean {
  const aliases = SECTOR_ALIASES[sector as keyof typeof SECTOR_ALIASES] ?? [];
  return aliases.some((a) => aliasRe(a).test(quote));
}

export function normalizeView(raw: unknown): SectorView | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "ow" || s === "overweight") return "overweight";
  if (s === "uw" || s === "underweight") return "underweight";
  if (s === "n" || s === "neutral" || s === "marketweight" || s === "equalweight" || s === "mw" || s === "ew") return "neutral";
  return null;
}

/** Letters + digits only, lowercased — so a quote survives the line breaks,
 *  hyphenation and curly quotes a PDF text layer introduces. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const fullGrid = (arr: SectorViewEntry[] | undefined): SectorViewEntry[] =>
  GICS_SECTORS.map((sector) => arr?.find((e) => e.sector === sector) ?? { sector, view: "neutral" as SectorView });

// ── Shared writer ──────────────────────────────────────────────────

export type SectorChange = {
  strategist: Strategist;
  sector: string;
  view: SectorView;
  source: SectorViewSource;
  noteDate?: string;
  quote?: string;
};

export type AppliedChange = SectorViewLogEntry;

/**
 * Read-merge-write pm:research, touching ONLY newtonSectors / leeSectors /
 * sectorViewsAt / sectorViewsMonthlyAt / sectorViewLog. Every other list on
 * the blob is carried through verbatim. A change that matches the stored view
 * only refreshes provenance (a monthly re-confirmation) and isn't logged.
 *
 * `monthlyDate` marks this as the monthly table ingest.
 */
export async function applySectorChanges(
  changes: SectorChange[],
  opts: { monthlyDate?: string } = {},
): Promise<{ applied: AppliedChange[]; skipped: string[] }> {
  const redis = await getRedis();
  const raw = await redis.get(RESEARCH_KEY);
  const state: ResearchState = raw ? (JSON.parse(raw) as ResearchState) : { ...defaultResearch };
  const now = new Date().toISOString();

  const grids: Record<Strategist, SectorViewEntry[]> = {
    newton: fullGrid(state.newtonSectors),
    lee: fullGrid(state.leeSectors),
  };
  const applied: AppliedChange[] = [];
  const skipped: string[] = [];
  let touched = false;

  for (const c of changes) {
    const grid = grids[c.strategist];
    const i = grid.findIndex((e) => e.sector === c.sector);
    if (i < 0) continue;
    const prev = grid[i];
    // A daily note must not override something set on a LATER day (a note
    // forwarded late, backfilled with an older date in the subject).
    if (c.source === "daily-note" && c.noteDate) {
      const prevDay = prev.setAt ? easternToday(new Date(prev.setAt)) : undefined;
      if ((prevDay && c.noteDate < prevDay) || (state.sectorViewsMonthlyAt && c.noteDate < state.sectorViewsMonthlyAt)) {
        skipped.push(`${c.sector} (${c.strategist}): note dated ${c.noteDate} is older than the current view`);
        continue;
      }
    }
    if (prev.view === c.view && c.source === "daily-note") {
      skipped.push(`${c.sector} (${c.strategist}): already ${c.view}`);
      continue;
    }
    grid[i] = {
      sector: c.sector,
      view: c.view,
      source: c.source,
      setAt: now,
      ...(c.noteDate ? { noteDate: c.noteDate } : {}),
      ...(c.quote ? { quote: c.quote } : {}),
    };
    touched = true;
    if (prev.view !== c.view) {
      applied.push({
        at: now,
        strategist: c.strategist,
        sector: c.sector,
        from: prev.view,
        to: c.view,
        source: c.source,
        ...(c.noteDate ? { noteDate: c.noteDate } : {}),
        ...(c.quote ? { quote: c.quote } : {}),
      });
    }
  }

  if (!touched && !opts.monthlyDate) return { applied, skipped };

  const next: ResearchState = {
    ...state,
    newtonSectors: grids.newton,
    leeSectors: grids.lee,
    sectorViewsAt: now,
    ...(opts.monthlyDate ? { sectorViewsMonthlyAt: opts.monthlyDate } : {}),
    sectorViewLog: [...applied.slice().reverse(), ...(state.sectorViewLog ?? [])].slice(0, LOG_CAP),
  };
  await redis.set(RESEARCH_KEY, JSON.stringify(next));
  return { applied, skipped };
}

export function describeChanges(applied: AppliedChange[]): string {
  const V = { overweight: "OW", neutral: "N", underweight: "UW" } as const;
  return applied
    .map((a) => `${a.strategist === "newton" ? "Newton" : "Lee"} ${a.sector} ${V[a.from]}→${V[a.to]}`)
    .join(", ");
}

// ── 1. Daily note → explicit rating changes ────────────────────────

/** Cheap pre-gate: no rating word anywhere → no model call. */
const RATING_WORD_RE = /\b(over\s*weight|under\s*weight|neutral|market[\s-]?weight|equal[\s-]?weight|OW|UW)\b/i;

const NOTE_PROMPT = (who: string) => `You are reading a daily market-strategy note written by ${who} of Fundstrat. Your ONLY job: find sentences where ${who} OVERTLY CHANGES his own recommended weighting of a whole S&P 500 GICS SECTOR.

The 11 sectors: Technology (Information Technology), Health Care, Financials, Consumer Discretionary, Consumer Staples, Energy, Utilities, Industrials, Materials, Communication Services, Real Estate.

Report a change ONLY when the text explicitly says the rating is being changed, e.g.
  "Lowering Consumer Discretionary to Underweight"
  "We are upgrading Energy to Overweight"
  "Moving Technology back to Neutral from Overweight"

Do NOT report:
  - reiterations of an unchanged view ("we remain Overweight Financials")
  - technical/chart commentary without an explicit rating change ("XLY looks weak", "Energy broke support")
  - industries or sub-sectors (semiconductors, banks, homebuilders, software, REIT sub-types), countries, factors, styles, or single stocks
  - views attributed to anyone other than ${who}
  - hypotheticals or conditions ("could move to Underweight if…")
If in doubt, leave it out. An empty list is the normal answer.

For each change, "quote" must be copied VERBATIM from the note (the one sentence or title line that states the change).

Return ONLY JSON: {"changes":[{"sector":"<one of the 11>","view":"overweight|neutral|underweight","quote":"<verbatim>"}]}`;

/**
 * Detect overt sector-rating changes in a daily note and apply them.
 * Best-effort by design: the caller has already stored the note, and any
 * failure here just means no sector move.
 */
export async function applySectorChangesFromNote(
  strategist: Strategist,
  text: string,
  noteDate: string,
  subject = "",
): Promise<{ ran: boolean; applied: AppliedChange[]; skipped: string[]; reason?: string }> {
  const haystack = `${subject}\n${text}`;
  if (!RATING_WORD_RE.test(haystack)) return { ran: false, applied: [], skipped: [], reason: "no rating language" };

  const who = strategist === "newton" ? "Mark Newton" : "Tom Lee";
  const msg = await callAnthropicWithRetry(`sector-note-${strategist}`, () =>
    client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: `${NOTE_PROMPT(who)}\n\n--- EMAIL SUBJECT ---\n${subject}\n\n--- NOTE ---\n${text.slice(0, 24000)}`,
        },
      ],
    }),
  );
  const out = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = parseModelJson<{ changes?: unknown }>(out);
  if (!parsed.ok) {
    log.warn(`${strategist} note: unparseable model output: ${parsed.error}`);
    return { ran: true, applied: [], skipped: [], reason: "unparseable model output" };
  }
  const rawChanges = Array.isArray(parsed.value.changes) ? (parsed.value.changes as Record<string, unknown>[]) : [];

  const hay = squash(haystack);
  const changes: SectorChange[] = [];
  const rejected: string[] = [];
  for (const r of rawChanges) {
    const sector = normalizeSector(String(r.sector ?? ""));
    const view = normalizeView(r.view);
    const quote = String(r.quote ?? "").trim();
    // Guardrails: a real sector, a real rating, and a quote that is actually
    // in the note AND names that sector. Anything else is dropped.
    if (!sector || !view) { rejected.push(`unrecognised "${String(r.sector)}"/"${String(r.view)}"`); continue; }
    if (quote.length < 12 || !hay.includes(squash(quote))) { rejected.push(`${sector}: quote not found verbatim in note`); continue; }
    if (!quoteNamesSector(quote, sector)) { rejected.push(`${sector}: quote doesn't name the sector`); continue; }
    if (!RATING_WORD_RE.test(quote)) { rejected.push(`${sector}: quote states no rating`); continue; }
    if (changes.some((c) => c.sector === sector)) continue;
    changes.push({ strategist, sector, view, source: "daily-note", noteDate, quote: quote.slice(0, 300) });
  }
  if (rejected.length) log.info(`${strategist} note ${noteDate}: rejected ${rejected.join("; ")}`);
  if (changes.length === 0) return { ran: true, applied: [], skipped: rejected };

  const res = await applySectorChanges(changes);
  if (res.applied.length) log.info(`${strategist} note ${noteDate}: applied ${describeChanges(res.applied)}`);
  return { ran: true, applied: res.applied, skipped: [...rejected, ...res.skipped] };
}

// ── 2. Monthly Fundstrat sector table (screenshot) ─────────────────

const TABLE_PROMPT = `This is a screenshot of Fundstrat's sector-view table. Columns, left to right: SECTOR, ETF, S&P WEIGHT, FSI WEIGHT, DELTA, then TWO strategist columns shown only as headshot photos, each cell holding a pill reading OW, N or UW.

Do not identify the people in the photos. Refer to the two photo columns purely by POSITION: "first" = the LEFT photo column, "second" = the RIGHT photo column.

For every sector row, return the pill text in each photo column. Ignore the weight and delta columns.

Return ONLY JSON: {"rows":[{"sector":"<as printed>","etf":"<as printed>","first":"OW|N|UW","second":"OW|N|UW"}]}
If this image is not that table, return {"rows":[]}.`;

/** Column → strategist. Confirmed by the PM 2026-09-30: the LEFT photo
 *  column is Tom Lee, the RIGHT is Mark Newton. Change here if Fundstrat
 *  reorders the table. */
const COLUMN_ORDER: { first: Strategist; second: Strategist } = { first: "lee", second: "newton" };

/** ETF ticker → sector, used when the printed name is ambiguous. */
const ETF_SECTOR: Record<string, string> = {
  XLK: "Technology", XLV: "Health Care", XLF: "Financials", XLY: "Consumer Discretionary",
  XLP: "Consumer Staples", XLE: "Energy", XLU: "Utilities", XLI: "Industrials",
  XLB: "Materials", XLC: "Communication Services", XLRE: "Real Estate",
};

export const MIN_TABLE_SECTORS = 8;

export async function applySectorTableScreenshot(
  att: AttachmentInput,
): Promise<{ ok: boolean; message: string; applied: AppliedChange[]; missing: string[] }> {
  const blocks = buildImageBlocks([att]);
  if (blocks.length === 0) return { ok: false, message: "Expected a PNG/JPG screenshot or PDF of the sector table.", applied: [], missing: [] };

  const msg = await callAnthropicWithRetry("sector-table", () =>
    client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 1500,
      messages: [{ role: "user", content: [{ type: "text", text: TABLE_PROMPT }, ...blocks] }],
    }),
  );
  const out = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = parseModelJson<{ rows?: unknown }>(out);
  const rows = parsed.ok && Array.isArray(parsed.value.rows) ? (parsed.value.rows as Record<string, unknown>[]) : [];

  const changes: SectorChange[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const sector = ETF_SECTOR[String(r.etf ?? "").trim().toUpperCase()] ?? normalizeSector(String(r.sector ?? ""));
    if (!sector || seen.has(sector)) continue;
    const first = normalizeView(r.first);
    const second = normalizeView(r.second);
    if (!first || !second) continue;
    seen.add(sector);
    changes.push({ strategist: COLUMN_ORDER.first, sector, view: first, source: "monthly" });
    changes.push({ strategist: COLUMN_ORDER.second, sector, view: second, source: "monthly" });
  }
  const missing = GICS_SECTORS.filter((s) => !seen.has(s));
  // Refuse a partial read rather than half-update the month: a cropped or
  // wrong image should be re-sent, not guessed at.
  if (seen.size < MIN_TABLE_SECTORS) {
    return {
      ok: false,
      message: `Sector table not recognised (read ${seen.size} of 11 sectors) — nothing changed. Send a screenshot showing the full table.`,
      applied: [],
      missing,
    };
  }
  const today = easternToday();
  const { applied } = await applySectorChanges(changes, { monthlyDate: today });
  const changed = applied.length ? `Changed: ${describeChanges(applied)}.` : "No changes vs the stored views.";
  const miss = missing.length ? ` Not in screenshot (left as-is): ${missing.join(", ")}.` : "";
  return { ok: true, message: `Fundstrat sector table applied for ${today} (${seen.size}/11 sectors). ${changed}${miss}`, applied, missing };
}

// ── 3. Monthly reminder (queued on the 3rd by the nightly cron) ───

export const REMINDER_DAY = 3;
export const REMINDER_SUBJECT_PREFIX = "Fundstrat Sector Views";

function reminderTo(): string {
  return process.env.WATCHLIST_NOTIFY_TO || "jordan.glazer@rbc.com";
}

/**
 * Queue the monthly "send the sector table" email through the inbox Gmail
 * outbox. The subject starts with "Fundstrat Sector Views", so a REPLY with
 * the screenshot attached routes straight back into the ingest (the Apps
 * Script already forwards any "Fundstrat…" subject; no script change needed).
 *
 * Once per month: dedupe on pm:sector-views-reminder.month. `force` (admin
 * route) bypasses the day-of-month check and the dedupe.
 */
export async function maybeQueueSectorViewsReminder(
  opts: { force?: boolean; today?: string } = {},
): Promise<{ queued: boolean; reason: string; subject?: string }> {
  const today = opts.today ?? easternToday();
  const month = today.slice(0, 7);
  if (!opts.force && Number(today.slice(8, 10)) !== REMINDER_DAY) return { queued: false, reason: "not the reminder day" };

  const redis = await getRedis();
  const prevRaw = await redis.get(REMINDER_KEY);
  const prev = prevRaw ? (JSON.parse(prevRaw) as { month?: string }) : {};
  if (!opts.force && prev.month === month) return { queued: false, reason: `already queued for ${month}` };

  const monthLabel = new Date(`${today}T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const subject = `${REMINDER_SUBJECT_PREFIX} — ${monthLabel}`;
  const text = [
    `Time for the monthly Fundstrat sector-view update (${monthLabel}).`,
    ``,
    `1. Open the Fundstrat website and go to the sector views table (Lee + Newton OW / N / UW columns).`,
    `2. Take ONE screenshot showing the whole table — all 11 sectors and both photo columns.`,
    `3. REPLY to this email with the screenshot attached (or pasted in). Keep the subject as is.`,
    `4. Within ~5 minutes the Research page's Sector views tile updates, and the Inbox activity log shows what changed.`,
    ``,
    `If a screenshot needs re-sending, start a NEW email with the subject "${REMINDER_SUBJECT_PREFIX}" — replies on an already-processed thread are skipped.`,
    ``,
    `Between monthly updates, a Newton or Lee daily note that explicitly changes a sector rating updates that sector automatically.`,
  ].join("\n");

  const queued = await enqueueMail({
    id: `sector-views-${month}${opts.force ? `-${Date.now()}` : ""}`,
    to: reminderTo(),
    subject,
    text,
    queuedAt: new Date().toISOString(),
  });
  // A forced (test) send doesn't consume the month's scheduled reminder.
  if (!opts.force) {
    await redis.set(REMINDER_KEY, JSON.stringify({ ...prev, month, queuedAt: new Date().toISOString(), subject }));
  }
  return { queued, reason: queued ? "queued" : "already pending in outbox", subject };
}
