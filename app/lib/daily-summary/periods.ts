/**
 * Period-return math shared by the daily summary. Server-side port of
 * `computePeriodReturns` from the AA Performance page (trading-day offsets on
 * an index-style value series), trimmed to the windows the summary shows.
 * Pure — no I/O.
 */

export type Period = "1d" | "1w" | "1m" | "3m" | "ytd";
export const PERIODS: Period[] = ["1d", "1w", "1m", "3m", "ytd"];
export type PeriodReturns = Record<Period, number | null>;

export type ValuePoint = { date: string; value: number };

const TRADING_DAYS: Record<Exclude<Period, "ytd">, number> = { "1d": 1, "1w": 5, "1m": 21, "3m": 63 };

export function emptyReturns(): PeriodReturns {
  return { "1d": null, "1w": null, "1m": null, "3m": null, ytd: null };
}

/** Dedupe by date (last wins), drop non-finite, sort ascending. */
export function normalizeSeries(raw: readonly { date: string; value: number }[]): ValuePoint[] {
  const seen = new Map<string, number>();
  for (const e of raw) {
    if (e && typeof e.date === "string" && typeof e.value === "number" && isFinite(e.value) && e.value > 0) {
      seen.set(e.date.slice(0, 10), e.value);
    }
  }
  return [...seen.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

function pctChange(from: number, to: number): number | null {
  if (!isFinite(from) || !isFinite(to) || from <= 0) return null;
  return parseFloat(((to / from - 1) * 100).toFixed(2));
}

/** Period returns ending at the LAST point of the series (optionally ending at
 *  index `endIdx`, so a "one week ago" reading can be taken off the same
 *  series). Windows are trading-day offsets, YTD is vs the last point of the
 *  prior calendar year. */
export function periodReturns(series: ValuePoint[], endIdx: number = series.length - 1): PeriodReturns {
  const out = emptyReturns();
  if (endIdx < 1 || endIdx >= series.length) return out;
  const last = series[endIdx];
  for (const key of Object.keys(TRADING_DAYS) as Array<keyof typeof TRADING_DAYS>) {
    const days = TRADING_DAYS[key];
    const i = endIdx - days;
    if (i < 0) continue;
    out[key] = pctChange(series[i].value, last.value);
  }
  const year = last.date.slice(0, 4);
  let base: ValuePoint | null = null;
  for (let i = 0; i <= endIdx; i++) {
    if (series[i].date < `${year}-01-01`) base = series[i];
    else break;
  }
  out.ytd = base ? pctChange(base.value, last.value) : null;
  return out;
}

/** Return from the last point on/before `startDate` to the last point. */
export function returnSince(series: ValuePoint[], startDate: string): number | null {
  if (series.length < 2) return null;
  let base: ValuePoint | null = null;
  for (const p of series) {
    if (p.date <= startDate) base = p;
    else break;
  }
  if (!base) return null;
  return pctChange(base.value, series[series.length - 1].value);
}

/** Element-wise a − b (null when either side is null). */
export function diffReturns(a: PeriodReturns, b: PeriodReturns): PeriodReturns {
  const out = emptyReturns();
  for (const p of PERIODS) {
    out[p] = a[p] == null || b[p] == null ? null : parseFloat((a[p]! - b[p]!).toFixed(2));
  }
  return out;
}
