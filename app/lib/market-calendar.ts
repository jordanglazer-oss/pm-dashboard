/**
 * US market calendar helpers.
 *
 * Today this answers one question: is it a weekday in New York? The nightly
 * digest fires at 06:00 UTC (≈01:00–02:00 ET) and reports the most recent
 * close, so a Saturday send carries Friday's close and a Sunday send carries
 * the same Friday close again — the second is pure noise. Suppressing BOTH
 * weekend sends and letting Monday's email carry Friday's close loses nothing
 * and keeps the inbox to Mon–Fri.
 *
 * DST-correct by construction: the weekday comes from Intl in the
 * America/New_York zone rather than from UTC arithmetic.
 *
 * Deliberately NOT holiday-aware. On a market holiday the digest is still the
 * FIRST email carrying the prior session's close (e.g. a Monday July 4 email
 * carries Friday's close), so suppressing by holiday would drop real
 * information. The only redundant case is the day AFTER a holiday, which is at
 * most a handful of extra emails a year — not worth a calendar to maintain.
 */

/** True Mon–Fri in New York; false Sat/Sun. */
export function isTradingWeekdayET(now: Date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return weekday !== "Sat" && weekday !== "Sun";
}
