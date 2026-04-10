/**
 * Market hours helpers for the US/Eastern equity market.
 *
 * Used to gate "today's return" computations until after the market has
 * actually opened. Before 9:30 AM ET, Yahoo's regularMarketPrice still
 * reports yesterday's closing price while chartPreviousClose reports the
 * day before that — so any return computed pre-market is actually
 * yesterday's return mislabeled as today's.
 */

/** Returns today's date in YYYY-MM-DD format using America/New_York. */
export function getTodayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Returns true if it is currently a US/Eastern weekday and the time is
 * 9:30 AM ET or later. Does not account for market holidays or early closes;
 * the goal is just to prevent pre-open data from being captured as "today".
 */
export function isMarketOpenOrAfterET(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);

  if (weekday === "Sat" || weekday === "Sun") return false;
  if (hour > 9) return true;
  if (hour === 9 && minute >= 30) return true;
  return false;
}
