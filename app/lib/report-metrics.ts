/**
 * Pure-math helpers for the Client Report one-pager. Operate on
 * aligned daily price series (no FX, no weighting — those are applied
 * upstream by `useReportData`).
 *
 * All functions are tolerant of gaps (NaN / undefined / non-finite
 * values) and short histories: they degrade to `null` rather than
 * throwing, so the report UI can render "N/A" for metrics we can't
 * compute with confidence.
 *
 * Conventions:
 *   - `prices` arrays are ordered oldest → newest, daily closes (or
 *     whatever cadence the upstream fetcher provides — all metrics
 *     annualize at 252 trading days so daily is the assumed input).
 *   - Returns here are expressed as fractions (0.05 = +5%), not
 *     percentages. The UI multiplies by 100 for display.
 */

const TRADING_DAYS_PER_YEAR = 252;

/** Convert an oldest→newest price series into a return series. */
export function dailyReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1];
    const p1 = prices[i];
    if (!isFinite(p0) || !isFinite(p1) || p0 <= 0) continue;
    out.push(p1 / p0 - 1);
  }
  return out;
}

/**
 * Annualized return (CAGR) over `years` years, computed from the first
 * and last valid prices in the series. Caller passes a series trimmed
 * to the desired window — we don't re-window here.
 */
