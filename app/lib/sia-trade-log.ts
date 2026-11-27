/**
 * The trade log from an SIA transaction log (Nov 2026): every buy, add, trim
 * and sale, with the realized gain or loss on each sale against the average
 * cost at that moment. Pure — no I/O. READ-ONLY use (Performance › Trade log).
 *
 * Same conventions as sia-cost.ts: units in today's share terms, cost in C$
 * (the log's prices are C$), a sale removes cost in proportion, a day's buys
 * are applied before its sells, and a sliver left after a full sale is not a
 * position. A sale from a holding whose cost is incomplete (a purchase logged
 * at price 0) carries no gain — never guessed.
 */

import { siaSymbol, splitFactorAfter, SIA_SPLITS, type SiaTxn, type SplitTable } from "./sia-holdings";

export type TradeKind = "Bought" | "Added" | "Trimmed" | "Sold";
export type TradeRow = {
  date: string;
  symbol: string;
  kind: TradeKind;
  /** Units traded, as logged. */
  units: number;
  /** C$ price per unit, as logged. */
  price: number;
  /** C$ amount of the trade. */
  amount: number;
  /** Sales only: average C$ cost per unit (as-logged share terms) just before the sale. */
  avgCost: number | null;
  /** Sales only: sale price vs average cost, %. */
  gainPct: number | null;
  /** Sales only: C$ realized in the model account. */
  gain: number | null;
  /** Sales only: why no gain is shown. */
  note?: string;
};

export function siaTradeLog(txns: SiaTxn[], splits: SplitTable = SIA_SPLITS): TradeRow[] {
  const by = new Map<string, SiaTxn[]>();
  for (const t of txns) {
    const sym = siaSymbol(t.symbol);
    by.set(sym, [...(by.get(sym) ?? []), t]);
  }
  const out: TradeRow[] = [];
  for (const [symbol, list] of by) {
    const sorted = [...list].sort((m, n) => m.date.localeCompare(n.date));
    let u = 0;
    let cost = 0;
    let peak = 0;
    let incomplete = false;
    for (let i = 0; i < sorted.length; ) {
      const day = sorted[i].date;
      const f = splitFactorAfter(symbol, day, splits);
      const today: SiaTxn[] = [];
      for (; i < sorted.length && sorted[i].date === day; i++) today.push(sorted[i]);
      for (const t of today.filter((x) => x.action === "BUY")) {
        out.push({ date: day, symbol, kind: u > 0 ? "Added" : "Bought", units: t.units, price: t.price, amount: t.units * t.price, avgCost: null, gainPct: null, gain: null });
        u += t.units * f;
        cost += t.units * t.price;
        if (!(t.price > 0)) incomplete = true;
      }
      for (const t of today.filter((x) => x.action === "SELL")) {
        const sold = t.units * f;
        const share = u > 0 ? Math.min(1, sold / u) : 0;
        const costOut = cost * share;
        const left = u - sold;
        const full = !(left > 1e-6 && left > Math.max(peak, u) * 0.005);
        const known = u > 0 && !incomplete && costOut > 0;
        const reason = !(u > 0) ? "no position on file before this sale" : incomplete ? "a purchase was logged with no price" : "no cost on file";
        out.push({
          date: day,
          symbol,
          kind: full ? "Sold" : "Trimmed",
          units: t.units,
          price: t.price,
          amount: t.units * t.price,
          avgCost: known ? costOut / t.units : null,
          gainPct: known ? ((t.units * t.price) / costOut - 1) * 100 : null,
          gain: known ? t.units * t.price - costOut : null,
          ...(known ? {} : { note: reason }),
        });
        cost -= costOut;
        u = left;
      }
      if (u < 0) u = 0;
      peak = Math.max(peak, u);
      if (!(u > 1e-6 && u > peak * 0.005)) {
        u = 0;
        cost = 0;
        peak = 0;
        incomplete = false;
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
}

export function tradeLogSummary(rows: TradeRow[]) {
  const sales = rows.filter((r) => r.kind === "Sold" || r.kind === "Trimmed");
  const counted = sales.filter((r) => r.gain != null);
  return {
    trades: rows.length,
    bought: rows.filter((r) => r.kind === "Bought").length,
    added: rows.filter((r) => r.kind === "Added").length,
    trimmed: rows.filter((r) => r.kind === "Trimmed").length,
    sold: rows.filter((r) => r.kind === "Sold").length,
    realized: counted.reduce((a, r) => a + (r.gain as number), 0),
    proceeds: counted.reduce((a, r) => a + r.amount, 0),
    salesNotCounted: sales.length - counted.length,
  };
}
