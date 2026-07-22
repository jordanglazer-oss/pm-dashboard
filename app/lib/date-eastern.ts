/**
 * Canonical US-Eastern (America/New_York) date helpers.
 *
 * The dashboard's "today" is the North-American trading day — Toronto / New
 * York / Montreal all share the Eastern calendar. Deriving it from
 * `new Date().toISOString()` uses UTC, which rolls to the next day at ~8 PM ET
 * (EDT) / 7 PM ET (EST): a brief generated in the evening would compute a
 * "today" that is already tomorrow, mislabeling same-day earnings and dropping
 * events from the look-ahead window. Everything user-facing that answers "what
 * day is it / how far away is this event" MUST route through here.
 *
 * Implemented with Intl timeZone formatting so it is correct regardless of the
 * server's own timezone (Vercel runs UTC) and handles EST/EDT automatically.
 */

const TZ = "America/New_York";

/** Calendar date in US Eastern as YYYY-MM-DD (en-CA yields ISO order). */
export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Long human date in US Eastern, e.g. "Tuesday, July 21, 2026". */
export function easternLongDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
}

/** Whole calendar days from `todayStr` to a YYYY-MM-DD date (positive = future,
 *  0 = today, negative = past). Both parsed at UTC midnight so the diff is an
 *  exact day count with no DST drift. NaN on malformed input. */
export function daysFromToday(dateStr: string, todayStr: string = easternToday()): number {
  const a = Date.parse(`${todayStr}T00:00:00Z`);
  const b = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Whole calendar days SINCE a YYYY-MM-DD date, in US Eastern (positive = past,
 *  0 = today, negative = future). Null on malformed input — mirrors the
 *  null-on-NaN contract callers rely on for gating. */
export function daysSinceEastern(dateStr: string, todayStr: string = easternToday()): number | null {
  const n = daysFromToday(dateStr, todayStr);
  return isNaN(n) ? null : -n;
}

/** Current hour (0-23) in US Eastern, regardless of server timezone. Used to
 *  gate evening-only actions (e.g. fire an earnings email AFTER the close). */
export function easternHour(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now);
  const n = parseInt(h, 10);
  if (isNaN(n)) return now.getUTCHours();
  return n === 24 ? 0 : n; // some ICU builds emit "24" at midnight
}

/** Weekday + month/day for a bare YYYY-MM-DD, formatted without shifting the
 *  calendar day (parse at UTC midnight, format in UTC). E.g. "Wed, Jul 22". */
export function weekdayLabel(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) return dateStr;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(ms);
}

/**
 * Deterministic relative-day label anchored to Eastern-today, e.g.
 * "TODAY (Tue, Jul 21)", "TOMORROW (Wed, Jul 22)", "in 3 days (Fri, Jul 24)",
 * "2d ago (Sun, Jul 19)". Feeding this to the model removes its need to compute
 * "tonight/tomorrow" from a raw ISO date — the exact error that put "report
 * tonight (July 22)" in a July-21 brief.
 */
export function relativeDayLabel(dateStr: string, todayStr: string = easternToday()): string {
  const n = daysFromToday(dateStr, todayStr);
  const wd = weekdayLabel(dateStr);
  if (isNaN(n)) return dateStr;
  let rel: string;
  if (n === 0) rel = "TODAY";
  else if (n === 1) rel = "TOMORROW";
  else if (n === -1) rel = "yesterday";
  else if (n < 0) rel = `${Math.abs(n)}d ago`;
  else rel = `in ${n} days`;
  return `${rel} (${wd})`;
}
