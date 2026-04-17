/**
 * Country-level geography lookup for every symbol that can appear in a
 * PIM model group. Used by the Client Report one-pager to produce a
 * geographic exposure pie chart.
 *
 * Keep this in sync with `pim-seed.ts`. When a new holding is added to
 * any model group, add its symbol here too — otherwise it defaults to
 * "Other" in the report.
 *
 * Country = domicile / primary listing of the underlying operating
 * business (not the listing exchange of the ETF wrapper). For funds
 * with multi-country exposure we classify as "Global".
 */

export type Country = "United States" | "Canada" | "Global";

/** Symbol → country. Matches the raw `symbol` field used in pim-seed. */
export const SYMBOL_COUNTRY: Record<string, Country> = {
  // ── Fixed income ──
  "JBND-T": "United States", // JPMorgan US Bond Active ETF (CAD hedged)
  JBND: "United States",     // JPMorgan US Bond Active ETF (USD)
  RBF1083: "United States",  // RBC US Core Plus Bond Pool

  // ── US equities ──
  GOOGL: "United States",
  AMZN: "United States",
  SATS: "United States",
  GEV: "United States",
  JPM: "United States",
  OKE: "United States",
  PWR: "United States",
  TSLA: "United States",
  TPL: "United States",
  UBER: "United States",
  USB: "United States",

  // ── Canadian equities ──
  "ARX-T": "Canada",
  "CNR-T": "Canada",
  "CLS-T": "Canada",
  "CSU-T": "Canada",
  "NPI-T": "Canada",
  "NTR-T": "Canada",
  "TOU-T": "Canada",

  // ── Core ETFs (all US-equity exposure) ──
  "XSP-T": "United States",
  "XUS.U": "United States",
  "XUH-T": "United States",
  "XUU.U": "United States",
  "XSU-T": "United States",
  ITOT: "United States",
  VTWO: "United States",

  // ── Alpha / satellite ETFs ──
  GRNJ: "United States",       // US small/mid-cap
  "FINN-T": "Global",          // Fidelity Global Innovators ETF
  "FID5982-T": "Global",       // Fidelity Global Innovators Class

  // ── Mutual funds / pools ──
  DYN439: "United States",     // Dynamic Power American Growth

  // ── Alternatives / income strategies ──
  "DYN3361-T": "United States", // Dynamic Premium Yield Plus (CAD) — US options strategy
  DYN3366: "United States",     // Dynamic Premium Yield Plus (USD)
  "DYN3262-T": "United States", // Dynamic Premium Yield Plus variant (CAD)
  DYN3265: "United States",     // Dynamic Premium Yield Plus variant (USD)
  "PAYF-T": "Canada",           // Purpose Enhanced Premium Yield (Canadian equity)
  WTPI: "United States",        // WisdomTree US Equity Premium Income
};

/**
 * Resolve a symbol to a country, defaulting on listing conventions when
 * the symbol isn't in the explicit table.
 *
 * Heuristics (only used for unknown symbols — the explicit table above
 * always wins):
 *   - `-T`  → Canada
 *   - `.U` / `-U.TO` → US-listed (likely US exposure)
 *   - otherwise → United States
 */
export function countryFor(symbol: string): Country {
  const explicit = SYMBOL_COUNTRY[symbol];
  if (explicit) return explicit;
  // .U / -U.TO before the .TO check — these are USD-denominated CAD-listed
  // ETFs (e.g. XUS.U) tracking US markets. Underlying exposure is US.
  if (symbol.endsWith(".U") || symbol.endsWith("-U.TO")) return "United States";
  if (symbol.endsWith("-T")) return "Canada";
  // Yahoo Finance suffixes for Canadian listings: .TO (TSX), .V (TSXV),
  // .CN (CSE), .NE (NEO Exchange).
  if (
    symbol.endsWith(".TO") ||
    symbol.endsWith(".V") ||
    symbol.endsWith(".CN") ||
    symbol.endsWith(".NE")
  )
    return "Canada";
  return "United States";
}

/**
 * Symbols we treat as "Core" ETF wrappers. When generating the Client
 * Report we DO NOT look through these to their underlying holdings —
 * they're presented as a single tranche (CAD / USD sub-split when both
 * variants are held). We still attribute their country exposure to the
 * underlying market (all US equity, in the current lineup).
 *
 * Kept as a Set for O(1) lookups, seeded from the same canonical list
 * above.
 */
export const CORE_ETF_SYMBOLS: ReadonlySet<string> = new Set([
  "XSP-T",
  "XUS.U",
  "XUH-T",
  "XUU.U",
  "XSU-T",
  "ITOT",
  "VTWO",
]);

/** Convenience: is this symbol a Core ETF wrapper? */
export function isCoreEtf(symbol: string): boolean {
  return CORE_ETF_SYMBOLS.has(symbol);
}

/**
 * Group Core ETF variants that track the same underlying index so the
 * report can display "iShares Core S&P 500" once with a CAD/USD split
 * instead of showing XSP-T and XUS.U on separate rows.
 *
 * Key = internal family id; value = display label.
 */
export const CORE_ETF_FAMILIES: Record<string, string> = {
  "sp500": "iShares Core S&P 500 Index",
  "ustm": "iShares Core S&P US Total Market Index",
  "ussc": "iShares US Small Cap Index",
  "itot": "iShares Core S&P Total US Stock Market",
  "vtwo": "Vanguard Russell 2000",
};

/** Map a Core ETF symbol to its family id, for grouping in the report. */
export function coreFamilyFor(symbol: string): string | null {
  switch (symbol) {
    case "XSP-T":
    case "XUS.U":
      return "sp500";
    case "XUH-T":
    case "XUU.U":
      return "ustm";
    case "XSU-T":
      return "ussc";
    case "ITOT":
      return "itot";
    case "VTWO":
      return "vtwo";
    default:
      return null;
  }
}
