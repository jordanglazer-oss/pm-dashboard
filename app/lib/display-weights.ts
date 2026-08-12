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
 * the shortfall against the total, and places the odd hundredths of a percent
 * deliberately. The result is 2dp everywhere AND a column that sums exactly to
 * its category total.
 *
 * WHERE THE ODD HUNDREDTHS GO. Not just "the worst-rounded cells" — that
 * invents differences. Thirty stocks pinned at the same weight ARE the same
 * weight, and handing the remainder to an arbitrary nineteen of them puts
 * 1.19% beside 1.20% for identical positions. So:
 *
 *   - Entries with equal values form a TIE GROUP and move together or not at
 *     all. Equal inputs always display equally.
 *   - The remainder is absorbed by entries whose value is UNIQUE — in a model
 *     that is the core ETFs, which are the residual absorbers by construction,
 *     so this mirrors where the real rebalance puts the odd basis points. An
 *     absorber can therefore move by more than 0.01% (observed worst case
 *     ~0.08% on a large ETF); a tied holding never does.
 *   - Ties are broken only when nothing else can absorb — the column adding up
 *     outranks it, because a total that is off by a hundredth cannot be
 *     entered into the modelling software at all.
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
 * Round each value to the nearest hundredth of a percent, then place the
 * leftover hundredths per the tie-group rules described at the top of this
 * file: equal values move together, and the remainder lands on the unique
 * absorbers.
 *
 * `null` / non-finite entries pass through as `null` and never absorb an
 * adjustment. Entries that are exactly zero are also never adjusted — a holding
 * with no weight must not acquire a phantom 0.01%. No adjustment may flip a
 * value's sign.
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
    // Adjustable entries only: present and non-zero, so no holding without a
    // weight can acquire a phantom 0.01%.
    const adjustable = exact
      .map((u, i) => ({ i, residual: u == null ? 0 : u - (rounded[i] as number), u }))
      .filter((c) => c.u != null && Math.round(c.u) !== 0);

    // ── Tie groups ─────────────────────────────────────────────────────────
    // EQUAL INPUTS MUST PRODUCE EQUAL OUTPUTS. Thirty stocks pinned at the
    // same weight are the same weight; if largest-remainder hands the odd
    // hundredths to an arbitrary nineteen of them, the table invents a
    // distinction the model does not contain, and the PM sees 1.19% beside
    // 1.20% for positions that are identical.
    //
    // So entries are grouped by value, and a group is only ever adjusted as a
    // whole — every member moves together or none does.
    const keyOf = (u: number) => Math.round(u * 1e6) / 1e6;
    const groups = new Map<number, typeof adjustable>();
    for (const c of adjustable) {
      const k = keyOf(c.u as number);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }

    // Pass 1: a group takes a uniform per-member step only when its OWN
    // rounding shortfall justifies a full hundredth each — so a group of 30
    // that is collectively 0.135% short does not get 0.01% per member (which
    // would overshoot by 0.165%); it stays put and the absorbers cover it.
    for (const members of groups.values()) {
      const groupResidual = members.reduce((s, c) => s + c.residual, 0);
      const step = Math.round(groupResidual / members.length);
      if (step === 0) continue;
      const applied = step * members.length;
      // Never overshoot the target in the process of tidying a group.
      if (Math.abs(applied) > Math.abs(diff) || Math.sign(applied) !== Math.sign(diff)) continue;
      if (members.some((c) => (rounded[c.i] as number) + step < 0)) continue;
      for (const c of members) rounded[c.i] = (rounded[c.i] as number) + step;
      diff -= applied;
    }

    // Pass 2: the remainder goes to entries whose value is UNIQUE — in a model
    // that means the core ETFs, which are the residual absorbers by
    // construction, so this mirrors how the real rebalance places the odd
    // basis points. Tied groups are only broken if there is nothing unique to
    // absorb (a class of entirely identical holdings), where some split is
    // unavoidable.
    const distribute = (pool: typeof adjustable) => {
      if (pool.length === 0) return;
      pool.sort((a, b) => (diff > 0 ? b.residual - a.residual : a.residual - b.residual));
      let guard = Math.abs(diff) + pool.length;
      let k = 0;
      let blocked = 0;
      while (diff !== 0 && blocked < pool.length && guard-- > 0) {
        const c = pool[k % pool.length];
        const step = diff > 0 ? 1 : -1;
        const cur = rounded[c.i] as number;
        const next = cur + step;
        // An adjustment may not flip a weight's sign — a positive holding must
        // not go negative, and a negative figure (a drift column) must not be
        // nudged positive.
        const ok = (c.u as number) > 0 ? next >= 0 : next <= 0;
        if (ok) {
          rounded[c.i] = next;
          diff -= step;
          blocked = 0;
        } else {
          blocked++;
        }
        k++;
      }
    };

    const unique = adjustable.filter((c) => (groups.get(keyOf(c.u as number))?.length ?? 0) === 1);
    distribute(unique);
    // If the unique absorbers could not take it all — or there were none —
    // fall back to the full set. Keeping tied positions identical matters, but
    // it does NOT outrank the column adding up: a total that is off by a
    // hundredth cannot be entered into the modelling software at all.
    if (diff !== 0) distribute(adjustable);
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
