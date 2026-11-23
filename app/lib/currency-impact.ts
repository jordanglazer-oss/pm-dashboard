import type { PimHolding, PimModelGroup, PimProfileType, PimProfileWeights } from "./pim-types";

/**
 * Currency (USD/CAD) impact — the pure maths (Nov 2026). READ-ONLY: nothing
 * here stores anything; the route (app/api/currency-impact) reads
 * pm:pim-models + pm:stocks and a daily USD/CAD series.
 *
 * Question it answers for a client: "how much of my return came from the US
 * dollar, and did hedging help or hurt?"
 *
 *   currency contribution = unhedged-USD weight × change in USD/CAD
 *   hedging effect        = −(hedged weight × change in USD/CAD)
 *                           (what the hedge gave up, or saved; carry ignored)
 *
 * Both use the model's CURRENT target weights over the whole period — an
 * ESTIMATE, labelled as such everywhere it is shown. Deliberately separate
 * from alpha (which is measured against the S&P 500 in C$ and is already
 * currency-neutral); nothing in the alpha calculation is touched.
 */

/**
 * CAD-HEDGED holdings. PROPOSED LIST — NOT YET CONFIRMED BY THE PM (Nov 2026).
 * There is no stored hedged / unhedged flag, so this constant is the only
 * source besides a fund whose own name says "hedged". Any listing suffix
 * (-T, .TO) matches. Edit here once the PM confirms.
 */
export const CAD_HEDGED_SYMBOLS = ["XSP", "XUH", "XSU", "QQC.F"];

export type FxClass = "usd-unhedged" | "hedged" | "cad" | "unclassified";
export type FxClassification = { cls: FxClass; reason: string };

/** Listing-agnostic symbol: XSU-T / XSU.TO → XSU; QQC.F-T / QQC-F.TO → QQC.F. */
export function baseSymbol(raw: string): string {
  return (raw || "")
    .trim()
    .toUpperCase()
    .replace(/(-T|\.TO|\.NE|-NE)$/, "")
    .replace(/-([A-Z])$/, ".$1");
}

export const isOnHedgedList = (symbol: string) => CAD_HEDGED_SYMBOLS.some((s) => baseSymbol(s) === baseSymbol(symbol));

const SAYS_HEDGED = /hedged/i;
const SAYS_UNHEDGED = /un-?hedged|non-?hedged/i;
const SAYS_US = /\bU\.?S\.?(?![A-Za-z])|S&P\s*500|NASDAQ|UNITED STATES|\bAMERICAN\b/i;
const SAYS_CANADA = /CANAD|\bTSX\b/i;

export type FxHoldingInput = {
  symbol: string;
  name?: string;
  currency: "CAD" | "USD";
  /** From pm:stocks when the name is in the book; undefined when it is not. */
  instrumentType?: "stock" | "etf" | "mutual-fund";
  /** Fund category from fund data on file, when present. */
  category?: string;
  /** True when pm:stocks has a record for this symbol. */
  known?: boolean;
};

/**
 * Classify one holding's USD exposure. Only what the data on file supports —
 * anything else is "unclassified", never guessed (a global fund holds some
 * US dollars, but how much is not on file).
 */
export function classifyFx(h: FxHoldingInput): FxClassification {
  const text = `${h.name ?? ""} ${h.category ?? ""}`;
  if (isOnHedgedList(h.symbol)) return { cls: "hedged", reason: "on the CAD-hedged list" };
  if (SAYS_HEDGED.test(text) && !SAYS_UNHEDGED.test(text)) return { cls: "hedged", reason: "its name says CAD-hedged" };
  if (h.currency === "USD") return { cls: "usd-unhedged", reason: "priced in US dollars" };
  if (h.known && (!h.instrumentType || h.instrumentType === "stock")) return { cls: "cad", reason: "Canadian-dollar stock" };
  if (h.instrumentType === "etf" || h.instrumentType === "mutual-fund") {
    if (SAYS_US.test(text)) return { cls: "usd-unhedged", reason: "Canadian-listed fund holding US assets, not hedged" };
    if (SAYS_CANADA.test(text)) return { cls: "cad", reason: "Canadian fund" };
    return { cls: "unclassified", reason: "fund's currency mix is not on file" };
  }
  return { cls: "unclassified", reason: "not in the stock list — type unknown" };
}

