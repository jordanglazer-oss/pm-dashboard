/**
 * "Which market close do these numbers describe?" — worked out automatically
 * (Nov 2026), so nobody has to set a date when typing in end-of-day market
 * data such as breadth.
 *
 *   typed before 4:00 pm Eastern  → the previous trading day's close
 *   typed at or after 4:00 pm     → today's close
 *   weekends and US market holidays roll back to the last day the market
 *   was open.
 *
 * US (NYSE) full-day holidays are computed, not listed, so there is no table
 * to maintain. Early closes (the 1 pm sessions) are still trading days and
 * need no special case: their close exists by 4 pm like any other.
 *
 * PURE and safe to import on the client and the server. No Redis, no fetch.
 */

const ET = "America/New_York";
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Day of week for a calendar date, 0 = Sunday. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** The nth given weekday of a month (n = 1…4), e.g. the 3rd Monday of January. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = dow(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
/** The last given weekday of a month. */
function lastWeekday(y: number, m: number, weekday: number): number {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return days - ((dow(y, m, days) - weekday + 7) % 7);
}
/** Easter Sunday (Gregorian), as [month, day]. */
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}
function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** NYSE full-day holidays for a year, as YYYY-MM-DD. */
export function usMarketHolidays(year: number): string[] {
  const out: string[] = [];
  // A fixed-date holiday on Saturday is observed the Friday before, on Sunday
  // the Monday after — EXCEPT New Year's Day on a Saturday, which the exchange
  // does not observe (the Friday is the prior year's last trading day).
  const observed = (m: number, d: number, saturdayRule = true) => {
    const w = dow(year, m, d);
    if (w === 6) {
      if (saturdayRule) out.push(shift(iso(year, m, d), -1));
    } else if (w === 0) out.push(shift(iso(year, m, d), 1));
    else out.push(iso(year, m, d));
  };
  observed(1, 1, false); // New Year's Day
  out.push(iso(year, 1, nthWeekday(year, 1, 1, 3))); // Martin Luther King Jr. Day
  out.push(iso(year, 2, nthWeekday(year, 2, 1, 3))); // Washington's Birthday
  const [em, ed] = easter(year);
  out.push(shift(iso(year, em, ed), -2)); // Good Friday
  out.push(iso(year, 5, lastWeekday(year, 5, 1))); // Memorial Day
  observed(6, 19); // Juneteenth
  observed(7, 4); // Independence Day
  out.push(iso(year, 9, nthWeekday(year, 9, 1, 1))); // Labor Day
  out.push(iso(year, 11, nthWeekday(year, 11, 4, 4))); // Thanksgiving
  observed(12, 25); // Christmas
  return out.sort();
}

/** True when US equity markets trade on this calendar date. */
export function isUsTradingDay(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const w = dow(y, m, d);
  if (w === 0 || w === 6) return false;
  // New Year's Day observed on a Monday belongs to that year's list; a
  // Christmas observed the Friday before belongs to its own year — both are
  // covered by checking the date's own year.
  return !usMarketHolidays(y).includes(date);
}

/** The Eastern calendar date and hour for an instant. */
function easternParts(now: Date): { date: string; hour: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  // "24" is how some engines print midnight.
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/**
 * The most recent market close as of `now` (YYYY-MM-DD): today once it is
 * 4 pm Eastern on a trading day, otherwise the trading day before.
 */
export function lastMarketClose(now: Date = new Date()): string {
  const { date, hour } = easternParts(now);
  let d = isUsTradingDay(date) && hour >= 16 ? date : shift(date, -1);
  // Never loops more than a few days: the longest closure is a long weekend.
  for (let i = 0; i < 10 && !isUsTradingDay(d); i++) d = shift(d, -1);
  return d;
}

/** "Mon Nov 23" for a YYYY-MM-DD date. */
export function closeLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
