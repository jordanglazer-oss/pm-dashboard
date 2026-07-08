/**
 * Export helpers for pushing the watchlist into external research tools.
 *
 *  - BoostedAI: upload a CSV with headers ISIN,SYMBOL,COUNTRY,CURRENCY.
 *    ISIN is left blank (we don't store it); SYMBOL is the local root with the
 *    exchange suffix stripped, and COUNTRY/CURRENCY (3-letter ISO) disambiguate
 *    the listing so BoostedAI picks the right security.
 *  - SIA (SIACharts): a plain comma-separated symbol list to paste. Per the PM,
 *    SIA expects the Yahoo ".TO" form for TSX names (US names stay bare) — which
 *    is exactly how tickers are already stored, so this is just the canonical
 *    ticker.
 *
 * Ticker suffix is the source of truth for the listing venue: our tickers are
 * stored Yahoo-style (".TO"/".V"/".NE"/".CN" for Canadian venues, or a legacy
 * "-T" that canonicalTicker folds into ".TO"; bare = US).
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

/** BoostedAI CURRENCY column — the stored Yahoo trading currency when we have
 *  it (authoritative, handles USD-denominated TSX listings), else derived from
 *  the venue. */
export function boostedCurrency(stock: Pick<Stock, "ticker" | "currency">): string {
  const c = (stock.currency || "").toUpperCase().trim();
  if (c) return c;
  return isCanadianListing(stock.ticker) ? "CAD" : "USD";
}

/**
 * Build the BoostedAI upload CSV. Columns: ISIN,SYMBOL,COUNTRY,CURRENCY
 * (ISIN left blank). Rows are de-duplicated on the full tuple so a US listing
 * and its Canadian interlisting (same SYMBOL, different COUNTRY/CURRENCY) both
 * survive. CRLF line endings + trailing newline for maximal spreadsheet
 * compatibility.
 */
export function buildBoostedCsv(stocks: Array<Pick<Stock, "ticker" | "currency">>): string {
  const header = "ISIN,SYMBOL,COUNTRY,CURRENCY";
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const s of stocks) {
    const sym = boostedSymbol(s.ticker);
    if (!sym) continue;
    const row = ["", sym, boostedCountry(s.ticker), boostedCurrency(s)].join(",");
    if (seen.has(row)) continue;
    seen.add(row);
    rows.push(row);
  }
  return [header, ...rows].join("\r\n") + "\r\n";
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
