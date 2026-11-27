/**
 * Third-Party Managers (Nov 26 2026 team session, section 9). Pure — no I/O.
 *
 * A manually kept list of outside fund managers the team screens twice a year
 * (as of Dec 31 and Jun 30, from Morningstar — typed in, never imported).
 * Every screen's result is KEPT so the page can show how long a manager has
 * stayed on the list.
 *
 * Store: `pm:third-party-managers` =
 *   { managers: { [id]: Manager }, updatedAt }
 * Written only by POST /api/third-party-managers, one manager at a time
 * (read-merge-write; the prior version goes into that manager's `history`).
 * Nothing is ever deleted: a manager leaving the list gets status "Removed".
 *
 * Facts only: the page shows returns against the category index and how many
 * years a manager has trailed it. It never says what to do about it.
 */

export const MANAGERS_KEY = "pm:third-party-managers";

export const STATUSES = ["Watching", "Owned", "Removed"] as const;
export type ManagerStatus = (typeof STATUSES)[number];

/** Diversified categories first, then alternatives by strategy group, then sector funds. */
export const CATEGORIES = ["Canadian equity", "US equity", "Global equity", "Alt: market neutral", "Alt: long/short", "Alt: credit", "Alt: other", "Sector"] as const;
export type ManagerCategory = (typeof CATEGORIES)[number];

/** One twice-yearly screen result for a manager. Returns are annualized, in %. */
export type ManagerScreen = {
  /** The screen's as-of date: a Dec 31 or a Jun 30 (YYYY-MM-DD). */
  date: string;
  ret5y?: number;
  idx5y?: number;
  ret10y?: number;
  idx10y?: number;
  /** Did the manager make the list on this screen? */
  onList: boolean;
  enteredAt: string;
};

/** One calendar year: the fund's return and its category index's, in %. Drives the tolerance flag. */
export type AnnualReturn = { year: number; fund: number; index: number };

export type Manager = {
  id: string;
  manager: string;
  firm: string;
  fundName: string;
  /** F-class fund code. */
  fundCode: string;
  category: ManagerCategory;
  /** A sector fund (e.g. energy) is listed apart from diversified managers. */
  sectorFund?: boolean;
  sectorName?: string;
  goAnywhere: boolean;
  wholesaler?: string;
  notes?: string;
  status: ManagerStatus;
  screens: ManagerScreen[];
  annual?: AnnualReturn[];
  updatedAt: string;
  /** Prior versions, newest last (each without its own history). */
  history?: Omit<Manager, "history">[];
};

export type ManagersStore = { managers: Record<string, Manager>; updatedAt?: string };

export const HISTORY_KEEP = 8;
/** Draft rule from the team: an owned manager is flagged after trailing the index this many years in a row. */
export const TOLERANCE_YEARS = 2;

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** A percentage typed by a person: a finite number in a believable range, else undefined. */
const pctNum = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim().replace(/%$/, "")) : NaN;
  return Number.isFinite(n) && n > -100 && n < 1000 ? Math.round(n * 100) / 100 : undefined;
};

