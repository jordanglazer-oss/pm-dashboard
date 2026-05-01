/**
 * Canadian RBC focus-list ticker canonicalization + dedupe.
 *
 * RBC reports tickers in several variants for the same security:
 *   RY-T, RY.TO            → both = Royal Bank
 *   BBD-B.TO, BBD.B-T      → both = Bombardier Class B
 *   BIP-UN.TO, BIP.UN-T    → both = Brookfield Infra Partners units
 *
 * The canonical form for the rest of this app (and Yahoo Finance) is:
 *   - Exchange suffix as ".TO"
 *   - Class designator as "-X" (e.g. "BBD-B", "BIP-UN")
 *
 * `toCanadianYahooTicker(raw)` returns the canonical form for any
 * variant. `dedupeRbcEntries(list)` collapses an entry list down to
 * one row per canonical ticker, picking the most populated entry as
 * the base and clearing any name that was looked up under a non-
 * canonical ticker (since Yahoo's fuzzy search may have returned the
 * wrong company for a malformed ticker — e.g. "BBD.B-T" returned
 * "Banco Bradesco SA").
 */

import type { RBCEntry } from "./defaults";

/**
 * Canonicalize a Canadian ticker variant to Yahoo Finance ".TO" form.
 *
 * Algorithm:
 *   1. Strip leading $ and uppercase.
 *   2. Peel off any trailing ".TO" or "-T" exchange suffix.
 *   3. Convert any internal ".X" class designator (where X is letters)
 *      to "-X" form. Example: "BBD.B" → "BBD-B", "BIP.UN" → "BIP-UN".
 *      Note: this only touches the LAST dot-suffix segment to avoid
 *      breaking unusual base tickers.
 *   4. Re-append ".TO".
 */
export function toCanadianYahooTicker(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/^\$+/, "");

  // Peel exchange suffix.
  if (s.endsWith(".TO")) s = s.slice(0, -3);
  else if (s.endsWith("-T")) s = s.slice(0, -2);

  // Convert trailing ".X" class designator (letters only) to "-X".
  s = s.replace(/\.([A-Z]+)$/, "-$1");

  return `${s}.TO`;
}

/**
 * Returns true if the existing entry's ticker is already in canonical
 * Yahoo form. Used to decide whether a previously-fetched name is
 * trustworthy (looked up with the canonical ticker) or potentially
 * wrong (looked up with a malformed variant).
 */
export function isCanonicalCanadianTicker(t: string): boolean {
  return toCanadianYahooTicker(t) === t;
}

/**
 * Collapse an RBC entry list down to one row per canonical Canadian
 * ticker. When duplicates collapse, prefer:
 *   - The most populated row as the base (real name > placeholder; real
 *     sector > "—"; non-zero weight > zero; non-empty dateAdded).
 *   - Clear `name` if any source row's ticker wasn't canonical — those
 *     names came from Yahoo lookups against malformed tickers and may
 *     be wrong company matches. The next refreshRbcNames call will
 *     re-fetch under the canonical ticker.
 *
 * Returns the deduped+canonicalized list and a boolean indicating
 * whether anything changed (so the caller can decide whether to
 * persist).
 */
export function dedupeRbcEntries(entries: RBCEntry[]): { entries: RBCEntry[]; changed: boolean } {
  let changed = false;
  const byCanonical = new Map<string, RBCEntry>();

  for (const e of entries) {
    const canonical = toCanadianYahooTicker(e.ticker);
    if (canonical !== e.ticker) changed = true;

    // The entry's name is trustworthy ONLY if the original ticker was
    // already canonical. Yahoo fuzzy-matches malformed tickers and
    // returns the wrong company (e.g. BBD.B-T → Banco Bradesco SA).
    const tickerWasCanonical = e.ticker === canonical;
    const trustedName = tickerWasCanonical ? e.name : undefined;
    if (!tickerWasCanonical && e.name) changed = true;

    const candidate: RBCEntry = {
      ticker: canonical,
      name: trustedName,
      sector: e.sector,
      weight: e.weight,
      dateAdded: e.dateAdded,
    };

    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, candidate);
      continue;
    }

    // Merge: pick the most populated values across both rows. Real
    // (non-placeholder) name beats trustedName=undefined; real sector
    // beats "—"; non-zero weight beats zero; non-empty dateAdded beats
    // empty.
    changed = true;
    const isRealName = (n: string | undefined) => Boolean(n && n.trim() && n.toUpperCase() !== canonical.toUpperCase());
    const isRealSector = (s: string | undefined) => Boolean(s && s !== "—" && s.trim());
    const merged: RBCEntry = {
      ticker: canonical,
      name: isRealName(existing.name) ? existing.name
          : isRealName(candidate.name) ? candidate.name
          : undefined,
      sector: isRealSector(existing.sector) ? existing.sector
            : isRealSector(candidate.sector) ? candidate.sector
            : (existing.sector || candidate.sector || "—"),
      weight: (existing.weight && existing.weight > 0) ? existing.weight
            : (candidate.weight && candidate.weight > 0) ? candidate.weight
            : 0,
      dateAdded: (existing.dateAdded && existing.dateAdded.trim()) ? existing.dateAdded
              : (candidate.dateAdded || ""),
    };
    byCanonical.set(canonical, merged);
  }

  return { entries: Array.from(byCanonical.values()), changed };
}
