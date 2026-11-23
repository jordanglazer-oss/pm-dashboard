import type { SaleEvent } from "./sales-ledger";
import type { PimTransaction } from "./pim-types";
import { baseSymbol } from "./currency-impact";

/**
 * Realized gains / losses tally — the pure maths (Nov 2026). READ-ONLY over
 * pm:pim-sales-ledger (units sold + average cost at the moment of each
 * reduction) joined to the trade log in pm:pim-portfolio-state (the price).
 *
 * A ledger entry is a fact about UNITS, not proof of a trade ("Edit
 * positions" lowering a weight is recorded too). So a sale only counts when
 * a SELL in the trade log matches it: same group, same symbol, same Eastern
 * day, and the same profile when the trade carries one. Everything else is
 * listed as "not a trade" and never counted.
 *
 *   gain (C$)  = units sold × (sale price in C$ − average cost in C$/unit)
 *   shown as   = gain ÷ the book's value just before the sale, in %
 *
 * Never dollars: Positioning is weights-only and units are notional, and
 * every client's cost base differs — this is a MODEL-LEVEL ESTIMATE. Trade
 * prices are in the instrument's own currency (US$ for US names), average
 * cost is always C$/unit, so a US$ fill is converted at that day's USD/CAD.
 * Covers sales from 2026-11-19 on (when the ledger started).
 */

export const LEDGER_STARTED = "2026-11-19";

const etDay = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(t));
};
const r4 = (n: number) => parseFloat(n.toFixed(4));

export type RealizedSale = {
  date: string;
  groupId: string;
  profile: string;
  symbol: string;
  unitsSold: number;
  /** Share of the position sold (1 = sold out). */
  shareSold: number;
  avgCostCad: number;
  salePriceCad: number;
  /** Gain on the units sold as % of their cost. */
  gainOnCostPct: number;
  /** Gain as % of the whole book just before the sale — the tally unit. */
  pctOfBook: number;
  /** Holdings valued at average cost because no price was found that day. */
  bookValuedAtCost: string[];
};
export type UncountedSale = { date: string; groupId: string; profile: string; symbol: string; shareReduced: number; why: string };
export type BookTally = { groupId: string; profile: string; gainsPct: number; lossesPct: number; netPct: number; soldAtGain: number; soldAtLoss: number };
export type RealizedTally = { year: string; coversFrom: string; sales: RealizedSale[]; uncounted: UncountedSale[]; books: BookTally[] };

export type RealizedDeps = {
  /** The symbol's trading currency, or null when it cannot be determined. */
  currencyOf: (symbol: string) => "CAD" | "USD" | null;
  /** USD/CAD close on or before the date. */
  fxOn: (date: string) => number | null;
  /** C$ price of a holding on or before the date (to value the book); null → valued at cost. */
  priceCadOn: (symbol: string, date: string) => number | null;
};

export function tallyRealized(events: SaleEvent[], txns: PimTransaction[], deps: RealizedDeps, year: string): RealizedTally {
  const sales: RealizedSale[] = [];
  const uncounted: UncountedSale[] = [];

  for (const ev of events) {
    if (!ev || typeof ev.date !== "string" || !ev.date.startsWith(year) || !Array.isArray(ev.sales)) continue;
    // The book just before the write, at that day's C$ prices (average cost where no price was found).
    const atCost: string[] = [];
    let bookValue = 0;
    for (const p of ev.bookBefore ?? []) {
      const px = deps.priceCadOn(p.symbol, ev.date);
      const ok = px != null && px > 0;
      if (!ok) atCost.push(p.symbol);
      bookValue += p.units * (ok ? px : p.costBasis);
    }

    for (const s of ev.sales) {
      const unitsSold = s.unitsBefore - s.unitsAfter;
      const shareReduced = s.unitsBefore > 0 ? r4(unitsSold / s.unitsBefore) : 0;
      const skip = (why: string) => uncounted.push({ date: ev.date, groupId: ev.groupId, profile: ev.profile, symbol: s.symbol, shareReduced, why });
      const matches = txns.filter((t) => t.direction === "sell" && t.groupId === ev.groupId && baseSymbol(t.symbol) === baseSymbol(s.symbol) && etDay(t.date) === ev.date && (!t.profile || t.profile === ev.profile));
      if (!matches.length) {
        skip("not a trade — no sell in the trade log that day (e.g. Edit positions)");
        continue;
      }
      const tx = matches[matches.length - 1];
      if (tx.status === "pending" || !(tx.price > 0)) {
        skip("sale not settled yet — no price on file");
        continue;
      }
      if (!(s.costBasis > 0)) {
        skip("no average cost on file");
        continue;
      }
      if (!(bookValue > 0)) {
        skip("the book could not be valued that day");
        continue;
      }
      const ccy = deps.currencyOf(s.symbol);
      if (!ccy) {
        skip("trading currency unknown — price cannot be converted");
        continue;
      }
      const fx = ccy === "USD" ? deps.fxOn(ev.date) : 1;
      if (fx == null || !(fx > 0)) {
        skip("no USD/CAD rate for that day");
        continue;
      }
      const salePriceCad = tx.price * fx;
      const gainCad = unitsSold * (salePriceCad - s.costBasis);
      sales.push({
        date: ev.date,
        groupId: ev.groupId,
        profile: ev.profile,
        symbol: s.symbol,
        unitsSold: r4(unitsSold),
        shareSold: shareReduced,
        avgCostCad: r4(s.costBasis),
        salePriceCad: r4(salePriceCad),
        gainOnCostPct: r4((salePriceCad / s.costBasis - 1) * 100),
        pctOfBook: r4((gainCad / bookValue) * 100),
        bookValuedAtCost: atCost,
      });
    }
  }

  const byBook = new Map<string, BookTally>();
  for (const s of sales) {
    const k = `${s.groupId}|${s.profile}`;
    const b = byBook.get(k) ?? { groupId: s.groupId, profile: s.profile, gainsPct: 0, lossesPct: 0, netPct: 0, soldAtGain: 0, soldAtLoss: 0 };
    if (s.pctOfBook >= 0) {
      b.gainsPct += s.pctOfBook;
      b.soldAtGain++;
    } else {
      b.lossesPct += s.pctOfBook;
      b.soldAtLoss++;
    }
    b.netPct += s.pctOfBook;
    byBook.set(k, b);
  }
  const books = [...byBook.values()].map((b) => ({ ...b, gainsPct: r4(b.gainsPct), lossesPct: r4(b.lossesPct), netPct: r4(b.netPct) }));
  sales.sort((a, b) => b.date.localeCompare(a.date));
  return { year, coversFrom: LEDGER_STARTED, sales, uncounted, books };
}
