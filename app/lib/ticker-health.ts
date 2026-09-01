/**
 * Ticker health check for the research lists.
 *
 * The research sources arrive as vision parses of screenshots and PDFs, so a
 * layout change upstream can produce a ticker the rest of the app can't use:
 * RBC's Q3-2026 Focus List switched to Bloomberg pricing symbols and started
 * emitting "SHOP US" where the parse expected "SHOP-T".
 *
 * The deterministic repairs live in rbc-canonical (exchange-code strip, class
 * designators, the .UN unit classes). This module covers what's left: a row
 * whose ticker STILL doesn't look like a symbol after those repairs. Such a
 * row is kept — never dropped — and flagged so the Research page can surface
 * it in a banner for a one-click manual fix. Silently omitting the row would
 * be worse than surfacing it: the name simply vanishes from the list with no
 * trace, and the replace merge would read it as "dropped from the list".
 *
 * A ticker is "suspect" on SHAPE ALONE — nothing here knows whether a
 * well-formed ticker points at the right security.
 */

import { stripExchangeCode, toCanadianYahooTicker } from "./rbc-canonical";

/** A usable ticker: starts alphanumeric, then letters/digits/dots/dashes. */
export const VALID_TICKER = /^[A-Z0-9][A-Z0-9.\-]*$/;

/**
 * Returns a short human-readable reason when `raw` doesn't look like a
 * ticker, or undefined when it's fine. The reason is shown verbatim in the
 * Research page banner, so it should read as an explanation to the PM.
 */
export function tickerIssue(raw: string | undefined | null): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) return "empty ticker";
  if (/\s/.test(t)) return "contains a space — an exchange code the parse didn't recognize";
  if (t !== t.toUpperCase()) return "not uppercase";
  if (!VALID_TICKER.test(t)) return "has characters that aren't part of a ticker symbol";
  if (t.length > 12) return "too long to be a ticker";
  return undefined;
}

/** Convenience predicate over tickerIssue. */
export function isSuspectTicker(raw: string | undefined | null): boolean {
  return tickerIssue(raw) !== undefined;
}

/**
 * Best-effort repair, used to PRE-FILL the fix input — never applied
 * automatically. The PM confirms every correction, because a mangled symbol
 * can be ambiguous in ways a regex can't settle (which listing? which share
 * class?) and a wrong guess written straight into pm:research would read as
 * a real name on a research list.
 *
 * `canadian` marks the all-TSX lists, where the repair should land on the
 * ".TO" listing.
 */
export function suggestTickerFix(raw: string, opts: { canadian?: boolean } = {}): string {
  const base = stripExchangeCode(String(raw ?? "").trim().toUpperCase().replace(/^\$+/, ""));
  if (opts.canadian) return toCanadianYahooTicker(base);
  // US / mixed lists: keep the symbol as-is beyond the exchange-code strip,
  // converting only the slash share-class form ("BRK/B" → "BRK-B").
  const cleaned = base.replace(/\//g, "-").replace(/\s+/g, "");
  return cleaned;
}