const CLASS_KEY: Record<PimHolding["assetClass"], keyof PimProfileWeights> = { equity: "equity", fixedIncome: "fixedIncome", alternative: "alternatives" };

export type FxRow = { symbol: string; name: string; currency: "CAD" | "USD"; assetClass: string; weight: number; cls: FxClass; reason: string };

/** Each holding's share of the whole portfolio for a profile, with its class. */
export function fxRows(group: PimModelGroup, profile: PimProfileType, info: (symbol: string) => Pick<FxHoldingInput, "instrumentType" | "category" | "known">): FxRow[] {
  const mix = group.profiles[profile];
  if (!mix) return [];
  return group.holdings
    .map((h) => {
      const weight = (h.weightInClass || 0) * (mix[CLASS_KEY[h.assetClass]] ?? 0);
      const c = classifyFx({ symbol: h.symbol, name: h.name, currency: h.currency, ...info(h.symbol) });
      return { symbol: h.symbol, name: h.name, currency: h.currency, assetClass: h.assetClass, weight, cls: c.cls, reason: c.reason };
    })
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

export type FxPoint = { date: string; value: number };

/** Base = last close BEFORE `from` (the prior close) or the first point; end = last close on/before `to`. */
export function fxMove(series: FxPoint[], from: string | null, to: string): { base: FxPoint; end: FxPoint; pct: number; partial: boolean } | null {
  if (series.length < 2) return null;
  const end = [...series].reverse().find((p) => p.date <= to);
  const before = from ? [...series].reverse().find((p) => p.date < from) : undefined;
  const base = before ?? series[0];
  if (!end || end.date <= base.date || !(base.value > 0)) return null;
  return { base, end, pct: (end.value / base.value - 1) * 100, partial: !!from && !before };
}

const r4 = (n: number) => parseFloat(n.toFixed(4));
const sumW = (rows: FxRow[], cls: FxClass) => rows.filter((r) => r.cls === cls).reduce((s, r) => s + r.weight, 0);

export type CurrencyImpact = {
  /** Shares of the whole portfolio (0–1). */
  unhedgedWeight: number;
  hedgedWeight: number;
  cadWeight: number;
  unclassifiedWeight: number;
  /** USD/CAD change over the period, % (positive = US dollar rose). */
  fxPct: number | null;
  fxBase: FxPoint | null;
  fxEnd: FxPoint | null;
  /** True when the USD/CAD series starts after the requested start. */
  partial: boolean;
  /** unhedged weight × USD/CAD change, in points of portfolio return. */
  contributionPct: number | null;
  /** −(hedged weight × USD/CAD change): what hedging added (+) or gave up (−). Carry ignored. */
  hedgingEffectPct: number | null;
  /** The contribution building up day by day (same current weights). */
  series: FxPoint[];
};

export function currencyImpact(rows: FxRow[], fx: FxPoint[], from: string | null, to: string): CurrencyImpact {
  const unhedgedWeight = sumW(rows, "usd-unhedged");
  const hedgedWeight = sumW(rows, "hedged");
  const mv = fxMove(fx, from, to);
  return {
    unhedgedWeight: r4(unhedgedWeight),
    hedgedWeight: r4(hedgedWeight),
    cadWeight: r4(sumW(rows, "cad")),
    unclassifiedWeight: r4(sumW(rows, "unclassified")),
    fxPct: mv ? r4(mv.pct) : null,
    fxBase: mv?.base ?? null,
    fxEnd: mv?.end ?? null,
    partial: mv?.partial ?? false,
    contributionPct: mv ? r4(unhedgedWeight * mv.pct) : null,
    // `|| 0` keeps a zero effect from printing as "-0".
    hedgingEffectPct: mv ? r4(-hedgedWeight * mv.pct) || 0 : null,
    series: mv ? fx.filter((p) => p.date >= mv.base.date && p.date <= mv.end.date).map((p) => ({ date: p.date, value: r4(unhedgedWeight * (p.value / mv.base.value - 1) * 100) })) : [],
  };
}
