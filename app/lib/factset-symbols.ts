/**
 * FactSet symbol mapping + per-ticker source overrides.
 *
 * Translates the dashboard's stored ticker format into a FactSet Formula API
 * identifier, OR signals that a ticker should stay on its EXISTING data source.
 *
 * Identifier rules confirmed via live FactSet testing (June 2026):
 *   - US listings:        <TICKER>-US     (AAPL-US, SPY-US, VFIAX-US, GRNJ-US)
 *   - Canadian listings:  <TICKER>-CA     (XUU-CA -> 76.66, XUS-CA -> 64.42)
 *   - USD-unit ETFs:      do NOT resolve  (XUU.U / XUS.U) -> keep existing route
 *   - FUNDSERV codes:     not yet mapped  (e.g. FID5982) -> keep existing route
 *                          (pending an ISIN/CUSIP lookup before we can map them)
 *
 * Dashboard ticker conventions (see app/api/prices/route.ts):
 *   - Canadian TSX tickers carry a "-T" suffix (e.g. "ENB-T").
 *   - USD-unit listings carry a ".U" suffix (e.g. "XUU.U").
 *   - FUNDSERV codes match /^[A-Z]{2,4}\d{2,5}$/ (e.g. "FID5982", "TDB900").
 *
 * This module is intentionally pure (no I/O) so it can be unit-reasoned about
 * and reused on both the price and fund-data paths. Nothing imports it yet —
 * it's wired in per data type during the staged migration.
 */

export type FactsetResolution =
  | { source: "factset"; id: string }
  | { source: "existing"; reason: string };

/**
 * Tickers we deliberately keep on the existing data source. Confirmed during
 * live testing that FactSet either can't resolve them or isn't entitled.
 * Keyed by the dashboard's stored ticker (upper-cased).
 */
export const FACTSET_OVERRIDES: Record<string, string> = {
  "XUU.U": "USD-unit listing — FactSet symbology does not resolve cleanly",
  "XUS.U": "USD-unit listing — FactSet symbology does not resolve cleanly",
  FID5982: "Canadian Fidelity fund — FactSet id not yet resolved (pending ISIN)",
  "FID5982-T": "Canadian Fidelity fund — FactSet id not yet resolved (pending ISIN)",
};

/** FUNDSERV code detector — mirrors app/api/prices/route.ts. */
export function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

/**
 * Resolve a dashboard ticker to a FactSet Formula API identifier, or signal
 * that it should stay on the existing data source.
 *
 * NOTE: rule 5 (default → US) is a starting assumption; any Canadian ticker
 * stored WITHOUT a "-T" suffix would need an explicit override or a refined
 * rule. We validate against the real `pm:stocks` ticker set when wiring in.
 */
export function resolveFactsetId(ticker: string): FactsetResolution {
  const t = ticker.trim().toUpperCase();

  // 1. Explicit overrides always win.
  const override = FACTSET_OVERRIDES[t];
  if (override) return { source: "existing", reason: override };

  // 2. USD-unit listings (".U" suffix) don't resolve in FactSet symbology.
  if (t.endsWith(".U")) {
    return { source: "existing", reason: "USD-unit listing — not resolvable in FactSet" };
  }

  // 3. FUNDSERV codes (Canadian mutual funds) aren't mapped to FactSet ids yet.
  if (isFundservCode(t)) {
    return { source: "existing", reason: "FUNDSERV code — FactSet id not yet resolved" };
  }

  // 4. Canadian TSX listings: "-T" suffix -> "<TICKER>-CA".
  if (t.endsWith("-T")) {
    return { source: "factset", id: t.replace(/-T$/, "") + "-CA" };
  }

  // 5. Default: treat as a US listing.
  return { source: "factset", id: t + "-US" };
}
