/**
 * Export helpers for pushing the watchlist into external research tools.
 *
 *  - BoostedAI: upload a CSV whose first row is the header `SYMBOL,COUNTRY,CURRENCY`,
 *    then one name per row. SYMBOL is the local root with the exchange suffix
 *    stripped, and COUNTRY/CURRENCY (3-letter ISO) disambiguate the listing so
 *    BoostedAI picks the right security. (ISIN is an optional BoostedAI column but
 *    we don't store it, so it's omitted — SYMBOL alone is a valid required key.)
 *  - SIA (SIACharts): a plain comma-separated symbol list to paste. SIA writes
 *    every Canadian listing with a ".TO" suffix and every class designator with
 *    a DOT — "CCL.B.TO", not our stored "CCL-B.TO" — so the canonical ticker is
 *    translated rather than passed through (see siaSymbol).
 *  - MarketEdge (ChartScout): a newline-separated US symbol list. MarketEdge is
 *    US-only, so Canadian listings are excluded entirely.
 *
 * Everything is derived from the canonical stored ticker — the SAME identity the
 * scorer uses — so an exported name always maps back to the same stock (no
 * cross-source ticker drift). The exchange suffix is the source of truth for the
 * listing venue AND its trading currency: TSX/TSXV/CBOE (".TO"/".V"/".NE"/".CN",
 * or a legacy "-T" that canonicalTicker folds into ".TO") ⇒ Canada/CAD; bare ⇒
 * US/USD. No Yahoo/FactSet lookup needed — an individual equity's currency is
 * fixed by where it lists.
 */

import type { Stock } from "./types";
import { canonicalTicker } from "./ticker";

/**
 * A name to export. `ticker` is the identity; `currency` is an OPTIONAL hint
 * used only when the ticker carries no exchange suffix — a Canadian listing is
 * normally self-identifying, but a bare CAD-currency name would otherwise read
 * as a US listing.
 */
export type ExportName = Pick<Stock, "ticker"> & { currency?: string };

/** Canadian exchange suffixes we may see on a stored ticker. */
const CA_SUFFIX = /\.(TO|V|NE|CN)$/;

/** True when the ticker is a Canadian listing (by exchange suffix). */
export function isCanadianListing(ticker: string): boolean {
  return CA_SUFFIX.test(canonicalTicker(ticker));
}

/**
 * SIA (SIACharts) symbol.
 *
 * Two differences from our stored form, both confirmed against SIA's own CSV
 * exports (sia-samples): a Canadian listing ALWAYS carries ".TO", and a class
 * designator is a DOT, not a dash — SIA writes CCL.B.TO / TECK.B.TO / GIB.A.TO
 * where we store CCL-B.TO / TECK-B.TO / GIB-A.TO. Symbols that don't match
 * come back unmatched from SIA, so this is not cosmetic.
 *
 * `currency` is a fallback for a Canadian name stored WITHOUT an exchange
 * suffix (the suffix is the primary signal and wins when present). Non-TSX
 * Canadian venues (".V" / ".NE" / ".CN") are folded to ".TO" as well — SIA
 * quotes Canadian listings off the one suffix.
 */
export function siaSymbol(ticker: string, currency?: string): string {
  const c = canonicalTicker(ticker);
  if (!c) return "";
  const canadian = CA_SUFFIX.test(c) || currency?.toUpperCase() === "CAD";
  // Class designator: "-B" → ".B". US class shares follow the same convention
  // (BRK-B → BRK.B), and a symbol already written with dots is unchanged.
  const root = c.replace(CA_SUFFIX, "").replace(/-/g, ".");
  return canadian ? `${root}.TO` : root;
}

/** BoostedAI SYMBOL column — local root with the exchange suffix removed. */
export function boostedSymbol(ticker: string): string {
  return canonicalTicker(ticker).replace(CA_SUFFIX, "");
}

/** BoostedAI COUNTRY column — 3-letter ISO of the listing venue. */
export function boostedCountry(ticker: string): string {
  return isCanadianListing(ticker) ? "CAN" : "USA";
}

/** BoostedAI CURRENCY column — the trading currency implied by the listing
 *  venue (TSX ⇒ CAD, US ⇒ USD). Deterministic from the ticker; no data feed. */
export function boostedCurrency(ticker: string): string {
  return isCanadianListing(ticker) ? "CAD" : "USD";
}

/**
 * Build the BoostedAI upload CSV. First row is the column header
 * `SYMBOL,COUNTRY,CURRENCY`; every following row is one name. No blank ISIN
 * column and no title/label row above the header. Rows are de-duplicated on the
 * full tuple so a US listing and its Canadian interlisting (same SYMBOL,
 * different COUNTRY/CURRENCY) both survive. CRLF line endings + trailing newline
 * for maximal spreadsheet compatibility.
 */
export function buildBoostedCsv(stocks: ExportName[]): string {
  return buildBoostedRows(stocks)
    .map((r) => r.join(","))
    .join("\r\n") + "\r\n";
}

/**
 * BoostedAI upload as an array-of-arrays: row 0 is the header
 * `[SYMBOL, COUNTRY, CURRENCY]`, each following row is one name. Shared by the
 * CSV and the .xlsx export so both stay identical. De-duplicated on the full
 * tuple. No title row, no ISIN column.
 */
export function buildBoostedRows(stocks: ExportName[]): string[][] {
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const s of stocks) {
    const sym = boostedSymbol(s.ticker);
    if (!sym) continue;
    const country = boostedCountry(s.ticker);
    const currency = boostedCurrency(s.ticker);
    const key = `${sym},${country},${currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([sym, country, currency]);
  }
  return [["SYMBOL", "COUNTRY", "CURRENCY"], ...rows];
}

/**
 * MarketEdge (ChartScout) is US-only — Canadian listings have no MarketEdge
 * coverage, so they're excluded. Returns the US symbol for a US listing, or
 * null for any Canadian-suffixed ticker.
 */
export function marketEdgeSymbol(ticker: string, currency?: string): string | null {
  if (isCanadianListing(ticker) || currency?.toUpperCase() === "CAD") return null;
  return canonicalTicker(ticker);
}

/** Newline-separated US symbol list for MarketEdge (one per line), Canadian
 *  listings excluded, de-duplicated, order preserved. */
export function buildMarketEdgeList(stocks: ExportName[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stocks) {
    const sym = marketEdgeSymbol(s.ticker, s.currency);
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.join("\n");
}

/** Comma-separated SIA symbol list for copy-paste (de-duplicated, order kept). */
export function buildSiaSymbolList(stocks: ExportName[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stocks) {
    const sym = siaSymbol(s.ticker, s.currency);
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.join(", ");
}
