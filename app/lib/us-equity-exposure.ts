/**
 * US-equity exposure per holding — the input to SPY put hedge sizing.
 *
 * The house convention is to hedge the NOTIONAL US equity the book holds:
 *
 *     contracts = US equity notional (USD) / (strike x 100)
 *
 * so the notional has to be right. Three things make "is this US equity?"
 * less obvious than it looks:
 *
 *   1. Currency is NOT the test. XUH.TO is a CAD-denominated, CAD-hedged
 *      S&P 500 tracker — 100% US equity exposure. SYMBOL_COUNTRY already
 *      classifies by UNDERLYING rather than by wrapper or listing, so it is
 *      the right source for the pure-mandate funds.
 *   2. The currency hedge is deliberately ignored. A CAD-hedged US fund still
 *      carries full US equity risk, which is what a SPY put offsets. It does
 *      leave a small FX mismatch on that sleeve — the put pays USD while the
 *      fund's CAD value is FX-insulated — accepted knowingly rather than
 *      complicating the sizing rule.
 *   3. Global funds are genuinely partial and cannot be derived. Morningstar
 *      exposes only top-10 holdings (~30% of a broad fund), so a scraped
 *      estimate would be guesswork. These take a manual percentage, set per
 *      holding on the stock page.
 *
 * An UNRESOLVED holding is never treated as 0%. Silently assuming zero would
 * under-hedge with nothing to show for it, so callers must surface unresolved
 * symbols and refuse to size until they are set.
 */

import { SYMBOL_COUNTRY, type Country } from "@/app/lib/geography";
import type { Stock } from "@/app/lib/types";

export type UsEquityResolution = {
  symbol: string;
  /** 0-100, or null when it cannot be resolved and must be set by hand. */
  pct: number | null;
  source: "manual" | "country" | "unresolved";
  country: Country | null;
  /** Shown in the UI to explain where the number came from. */
  reason: string;
};

/**
 * SYMBOL_COUNTRY is keyed on the raw seed symbol, but the models hold listing
 * variants that do not match it — FINN.NE vs the map's FINN-T, bare FID5982 vs
 * FID5982-T. Those holdings currently fall through to "Other" in the Client
 * Report's geography pie for the same reason. Look up across every variant so
 * hedge sizing is not silently wrong in the same way.
 */
export function lookupCountry(symbol: string): Country | null {
  const raw = (symbol || "").trim().toUpperCase();
  if (!raw) return null;
  const base = raw.replace(/(\.TO|-T|\.NE|\.U)$/, "");
  const variants = [raw, base, `${base}-T`, `${base}.TO`, `${base}.NE`, `${base}.U`];
  for (const v of variants) {
    const hit = SYMBOL_COUNTRY[v];
    if (hit) return hit;
  }
  return null;
}

/** Resolve one holding's US-equity percentage. */
export function resolveUsEquityPct(symbol: string, stock?: Stock | null): UsEquityResolution {
  const manual = stock?.usEquityPct;
  if (manual != null && Number.isFinite(manual)) {
    const pct = Math.max(0, Math.min(100, manual));
    return {
      symbol, pct, source: "manual", country: lookupCountry(symbol),
      reason: `Set manually to ${pct}%.`,
    };
  }

  const country = lookupCountry(symbol);
  if (country === "United States") {
    return { symbol, pct: 100, source: "country", country, reason: "Underlying exposure is US (currency and any FX hedge ignored)." };
  }
  if (country === "Canada") {
    return { symbol, pct: 0, source: "country", country, reason: "Underlying exposure is Canadian." };
  }
  if (country === "Global") {
    return {
      symbol, pct: null, source: "unresolved", country,
      reason: "Global mandate — the US share is partial and cannot be derived. Set it on the stock page.",
    };
  }
  return {
    symbol, pct: null, source: "unresolved", country: null,
    reason: "Not classified in geography.ts and no manual value set. Set it on the stock page.",
  };
}

/**
 * US equity notional for a set of valued holdings.
 *
 * Returns the total ALONGSIDE the unresolved symbols rather than instead of
 * them: a caller that ignores `unresolved` and sizes off `notional` is
 * under-hedging, so the two travel together.
 */
export function usEquityNotional(
  holdings: Array<{ symbol: string; valueUsd: number; isEquity: boolean; stock?: Stock | null }>,
): { notionalUsd: number; unresolved: string[]; contributions: Array<{ symbol: string; pct: number; valueUsd: number; contributionUsd: number }> } {
  let notionalUsd = 0;
  const unresolved: string[] = [];
  const contributions: Array<{ symbol: string; pct: number; valueUsd: number; contributionUsd: number }> = [];

  for (const h of holdings) {
    if (!h.isEquity || h.valueUsd <= 0) continue;
    const r = resolveUsEquityPct(h.symbol, h.stock);
    if (r.pct == null) {
      unresolved.push(h.symbol);
      continue;
    }
    if (r.pct === 0) continue;
    const contributionUsd = h.valueUsd * (r.pct / 100);
    notionalUsd += contributionUsd;
    contributions.push({ symbol: h.symbol, pct: r.pct, valueUsd: h.valueUsd, contributionUsd });
  }
  return { notionalUsd, unresolved, contributions };
}

/** Contracts implied by a notional at a given strike — the house convention. */
export function impliedContracts(notionalUsd: number, strike: number): number | null {
  if (!(strike > 0) || !(notionalUsd > 0)) return null;
  return notionalUsd / (strike * 100);
}
