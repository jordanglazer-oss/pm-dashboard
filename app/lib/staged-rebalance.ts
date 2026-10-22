/* ─── Back-dated rebalance to an applied Stage-changes draft ───
 *
 * The desk trades the new models on day T (`asOf`); the PM records it the
 * next day. Rules (Jordan, 2026-10-22):
 *   - Performance cuts over at T's CLOSE: day T's return stays on the old
 *     holdings (that entry is anchored before anything is written), T+1 on
 *     uses the new models and positions.
 *   - Units are sized like the desk: off the close BEFORE T (prior close),
 *     total value = cash + every position at that close (USD at that day's FX).
 *   - Stocks / ETFs: the PM enters the average fill price — it sets the cost
 *     basis. Mutual funds execute at T's NAV automatically (settled, no
 *     pending leg): units = dollar change ÷ NAV.
 *   - Every PIM positions book is traded: Balanced / Growth / All-Equity /
 *     Conservative on the model weights; the Alpha book holds Alpha STOCKS
 *     only (three-bucket model); the Core book holds Core ETFs only.
 *   - A position the book's new model no longer holds is sold to zero.
 *
 * This file is pure planning — prices in, trades out. The route
 * (/api/model-staging/rebalance) fetches prices and does every write. */

import type { EquityBucket, PimHolding, PimModelGroup, PimProfileType } from "./pim-types";
import { sameSymbol } from "./model-staging";
import { isFundservSymbol } from "./historical-closes";

export type PositionRow = { symbol: string; units: number; costBasis: number };
export type PositionsBook = { groupId: string; profile: string; positions: PositionRow[]; cashBalance: number; lastUpdated?: string };

/** Prices the plan needs, per symbol (instrument currency). */
export type PlanPrices = {
  /** The close before T — sizes every trade. */
  sizing: Record<string, { price: number; date: string } | null>;
  /** T's close (reference for stocks / ETFs; the execution price for MFs). */
  asOf: Record<string, number | null>;
  fxSizing: number | null; // USD→CAD at the sizing close
  fxAsOf: number | null; // USD→CAD at T's close (cost basis of USD buys)
};

export type TradeRow = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  isMF: boolean;
  modelPct: number; // target share of this book
  unitsBefore: number;
  unitsAfter: number;
  deltaUnits: number;
  /** CAD value of the change at the sizing close (MF: the dollar order). */
  deltaValueCad: number;
  action: "BUY" | "SELL" | "HOLD";
  exit: boolean;
};

export type BookPlan = {
  profile: string;
  totalCad: number;
  cash: number;
  rows: TradeRow[];
  problems: string[];
};

const EQUITY_ONLY = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };

/** Target share of the book per holding, for one positions book. */
export function bookTargets(pim: PimModelGroup, profile: string, bucket: (symbol: string) => EquityBucket): Array<{ h: PimHolding; pct: number }> {
  if (profile === "alpha" || profile === "core") {
    const want: EquityBucket = profile === "alpha" ? "alpha" : "core";
    const eq = pim.holdings.filter((h) => h.assetClass === "equity" && bucket(h.symbol) === want);
    const tot = eq.reduce((a, h) => a + h.weightInClass, 0);
    return tot > 0 ? eq.map((h) => ({ h, pct: h.weightInClass / tot })) : [];
  }
  const pw = profile === "thematic" ? EQUITY_ONLY : pim.profiles[profile as PimProfileType];
  if (!pw) return [];
  return pim.holdings
    .map((h) => ({ h, pct: h.weightInClass * (h.assetClass === "equity" ? pw.equity : h.assetClass === "fixedIncome" ? pw.fixedIncome : pw.alternatives) }))
    .filter((x) => x.pct > 0);
}

const ccyOf = (symbol: string): "CAD" | "USD" => {
  const t = symbol.toUpperCase();
  if (t.endsWith(".U")) return "USD";
  if (t.endsWith("-T") || t.endsWith(".TO") || t.endsWith(".NE") || isFundservSymbol(t)) return "CAD";
  return "USD";
};

export function planBook(book: PositionsBook, pim: PimModelGroup, bucket: (symbol: string) => EquityBucket, prices: PlanPrices): BookPlan {
  const problems: string[] = [];
  const targets = bookTargets(pim, book.profile, bucket);
  const fxS = prices.fxSizing ?? 0;
  if (!fxS) problems.push("no USD/CAD close for the sizing day");
  const priceCad = (symbol: string, currency: "CAD" | "USD") => {
    const p = prices.sizing[symbol]?.price ?? null;
    return p == null ? null : p * (currency === "USD" ? fxS : 1);
  };

  // Every symbol the book holds or will hold.
  const symbols: Array<{ symbol: string; name: string; currency: "CAD" | "USD"; pct: number; exit: boolean }> = [];
  for (const t of targets) symbols.push({ symbol: t.h.symbol, name: t.h.name, currency: t.h.currency, pct: t.pct, exit: false });
  for (const p of book.positions) {
    if (p.units <= 0 || symbols.some((s) => sameSymbol(s.symbol, p.symbol))) continue;
    symbols.push({ symbol: p.symbol, name: p.symbol, currency: ccyOf(p.symbol), pct: 0, exit: true });
  }

  const unitsOf = (sym: string) => book.positions.find((p) => sameSymbol(p.symbol, sym))?.units ?? 0;
  let total = book.cashBalance || 0;
  for (const s of symbols) {
    const u = unitsOf(s.symbol);
    if (u <= 0) continue;
    const pc = priceCad(s.symbol, s.currency);
    if (pc == null) { problems.push(`${s.symbol}: no close before the trade day — can't value the position`); continue; }
    total += u * pc;
  }

  const rows: TradeRow[] = [];
  for (const s of symbols) {
    const isMF = isFundservSymbol(s.symbol);
    const before = unitsOf(s.symbol);
    const pc = priceCad(s.symbol, s.currency);
    const targetCad = total * s.pct;
    let after = before;
    let dValue = 0;
    if (pc == null) {
      if (s.pct > 0 || before > 0) problems.push(`${s.symbol}: no sizing price`);
    } else if (isMF) {
      dValue = targetCad - before * pc;
      const nav = prices.asOf[s.symbol] ?? null;
      const navCad = nav == null ? null : nav * (s.currency === "USD" ? prices.fxAsOf ?? 0 : 1);
      if (Math.abs(dValue) >= 0.01) {
        if (!navCad) problems.push(`${s.symbol}: no NAV for the trade day — the mutual fund can't be priced`);
        else after = s.exit ? 0 : Math.max(0, before + dValue / navCad);
      }
    } else {
      after = s.exit ? 0 : targetCad / pc;
      dValue = (after - before) * pc;
    }
    after = parseFloat(after.toFixed(4));
    const delta = parseFloat((after - before).toFixed(4));
    const action = Math.abs(delta) < 0.001 ? "HOLD" : delta > 0 ? "BUY" : "SELL";
    rows.push({ symbol: s.symbol, name: s.name, currency: s.currency, isMF, modelPct: s.pct, unitsBefore: before, unitsAfter: action === "HOLD" ? before : after, deltaUnits: action === "HOLD" ? 0 : delta, deltaValueCad: dValue, action, exit: s.exit });
  }
  return { profile: book.profile, totalCad: total, cash: book.cashBalance || 0, rows, problems };
}
