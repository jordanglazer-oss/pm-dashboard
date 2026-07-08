/**
 * Export helpers for pushing the watchlist into external research tools.
 *
 *  - BoostedAI: upload a CSV with headers ISIN,SYMBOL,COUNTRY,CURRENCY.
 *    ISIN is left blank (we don't store it); SYMBOL is the local root with the
 *    exchange suffix stripped, and COUNTRY/CURRENCY (3-letter ISO) disambiguate
 *    the listing so BoostedAI picks the right security.
 *  - SIA (SIACharts): a plain comma-separated symbol list to paste. Per the PM,
 *    SIA expects the ".TO" form for TSX names (US names stay bare) — which is
 *    exactly how tickers are already stored, so this is just the canonical
 *    ticker.
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

/** Canadian exchange suffixes we may see on a stored ticker. */
const CA_SUFFIX = /\.(TO|V|NE|CN)$/;

/** True when the ticker is a Canadian listing (by exchange suffix). */
export function isCanadianListing(ticker: string): boolean {
  return CA_SUFFIX.test(canonicalTicker(ticker));
}

/** SIA (SIACharts) symbol — Yahoo ".TO" style for TSX, bare for US. */
export function siaSymbol(ticker: string): string {
  return canonicalTicker(ticker);
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
 * Build the BoostedAI upload CSV. Columns: ISIN,SYMBOL,COUNTRY,CURRENCY
 * (ISIN left blank). Rows are de-duplicated on the full tuple so a US listing
 * and its Canadian interlisting (same SYMBOL, different COUNTRY/CURRENCY) both
 * survive. CRLF line endings + trailing newline for maximal spreadsheet
 * compatibility.
 */
export function buildBoostedCsv(stocks: Array<Pick<Stock, "ticker">>): string {
  const header = "ISIN,SYMBOL,COUNTRY,CURRENCY";
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const s of stocks) {
    const sym = boostedSymbol(s.ticker);
    if (!sym) continue;
    const row = ["", sym, boostedCountry(s.ticker), boostedCurrency(s.ticker)].join(",");
    if (seen.has(row)) continue;
    seen.add(row);
    rows.push(row);
  }
  return [header, ...rows].join("\r\n") + "\r\n";
}

/**
 * MarketEdge (ChartScout) is US-only — Canadian listings have no MarketEdge
 * coverage, so they're excluded. Returns the US symbol for a US listing, or
 * null for any Canadian-suffixed ticker.
 */
export function marketEdgeSymbol(ticker: string): string | null {
  if (isCanadianListing(ticker)) return null;
  return canonicalTicker(ticker);
}

/** Newline-separated US symbol list for MarketEdge (one per line), Canadian
 *  listings excluded, de-duplicated, order preserved. */
export function buildMarketEdgeList(stocks: Array<Pick<Stock, "ticker">>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stocks) {
    const sym = marketEdgeSymbol(s.ticker);
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.join("\n");
}

/** Comma-separated SIA symbol list for copy-paste (de-duplicated, order kept). */
export function buildSiaSymbolList(stocks: Array<Pick<Stock, "ticker">>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stocks) {
    const sym = siaSymbol(s.ticker);
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.join(", ");
}
