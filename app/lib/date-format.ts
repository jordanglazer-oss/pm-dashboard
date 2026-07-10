/**
 * Timezone-stable formatting for plain calendar-date strings (YYYY-MM-DD).
 *
 * `new Date("2026-07-15")` parses as UTC midnight, so toLocaleDateString() in a
 * behind-UTC zone (e.g. America/Toronto) renders it as the PREVIOUS day. These
 * helpers parse the Y/M/D components into a LOCAL date instead, so the calendar
 * date the string represents is what shows — no off-by-one.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse a YYYY-MM-DD string into a LOCAL Date at midnight (no UTC shift).
 *  Returns null if the string isn't a valid leading Y-M-D. */
export function parseYmdLocal(ymd: string | undefined | null): Date | null {
  if (!ymd) return null;
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Format a YYYY-MM-DD string as its calendar date (default "Jul 15"). Falls
 *  back to the raw string if it can't be parsed. */
export function formatYmd(
  ymd: string | undefined | null,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  const dt = parseYmdLocal(ymd);
  if (!dt) return ymd ?? "—";
  return dt.toLocaleDateString("en-US", opts);
}

/** Whole days from today (local) to a YYYY-MM-DD date. 0 = today, negative =
 *  past, positive = future. Null if unparseable. */
export function daysUntilYmd(ymd: string | undefined | null): number | null {
  const dt = parseYmdLocal(ymd);
  if (!dt) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dt.getTime() - today.getTime()) / 864e5);
}
