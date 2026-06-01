/**
 * Server-safe ticker normalization. Used by cross-source matching (e.g.
 * research-mention tally) where the same security shows up under different
 * surface forms: "RY", "RY-T", "RY.TO", "$RY.TO", "BBD.B-T" vs "BBD-B.TO".
 *
 * Canonical form mirrors what Yahoo Finance uses:
 *   - US listings: plain ticker, no suffix (e.g. "AAPL")
 *   - Canadian listings: ".TO" suffix, class designator as "-X"
 *     (e.g. "RY.TO", "BBD-B.TO", "BIP-UN.TO")
 *
 * For the simple `-T` / `.TO` mismatch handled by the legacy `tickerMatch`
 * inside StockContext, both implementations agree. This helper is stricter
 * about class designators and stripping prefixes like "$" that show up in
 * Anthropic-vision parses of screenshot text.
 */

export function canonicalTicker(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().toUpperCase().replace(/^\$+/, "");
  if (s.endsWith("-T")) {
    s = s.slice(0, -2).replace(/\.([A-Z]+)$/, "-$1");
    return `${s}.TO`;
  }
  if (s.endsWith(".TO")) {
    s = s.slice(0, -3).replace(/\.([A-Z]+)$/, "-$1");
    return `${s}.TO`;
  }
  return s;
}

export function tickersEqual(a: string, b: string): boolean {
  return canonicalTicker(a) === canonicalTicker(b);
}

/**
 * Cross-listing "same company" root. Strips a trailing ".TO" off the
 * canonical form so a US listing and its Canadian interlisting that share
 * the same root collapse to one key:
 *   - "CLS"      → "CLS"
 *   - "CLS.TO"   → "CLS"   (Celestica, Canadian listing of the US CLS)
 *   - "CLS-T"    → "CLS"   (via canonicalTicker → "CLS.TO" → "CLS")
 *   - "BBD-B.TO" → "BBD-B"
 *
 * Intended ONLY for "is this company referenced anywhere" matching in the
 * deterministic score categories (e.g. researchMentions), where a mention
 * of the US ticker should credit the Canadian holding of the same name and
 * vice-versa. This is DELIBERATELY looser than tickersEqual.
 *
 * DO NOT use this for portfolio / position identity — a US "CLS" and a
 * Canadian "CLS.TO" are genuinely different holdings (different currency,
 * separately tradeable) and must stay distinct in pm:stocks / pm:pim-models.
 * Only the most common same-root interlistings collapse here; root-differing
 * interlistings (e.g. Barrick ABX.TO vs US B) are not auto-matched.
 */
export function crossListingRoot(raw: string): string {
  const c = canonicalTicker(raw);
  return c.endsWith(".TO") ? c.slice(0, -3) : c;
}

/** True when two tickers are the same company allowing for a US/Canadian
 *  interlisting that shares a root (see crossListingRoot). */
export function sameCompanyLoose(a: string, b: string): boolean {
  const ra = crossListingRoot(a);
  return ra.length > 0 && ra === crossListingRoot(b);
}

/**
 * Display normalization for tickers. Renders Canadian listings in the
 * canonical Yahoo form (".TO") regardless of how they're stored in the
 * underlying blob ("-T" or ".TO" — pm:stocks and pm:pim-models have a
 * historical mix). US tickers pass through unchanged.
 *
 * Data integrity rule: this is for DISPLAY ONLY. Never use the returned
 * value as a lookup key against pm:stocks etc. — lookups must go through
 * `tickersEqual` / `canonicalTicker` so the original storage form is
 * preserved. Internal `s.ticker === ticker` comparisons inside
 * StockContext rely on stored forms; rewriting them would break.
 *
 * The canonical form was chosen to match Yahoo Finance because every
 * upstream data fetch (prices, fund data, technicals) keys off the
 * Yahoo ticker — the same form the user sees on Yahoo's site when they
 * click through.
 */
export function displayTicker(raw: string): string {
  return canonicalTicker(raw);
}