export function annualizedReturn(prices: readonly number[], years: number): number | null {
  if (!prices || prices.length < 2 || years <= 0) return null;
  const start = prices[0];
  const end = prices[prices.length - 1];
  if (!isFinite(start) || !isFinite(end) || start <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

/**
 * Annualized volatility: std-dev of daily returns × √252. Returns null
 * if fewer than 20 return observations (avoid reporting garbage for
 * sub-month windows).
 */
export function annualizedVolatility(returns: readonly number[]): number | null {
  if (!returns || returns.length < 20) return null;
  const n = returns.length;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let sqSum = 0;
  for (const r of returns) sqSum += (r - mean) ** 2;
  // Sample std-dev (n-1 denominator).
  const variance = sqSum / (n - 1);
  if (!isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Upside / downside capture vs a benchmark — Morningstar methodology.
 *
 * Definition (matches Morningstar Direct / CFA Institute):
 *   1. Separate the aligned period returns into up-market periods
 *      (benchmark return > 0) and down-market periods (benchmark < 0).
 *   2. Geometrically compound the portfolio AND the benchmark over
 *      each set: R_cum = ∏(1 + r_i) − 1.
 *   3. Annualize BOTH sides using the same exponent based on the
 *      number of periods: R_ann = (1 + R_cum)^(periodsPerYear / N) − 1.
 *   4. Upside  = R_ann_port_up  / R_ann_bench_up  × 100.
 *      Downside = R_ann_port_dn  / R_ann_bench_dn  × 100.
 *
 * A down-capture < 100 means the portfolio lost less than the benchmark
 * on down-periods (good). An up-capture > 100 means it gained more on
 * up-periods (good). Capture > 100 on the downside (or < 100 on the
 * upside) is bad.
 *
 * Morningstar computes this from MONTHLY returns (periodsPerYear = 12).
 * Daily returns (252) are also supported but introduce more noise and
 * more small-magnitude up-days, which typically inflates up-capture
 * toward 100 because tiny-positive bench days are treated the same as
 * meaningful rallies. Prefer monthly.
 *
 * `portfolioReturns` and `benchmarkReturns` must be aligned — same
 * length, same periods. Pairs containing a non-finite value on either
 * side are skipped.
 */
export function captureRatios(
  portfolioReturns: readonly number[],
  benchmarkReturns: readonly number[],
  periodsPerYear: number = TRADING_DAYS_PER_YEAR
): { upside: number | null; downside: number | null } {
  if (
    !portfolioReturns ||
    !benchmarkReturns ||
    portfolioReturns.length !== benchmarkReturns.length ||
    portfolioReturns.length < 1
  ) {
    return { upside: null, downside: null };
  }

  // Compound portfolio and benchmark separately over up/down periods.
  let upPort = 1;
  let upBench = 1;
  let upCount = 0;
  let downPort = 1;
  let downBench = 1;
  let downCount = 0;

  for (let i = 0; i < portfolioReturns.length; i++) {
    const p = portfolioReturns[i];
    const b = benchmarkReturns[i];
    if (!isFinite(p) || !isFinite(b)) continue;
    if (b > 0) {
      upPort *= 1 + p;
      upBench *= 1 + b;
      upCount++;
    } else if (b < 0) {
      downPort *= 1 + p;
      downBench *= 1 + b;
      downCount++;
    }
    // b === 0 exactly is dropped from both sets.
  }

  // Minimum sample on each side. For monthly input, 6 periods is the
  // smallest window where the ratio is remotely stable; for daily input
  // the caller is responsible for feeding at least ~6 months.
  const MIN_PERIODS = periodsPerYear >= 200 ? 30 : 6;

  // Annualize both cumulative returns with the same exponent before
  // taking the ratio. Using the raw cumulative ratio biases the number
  // whenever the portfolio and benchmark have different up-day counts —
  // annualization rescales both to a comparable 1-year horizon.
  const annualize = (cum: number, n: number): number | null => {
    if (n <= 0 || !isFinite(cum) || cum <= 0) return null;
    return Math.pow(cum, periodsPerYear / n) - 1;
  };

  const portUpAnn = annualize(upPort, upCount);
  const benchUpAnn = annualize(upBench, upCount);
  const portDnAnn = annualize(downPort, downCount);
  const benchDnAnn = annualize(downBench, downCount);

  const upside =
    upCount >= MIN_PERIODS &&
    portUpAnn != null &&
    benchUpAnn != null &&
    Math.abs(benchUpAnn) > 1e-6
      ? (portUpAnn / benchUpAnn) * 100
      : null;
  const downside =
    downCount >= MIN_PERIODS &&
    portDnAnn != null &&
    benchDnAnn != null &&
    Math.abs(benchDnAnn) > 1e-6
      ? (portDnAnn / benchDnAnn) * 100
      : null;

  return { upside, downside };
}

/**
 * Resample a daily `[epochMs, price]` series to end-of-month closes,
 * returning a flat price array suitable for `dailyReturns()` (which,
 * despite the name, is just "consecutive ratio - 1" and works for any
 * cadence). We pick the LAST observation of each calendar month.
 *
 * Used to feed monthly returns into `captureRatios` — which is the
 * standard Morningstar cadence — without throwing away the daily data
 * the rest of the report already consumes.
 */
export function monthlyPricesFromDaily(
  series: ReadonlyArray<readonly [number, number]>
): number[] {
  if (!series.length) return [];
  const lastByMonth = new Map<string, { t: number; p: number }>();
  for (const [t, p] of series) {
    if (!isFinite(t) || !isFinite(p) || p <= 0) continue;
    const d = new Date(t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const existing = lastByMonth.get(key);
    if (!existing || t >= existing.t) lastByMonth.set(key, { t, p });
  }
  // Order oldest → newest by the composite key (year-month sorts lexically).
  return [...lastByMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, v]) => v.p);
}

/**
 * Align two price series by date so they can be fed into
 * `captureRatios`. Inputs are `[epochMs, price]` rows; output is a pair
 * of price arrays with the same length, covering only dates present in
 * both series.
 */
export function alignSeries(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>
): { a: number[]; b: number[] } {
  const bMap = new Map<number, number>();
  for (const [t, p] of b) {
    // Normalize to a day bucket so off-by-seconds timestamps still align.
    bMap.set(Math.floor(t / 86_400_000), p);
  }
  const aOut: number[] = [];
  const bOut: number[] = [];
  for (const [t, p] of a) {
    const key = Math.floor(t / 86_400_000);
    const bp = bMap.get(key);
    if (bp == null || !isFinite(bp) || !isFinite(p)) continue;
    aOut.push(p);
    bOut.push(bp);
  }
  return { a: aOut, b: bOut };
}

/**
 * Trim a price series to the last `years` years. Expects oldest→newest
 * ordering with `[epochMs, price]` rows.
 */
export function windowYears(
  series: ReadonlyArray<readonly [number, number]>,
  years: number
): Array<readonly [number, number]> {
  if (!series.length) return [];
  const cutoff = series[series.length - 1][0] - years * 365.25 * 86_400_000;
  const out: Array<readonly [number, number]> = [];
  for (const row of series) {
    if (row[0] >= cutoff) out.push(row);
  }
  return out;
}
