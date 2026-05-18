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
