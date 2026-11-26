/**
 * Average cost and first purchase date of each position still held, from the
 * SIA transaction log (Nov 2026). Pure — no I/O. READ-ONLY use: feeds the
 * Snapshot's "Since purchase" column and nothing else.
 *
 *   - Units are in TODAY'S share terms (same split handling as sia-holdings).
 *   - Cost is the C$ paid (the log's prices are in C$). A sale removes cost in
 *     proportion to the units sold, so the average cost per unit is unchanged
 *     by a trim.
 *   - "Since" is the first purchase of the CURRENT holding period: a name sold
 *     out and bought again starts fresh.
 *   - A purchase logged at a price of 0 (a transfer in, a reinvested
 *     distribution) makes the cost incomplete; the position is reported as
 *     such and no return is computed from it. Never guessed.
 */

import { siaSymbol, splitFactorAfter, SIA_SPLITS, type SiaTxn, type SplitTable } from "./sia-holdings";

export type SiaCost = {
  symbol: string;
  /** First purchase of the current holding period (YYYY-MM-DD). */
  since: string;
  /** Units held, in today's share terms. */
  units: number;
  /** Average C$ cost per unit (today's share terms). */
  avgCost: number;
  /** True when a purchase in this holding period was logged with no price. */
  incomplete: boolean;
};

export function siaCostBasis(txns: SiaTxn[], splits: SplitTable = SIA_SPLITS): SiaCost[] {
  const by = new Map<string, SiaTxn[]>();
  for (const t of txns) {
    const sym = siaSymbol(t.symbol);
    by.set(sym, [...(by.get(sym) ?? []), t]);
  }
  const out: SiaCost[] = [];
  for (const [symbol, list] of by) {
    const sorted = [...list].sort((m, n) => m.date.localeCompare(n.date));
    let u = 0, cost = 0, peak = 0;
    let since: string | null = null;
    let incomplete = false;
    for (let i = 0; i < sorted.length; ) {
      const day = sorted[i].date;
      const f = splitFactorAfter(symbol, day, splits);
      const today: SiaTxn[] = [];
      for (; i < sorted.length && sorted[i].date === day; i++) today.push(sorted[i]);
      // Buys before sells: a sell listed ahead of a same-day buy is not a short.
      for (const t of today.filter((x) => x.action === "BUY")) {
        if (!(u > 0)) since = day;
        u += t.units * f;
        cost += t.units * t.price;
        if (!(t.price > 0)) incomplete = true;
      }
      for (const t of today.filter((x) => x.action === "SELL")) {
        const sold = t.units * f;
        if (u > 0) cost *= Math.max(0, 1 - Math.min(1, sold / u));
        u -= sold;
      }
      if (u < 0) u = 0;
      peak = Math.max(peak, u);
      // Same rule as siaPositions: a sliver left after a full sale is not a position.
      if (!(u > 1e-6 && u > peak * 0.005)) {
        u = 0;
        cost = 0;
        peak = 0;
        since = null;
        incomplete = false;
      }
    }
    if (u > 0 && since) out.push({ symbol, since, units: u, avgCost: cost / u, incomplete });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