/** A stable id from the fund code (else manager + fund name). */
export function managerId(input: { fundCode?: string; manager?: string; fundName?: string }): string {
  const base = (input.fundCode || `${input.manager ?? ""} ${input.fundName ?? ""}`).toLowerCase();
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Read whatever is stored into a usable store. A missing or unreadable value is an EMPTY store — never seeded. */
export function parseStore(raw: string | null | undefined): ManagersStore {
  if (!raw) return { managers: {} };
  try {
    const v = JSON.parse(raw) as ManagersStore;
    return v && typeof v === "object" && v.managers && typeof v.managers === "object" && !Array.isArray(v.managers) ? v : { managers: {} };
  } catch {
    return { managers: {} };
  }
}

export function sanitizeScreen(input: unknown, now: string): ManagerScreen | { error: string } {
  const b = (input ?? {}) as Record<string, unknown>;
  if (!isDate(b.date)) return { error: "The screen needs a date (YYYY-MM-DD)." };
  const out: ManagerScreen = { date: b.date, onList: b.onList !== false, enteredAt: now };
  for (const k of ["ret5y", "idx5y", "ret10y", "idx10y"] as const) {
    const n = pctNum(b[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

export function sanitizeAnnual(input: unknown): AnnualReturn[] {
  if (!Array.isArray(input)) return [];
  const by = new Map<number, AnnualReturn>();
  for (const r of input as Record<string, unknown>[]) {
    const year = Number(r?.year);
    const fund = pctNum(r?.fund);
    const index = pctNum(r?.index);
    if (Number.isInteger(year) && year >= 1990 && year <= 2100 && fund !== undefined && index !== undefined) by.set(year, { year, fund, index });
  }
  return [...by.values()].sort((a, b) => a.year - b.year);
}

/**
 * The manager to store from a person's entry, merged over what is on file.
 * Descriptive fields and the annual returns come from the entry; SCREENS are
 * never taken from here (they are added one at a time) and unknown stored
 * fields are kept. The prior version goes into `history`.
 */
export function mergeManager(input: unknown, prior: Manager | undefined, now: string): Manager | { error: string } {
  const b = (input ?? {}) as Record<string, unknown>;
  const manager = str(b.manager, 120);
  const fundName = str(b.fundName, 160);
  if (!manager && !fundName) return { error: "Enter the manager or the fund name." };
  const fundCode = str(b.fundCode, 24).toUpperCase();
  const id = prior?.id ?? (str(b.id, 60) || managerId({ fundCode, manager, fundName }));
  if (!id) return { error: "Could not build an id for this entry." };
  const category = (CATEGORIES as readonly string[]).includes(b.category as string) ? (b.category as ManagerCategory) : (prior?.category ?? "Global equity");
  const status = (STATUSES as readonly string[]).includes(b.status as string) ? (b.status as ManagerStatus) : (prior?.status ?? "Watching");
  const sectorFund = b.sectorFund === true || category === "Sector";
  const next: Manager = {
    ...(prior ?? {}),
    id,
    manager,
    firm: str(b.firm, 120),
    fundName,
    fundCode,
    category,
    sectorFund,
    sectorName: sectorFund ? str(b.sectorName, 60) : "",
    goAnywhere: b.goAnywhere === true,
    wholesaler: str(b.wholesaler, 200),
    notes: str(b.notes, 4000),
    status,
    screens: prior?.screens ?? [],
    annual: b.annual === undefined ? (prior?.annual ?? []) : sanitizeAnnual(b.annual),
    updatedAt: now,
  };
  return withHistory(next, prior);
}

/** Push the prior version (without its own history) onto the history, newest last, capped. */
export function withHistory(next: Manager, prior: Manager | undefined): Manager {
  if (!prior) return { ...next, history: next.history ?? [] };
  const { history, ...flat } = prior;
  return { ...next, history: [...(history ?? []), flat].slice(-HISTORY_KEEP) };
}

/** Add one screen, or replace the one already on file for that date. Others are untouched. */
export function upsertScreen(m: Manager, screen: ManagerScreen, now: string): Manager {
  const screens = [...(m.screens ?? []).filter((s) => s.date !== screen.date), screen].sort((a, b) => a.date.localeCompare(b.date));
  return withHistory({ ...m, screens, updatedAt: now }, m);
}

export function setStatus(m: Manager, status: ManagerStatus, now: string): Manager {
  return withHistory({ ...m, status, updatedAt: now }, m);
}

/** The newest screen on file, or null. */
export function latestScreen(m: Pick<Manager, "screens">): ManagerScreen | null {
  const s = [...(m.screens ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return s.length ? s[s.length - 1] : null;
}

/**
 * How long a manager has stayed on the list. Screens are twice a year, so
 * years = screens ÷ 2. `consecutive` counts back from the newest screen and
 * stops at the first one the manager missed.
 */
export function yearsOnList(m: Pick<Manager, "screens">): { screens: number; consecutive: number; years: number; since: string | null } {
  const s = [...(m.screens ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const screens = s.filter((x) => x.onList).length;
  let consecutive = 0;
  let since: string | null = null;
  for (let i = s.length - 1; i >= 0 && s[i].onList; i--) {
    consecutive++;
    since = s[i].date;
  }
  return { screens, consecutive, years: consecutive / 2, since };
}

/**
 * Calendar years in a row, counting back from the newest year on file, in
 * which the fund returned LESS than its category index. A missing year ends
 * the run (never assumed either way).
 */
export function trailingYears(m: Pick<Manager, "annual">): number {
  const a = [...(m.annual ?? [])].sort((x, y) => y.year - x.year);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i > 0 && a[i].year !== a[i - 1].year - 1) break;
    if (!(a[i].fund < a[i].index)) break;
    n++;
  }
  return n;
}

/** An OWNED manager who has trailed the index for two or more years in a row. */
export function toleranceFlag(m: Pick<Manager, "status" | "annual">): { flagged: boolean; years: number } {
  const years = trailingYears(m);
  return { flagged: m.status === "Owned" && years >= TOLERANCE_YEARS, years };
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The twice-yearly screen calendar around `today` (YYYY-MM-DD): `last` = the
 * most recent Jun 30 / Dec 31 on or before today, `next` = the one after.
 */
export function nextScreenDue(today: string): { last: string; next: string } {
  const y = Number(today.slice(0, 4));
  const jun = iso(y, 6, 30);
  const dec = iso(y, 12, 31);
  if (today >= dec) return { last: dec, next: iso(y + 1, 6, 30) };
  if (today >= jun) return { last: jun, next: dec };
  return { last: iso(y - 1, 12, 31), next: jun };
}

/** The newest screen date on file across every manager, or null. */
export function latestScreenOnFile(store: ManagersStore): string | null {
  let max: string | null = null;
  for (const m of Object.values(store.managers ?? {})) for (const s of m.screens ?? []) if (!max || s.date > max) max = s.date;
  return max;
}

/** A screen is due when nothing on file is as recent as the last Jun 30 / Dec 31. */
export function screenStatus(store: ManagersStore, today: string): { due: boolean; last: string; next: string; onFile: string | null } {
  const { last, next } = nextScreenDue(today);
  const onFile = latestScreenOnFile(store);
  return { due: !onFile || onFile < last, last, next, onFile };
}

/**
 * The three entries named in the team session. Added ONLY when the person
 * presses "Add the three seed entries" — never automatically — and never over
 * an entry that already exists.
 */
export const SEED_MANAGERS: Pick<Manager, "manager" | "firm" | "fundName" | "fundCode" | "category" | "goAnywhere" | "status" | "notes">[] = [
  { manager: "Arup Datta", firm: "Mackenzie", fundName: "Mackenzie GQE Global Equity", fundCode: "", category: "Global equity", goAnywhere: false, status: "Watching", notes: "" },
  { manager: "", firm: "Dimensional", fundName: "Dimensional Canadian equity fund (exact fund to be confirmed)", fundCode: "", category: "Canadian equity", goAnywhere: false, status: "Watching", notes: "" },
  { manager: "Schmel", firm: "", fundName: "", fundCode: "", category: "Global equity", goAnywhere: false, status: "Owned", notes: "Firm, fund and category to be confirmed." },
];

/** The seed entries not already in the store, ready to add. */
export function missingSeeds(store: ManagersStore, now: string): Manager[] {
  const out: Manager[] = [];
  for (const s of SEED_MANAGERS) {
    const id = managerId(s);
    if (!id || store.managers?.[id]) continue;
    out.push({ ...s, id, sectorFund: false, sectorName: "", wholesaler: "", screens: [], annual: [], updatedAt: now, history: [] });
  }
  return out;
}
