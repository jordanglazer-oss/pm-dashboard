/** The monthly portfolio meeting falls on the first Monday of each month. */

const isoToday = () => new Date().toISOString().slice(0, 10);

/** First Monday of the month containing `from`, or of the next month when that
 *  day has already passed (the monthly portfolio meeting). */
export function nextFirstMonday(from: string = isoToday()): string {
  const firstMondayOf = (y: number, m: number): string => {
    const d = new Date(Date.UTC(y, m, 1));
    const offset = (8 - d.getUTCDay()) % 7; // Sun=0 → 1, Mon=1 → 0, Tue=2 → 6 …
    d.setUTCDate(1 + offset);
    return d.toISOString().slice(0, 10);
  };
  const base = new Date(`${from}T00:00:00Z`);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const thisMonth = firstMondayOf(y, m);
  return thisMonth > from ? thisMonth : firstMondayOf(m === 11 ? y + 1 : y, (m + 1) % 12);
}
