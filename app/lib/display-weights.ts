/**
 * Display rounding for model weights.
 *
 * WHY THIS EXISTS. The weights on the Models and Positioning pages are not
 * just read — they are TYPED INTO the firm's modelling software, which accepts
 * two decimal places and nothing more. So what is on screen has to be the real
 * input, not a friendly approximation of it. Two things follow:
 *
 *   1. Every number is exactly 2dp.
 *   2. The 2dp numbers must still ADD UP — a column of rounded weights whose
 *      total is 99.99% is not usable, because the PM cannot enter it.
 *
 * Naive `toFixed(2)` per cell fails (2) constantly: round 30 holdings
 * independently and the errors accumulate into a total that misses by a few
 * hundredths. This module apportions instead — it rounds every value, measures
 * the shortfall against the total, and hands the odd hundredths of a percent to
 * the entries that were rounded the hardest (largest-remainder). The result is
 * 2dp everywhere AND a column that sums exactly to its category total.
 *
 * A second, subtler rule: anything that COMPARES two weights (a drift colour,
 * an over/under badge, a "changed" highlight) must compare the DISPLAYED
 * values, not the underlying floats. Otherwise a row whose target and dynamic
 * weight both display as 1.82% still renders red, because at full precision
 * they differ in the ninth decimal. Use `sameAtDisplay` for those checks.
 *
 * Units: functions take and return FRACTIONS (0.0182 = 1.82%), and every value
 * returned is an exact multiple of 0.0001 — i.e. it survives a `× 100` and a
 * `toFixed(2)` with no further rounding.
 */

/** Hundredths of a percent — the smallest unit the modelling software takes. */
const UNITS_PER_WHOLE = 10_000;

/** Round a fraction to the nearest 0.01%. */
export function round2(v: number): number {
  return Math.round(v * UNITS_PER_WHOLE) / UNITS_PER_WHOLE;
}

/** Format a fraction as a 2dp percent string. */
export function fmtPct2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // round2 first so the value handed to toFixed is already on the grid and
  // cannot land on a banker's-rounding edge (e.g. 1.005 → "1.00" vs "1.01").
  return `${(round2(v) * 100).toFixed(2)}%`;
}

/** Do two weights display as the same number? The only correct way to ask
 *  whether a drift is worth colouring — see the note above. */
export function sameAtDisplay(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.round(a * UNITS_PER_WHOLE) === Math.round(b * UNITS_PER_WHOLE);
}

/**
 * Round every value to 2dp such that the results sum EXACTLY to `total`
 * (itself rounded to 2dp; defaults to the sum of the inputs).
 *
 * Largest-remainder: round each value to the nearest hundredth of a percent,
 * then hand out (or take back) the leftover hundredths one at a time, starting
 * with whichever entry the rounding treated worst. That keeps every cell within
 * half a hundredth of its true value while making the column tie exactly.
 *
 * `null` / non-finite entries pass through as `null` and never absorb an
 * adjustment. Entries that are exactly zero are also never adjusted — a holding
 * with no weight must not acquire a phantom 0.01%.
 */
export function apportion2(
  values: (number | null | undefined)[],
  total?: number,
): (number | null)[] {
  const exact = values.map((v) => (v != null && Number.isFinite(v) ? v * UNITS_PER_WHOLE : null));
  const rounded = exact.map((u) => (u == null ? null : Math.round(u)));

  const targetUnits = Math.round(
    (total != null && Number.isFinite(total)
      ? total
      : exact.reduce<number>((s, u) => s + (u ?? 0), 0) / UNITS_PER_WHOLE) * UNITS_PER_WHOLE,
  );
  const currentUnits = rounded.reduce<number>((s, u) => s + (u ?? 0), 0);
  let diff = targetUnits - currentUnits;

  if (diff !== 0) {
    // Adjustable entries only: present, non-zero, and (when taking weight
    // back) not already at zero — so no cell can be pushed negative.
    const candidates = exact
      .map((u, i) => ({ i, residual: u == null ? 0 : u - (rounded[i] as number), u }))
      .filter((c) => c.u != null && Math.round(c.u) !== 0);

    // Give to the most under-rounded first; take from the most over-rounded.
    candidates.sort((a, b) => (diff > 0 ? b.residual - a.residual : a.residual - b.residual));

    // One hundredth of a percent per pass, cycling if the shortfall exceeds
    // the number of candidates (only possible when `total` is far from the
    // inputs' own sum, e.g. a class that genuinely doesn't add up).
    let guard = Math.abs(diff) + candidates.length;
    let k = 0;
    while (diff !== 0 && candidates.length > 0 && guard-- > 0) {
      const c = candidates[k % candidates.length];
      const step = diff > 0 ? 1 : -1;
      const next = (rounded[c.i] as number) + step;
      if (next >= 0) {
        rounded[c.i] = next;
        diff -= step;
      }
      k++;
    }
  }

  return rounded.map((u) => (u == null ? null : u / UNITS_PER_WHOLE));
}

/**
 * Apportion a column and return both the display values and the exact total
 * they sum to — so a TOTAL row can print the sum of what is actually on screen
 * rather than a separately-rounded figure that may disagree with it by a
 * hundredth.
 */
export function apportionColumn(
  values: (number | null | undefined)[],
  total?: number,
): { values: (number | null)[]; total: number } {
  const out = apportion2(values, total);
  return { values: out, total: out.reduce<number>((s, v) => s + (v ?? 0), 0) };
}
