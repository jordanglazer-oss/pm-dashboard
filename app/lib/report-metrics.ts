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
 * Upside / downside capture vs a benchmark.
 *
 * Textbook Morningstar/CFA definition: compound the portfolio and
 * benchmark returns separately over the up-market periods and the
 * down-market periods, then divide total portfolio excess over
 * benchmark excess × 100. We deliberately do NOT annualize — when
 * the number of up-days ≠ down-days, the fractional-power annualization
 * amplifies small differences into double-digit distortions (this was
 * producing the "unrealistic" values on the Client Report page).
 *
 * Up-days  (b > 0): upside  = (∏(1+p) − 1) / (∏(1+b) − 1) × 100
 * Down-days (b < 0): downside = (∏(1+p) − 1) / (∏(1+b) − 1) × 100
 *
 * A down-capture < 100 means the portfolio lost less than the benchmark
 * on down-days (good). An up-capture > 100 means it gained more on
 * up-days (good). Both are strictly scale-invariant in sample size.
 *
 * `portfolioReturns` and `benchmarkReturns` must be aligned — same
 * length, same calendar days. Pairs containing a non-finite value on
 * either side are skipped.
 */
export function captureRatios(
  portfolioReturns: readonly number[],
  benchmarkReturns: readonly number[]
): { upside: number | null; downside: number | null } {
  if (
    !portfolioReturns ||
    !benchmarkReturns ||
    portfolioReturns.length !== benchmarkReturns.length ||
    portfolioReturns.length < 20
  ) {
    return { upside: null, downside: null };
  }

  // Accumulate compounded returns on up-days and down-days separately.
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
  }

  // Require a minimum sample of each side to avoid reporting noise.
  const MIN_DAYS = 10;
  const upBenchTotal = upBench - 1;
  const downBenchTotal = downBench - 1;

  const upside =
    upCount >= MIN_DAYS && Math.abs(upBenchTotal) > 1e-6
      ? ((upPort - 1) / upBenchTotal) * 100
      : null;
  const downside =
    downCount >= MIN_DAYS && Math.abs(downBenchTotal) > 1e-6
      ? ((downPort - 1) / downBenchTotal) * 100
      : null;

  return { upside, downside };
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
