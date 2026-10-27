/**
 * Fundstrat levels memory — the support / resistance / target levels Newton
 * and Lee name, kept on the Brief's Fundstrat view until a NEWER note names a
 * level of the same kind for the same instrument.
 *
 * Why a store: pm:strategist-history keeps only raw note text, and the
 * summary is rebuilt from the latest note alone, so a QQQ support named on
 * Monday vanished from the panel on Tuesday if Tuesday's note didn't repeat
 * it. Each note's levels are extracted once and kept here per note.
 *
 * Key `pm:fundstrat-levels`: `{ notes: { "<author>|<YYYY-MM-DD>": NoteLevels } }`.
 * Written ONLY by GET /api/fundstrat-view, read-merge-write per note, entries
 * older than STORE_RETENTION_DAYS pruned on write. Derived from the notes —
 * losing it only drops level memory for notes no longer in the 30-day history.
 *
 * Supersession: for each (author, instrument, kind) the levels from the most
 * recent note that names that pair win. Time decay: a level older than
 * FADE_AFTER_DAYS is shown faded with its age; older than DROP_AFTER_DAYS it
 * is dropped (a month-old level rarely still matters).
 */

export const LEVELS_KEY = "pm:fundstrat-levels";
export const FADE_AFTER_DAYS = 14;
export const DROP_AFTER_DAYS = 28;
export const STORE_RETENTION_DAYS = 45;

export type Author = "newton" | "lee";
export type LevelKind = "support" | "resistance" | "target" | "other";

export type StrategistLevel = {
  /** Instrument, ticker-style: SPX, QQQ, IWM, VIX, TNX, BTC, a stock ticker… */
  subject: string;
  kind: LevelKind;
  /** As written, e.g. "585" or "6,550–6,600". */
  value: string;
  /** A few words of context, e.g. "50-day MA" or "year-end". */
  note?: string;
};

export type NoteLevels = { textHash: string; extractedAt: string; levels: StrategistLevel[] };
export type LevelsStore = { notes: Record<string, NoteLevels>; lastFailAt?: string };

export type ActiveLevel = StrategistLevel & {
  author: Author;
  noteDate: string;
  ageDays: number;
  fading: boolean;
};

const KINDS = new Set<LevelKind>(["support", "resistance", "target", "other"]);
const SUBJECT_ALIAS: Record<string, string> = {
  "S&P 500": "SPX",
  "S&P": "SPX",
  SPX500: "SPX",
  "NASDAQ 100": "NDX",
  "NASDAQ-100": "NDX",
  "RUSSELL 2000": "IWM",
  "10Y": "TNX",
  "10-YEAR": "TNX",
  BITCOIN: "BTC",
};

export const noteId = (author: Author, date: string) => `${author}|${date}`;

export function normalizeLevels(raw: unknown): StrategistLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: StrategistLevel[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const subj = typeof o.subject === "string" ? o.subject.trim().toUpperCase().replace(/^\$/, "") : "";
    const value = typeof o.value === "string" ? o.value.trim() : typeof o.value === "number" ? String(o.value) : "";
    if (!subj || !value || subj.length > 16 || value.length > 24) continue;
    const kind = KINDS.has(o.kind as LevelKind) ? (o.kind as LevelKind) : "other";
    const note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 60) : undefined;
    out.push({ subject: SUBJECT_ALIAS[subj] ?? subj, kind, value, ...(note ? { note } : {}) });
  }
  return out.slice(0, 16);
}

const dayDiff = (fromYmd: string, now: Date) => {
  const [y, m, d] = fromYmd.split("-").map(Number);
  return Math.max(0, Math.floor((now.getTime() - Date.UTC(y, m - 1, d)) / 86_400_000));
};

const SUBJECT_ORDER = ["SPX", "QQQ", "NDX", "IWM", "DJIA", "VIX", "TNX", "DXY", "BTC"];
const KIND_ORDER: LevelKind[] = ["support", "resistance", "target", "other"];

/** The levels currently in force: newest note per (author, instrument, kind). */
export function activeLevels(store: LevelsStore, now = new Date()): ActiveLevel[] {
  const best = new Map<string, { date: string; levels: StrategistLevel[] }>();
  for (const [id, n] of Object.entries(store.notes ?? {})) {
    const [author, date] = id.split("|");
    if ((author !== "newton" && author !== "lee") || !date) continue;
    if (dayDiff(date, now) > DROP_AFTER_DAYS) continue;
    for (const l of n.levels ?? []) {
      const key = `${author}|${l.subject}|${l.kind}`;
      const cur = best.get(key);
      if (!cur || date > cur.date) best.set(key, { date, levels: [l] });
      else if (date === cur.date && !cur.levels.some((x) => x.value === l.value)) cur.levels.push(l);
    }
  }
  const out: ActiveLevel[] = [];
  for (const [key, { date, levels }] of best) {
    const author = key.split("|")[0] as Author;
    const ageDays = dayDiff(date, now);
    for (const l of levels) out.push({ ...l, author, noteDate: date, ageDays, fading: ageDays >= FADE_AFTER_DAYS });
  }
  const rank = (s: string) => {
    const i = SUBJECT_ORDER.indexOf(s);
    return i < 0 ? SUBJECT_ORDER.length : i;
  };
  return out.sort(
    (a, b) =>
      rank(a.subject) - rank(b.subject) ||
      a.subject.localeCompare(b.subject) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/** Drop stored notes older than the retention window (keeps the key small). */
export function pruneStore(store: LevelsStore, now = new Date()): LevelsStore {
  const notes: Record<string, NoteLevels> = {};
  for (const [id, n] of Object.entries(store.notes ?? {})) {
    const date = id.split("|")[1];
    if (date && dayDiff(date, now) <= STORE_RETENTION_DAYS) notes[id] = n;
  }
  return { ...store, notes };
}
