/**
 * Currency utilities for the analyst-report ingestion path.
 *
 * Problem solved: analyst reports come in any currency the analyst chooses
 * (RBC Canada quotes CAD targets, JPM Copenhagen quotes DKK targets, etc).
 * The dashboard displays a single ticker per stock, and that ticker has its
 * own native currency (CCJ → USD, CCO.TO → CAD, NVO → USD, NOVO-B.CO → DKK).
 * To make the target meaningful, we convert at ingestion time using the FX
 * rate from the report's `asOf` date — matching what the analyst saw.
 *
 * Three responsibilities:
 *
 *   1. `tickerDisplayCurrency(ticker)` — derive the dashboard's display
 *      currency from the ticker suffix (e.g. ".TO" → CAD). No API call.
 *      Returns null for unknown suffixes; the caller falls back to no
 *      conversion + an inbox-log warning.
 *
 *   2. `getHistoricalFxRate(from, to, date)` — fetch the FX rate on a
 *      specific date via Yahoo's chart endpoint. Cached in Redis under
 *      `pm:fx-rate:{PAIR}:{YYYY-MM-DD}` with no TTL (historical rates
 *      don't change). Weekend/holiday dates fall back to the most recent
 *      prior trading day automatically (Yahoo doesn't quote on those).
 *
 *   3. `convertAnalystTarget(amount, from, to, date)` — high-level helper
 *      that handles minor-unit normalization (GBp → GBP, ZAc → ZAR, ILA →
 *      ILS) and cross-rate computation (via USD when a direct pair isn't
 *      available on Yahoo).
 *
 * On any fetch failure or unknown currency, conversion returns null and
 * the ingestion route stores the raw target with a "currency unverified"
 * flag in the inbox log.
 */

import { getRedis } from "./redis";

// ── Ticker → display currency ────────────────────────────────────────

/**
 * Major-unit currency for a dashboard ticker. Some exchanges quote in
 * minor units (London = pence, Johannesburg = cents, Tel Aviv = agorot);
 * when minorUnit is set, the returned currency is the major unit (e.g.
 * London GBP) and the caller should treat any extracted target in
 * "minor" notation (GBp/ZAc/ILA) as divided by 100.
 */
export type TickerCurrency = {
  /** ISO 4217 major-unit code (USD, CAD, EUR, GBP, DKK, etc) */
  currency: string;
  /** When true, this exchange typically quotes prices in minor units
   *  (e.g. .L lists in GBp = pence). The dashboard price itself is
   *  already in major units in our pipe, but the analyst report MAY
   *  cite the minor-unit number, so the extractor must report it. */
  minorUnitsCommon: boolean;
};

/**
 * Map ticker suffix → display currency. Covers 99% of names a PM would
 * actually hold; the long tail returns null (handled gracefully upstream).
 */
const SUFFIX_CURRENCY: Array<{ pattern: RegExp; currency: string; minorUnitsCommon?: boolean }> = [
  // Canada
  { pattern: /\.TO$/i, currency: "CAD" },
  { pattern: /\.V$/i, currency: "CAD" },
  { pattern: /-T$/i, currency: "CAD" },
  { pattern: /\.NE$/i, currency: "CAD" },
  { pattern: /\.CN$/i, currency: "CAD" },
  // US — explicit USD-denominated Canadian (.U) and standard US (no suffix)
  { pattern: /\.U$/i, currency: "USD" },
  // UK — London Stock Exchange, prices commonly quoted in GBp (pence)
  { pattern: /\.L$/i, currency: "GBP", minorUnitsCommon: true },
  { pattern: /\.LON$/i, currency: "GBP", minorUnitsCommon: true },
  // Eurozone
  { pattern: /\.PA$/i, currency: "EUR" }, // Paris
  { pattern: /\.AS$/i, currency: "EUR" }, // Amsterdam
  { pattern: /\.BR$/i, currency: "EUR" }, // Brussels
  { pattern: /\.MI$/i, currency: "EUR" }, // Milan
  { pattern: /\.LS$/i, currency: "EUR" }, // Lisbon
  { pattern: /\.MC$/i, currency: "EUR" }, // Madrid
  { pattern: /\.HE$/i, currency: "EUR" }, // Helsinki
  { pattern: /\.DE$/i, currency: "EUR" }, // Xetra / Frankfurt
  { pattern: /\.F$/i, currency: "EUR" }, // Frankfurt
  { pattern: /\.VI$/i, currency: "EUR" }, // Vienna
  { pattern: /\.IR$/i, currency: "EUR" }, // Ireland
  // Nordics
  { pattern: /\.CO$/i, currency: "DKK" }, // Copenhagen
  { pattern: /\.ST$/i, currency: "SEK" }, // Stockholm
  { pattern: /\.OL$/i, currency: "NOK" }, // Oslo
  // Switzerland
  { pattern: /\.SW$/i, currency: "CHF" },
  { pattern: /\.S$/i, currency: "CHF" },
  // Asia
  { pattern: /\.HK$/i, currency: "HKD" }, // Hong Kong
  { pattern: /\.T$/i, currency: "JPY" }, // Tokyo (caution: distinct from "-T" Canada)
  { pattern: /\.KS$/i, currency: "KRW" }, // Korea
  { pattern: /\.KQ$/i, currency: "KRW" }, // KOSDAQ
  { pattern: /\.SI$/i, currency: "SGD" }, // Singapore
  { pattern: /\.SS$/i, currency: "CNY" }, // Shanghai
  { pattern: /\.SZ$/i, currency: "CNY" }, // Shenzhen
  // Australia / NZ
  { pattern: /\.AX$/i, currency: "AUD" },
  { pattern: /\.NZ$/i, currency: "NZD" },
  // South Africa / Israel — minor unit notations
  { pattern: /\.JO$/i, currency: "ZAR", minorUnitsCommon: true }, // Johannesburg — prices in ZAc
  { pattern: /\.TA$/i, currency: "ILS", minorUnitsCommon: true }, // Tel Aviv — prices in ILA
  // Latin America
  { pattern: /\.MX$/i, currency: "MXN" }, // Mexico
  { pattern: /\.SA$/i, currency: "BRL" }, // São Paulo
];

export function tickerDisplayCurrency(ticker: string): TickerCurrency | null {
  if (!ticker) return null;
  const t = ticker.trim();
  for (const { pattern, currency, minorUnitsCommon } of SUFFIX_CURRENCY) {
    if (pattern.test(t)) return { currency, minorUnitsCommon: !!minorUnitsCommon };
  }
  // No suffix → assume US listing (USD). This catches the bare-ticker case
  // (AAPL, NVO, CCJ, MSFT, etc) which is by far the most common.
  if (/^[a-z0-9.]+$/i.test(t) && !t.includes(".")) {
    return { currency: "USD", minorUnitsCommon: false };
  }
  // Unknown suffix — return null so the caller can flag it.
  return null;
}

// ── Minor unit normalization (GBp → GBP, ZAc → ZAR, ILA → ILS) ──────

const MINOR_UNIT_MAP: Record<string, { major: string; divisor: number }> = {
  GBP_MINOR: { major: "GBP", divisor: 100 }, // GBp
  GBX: { major: "GBP", divisor: 100 }, // alternate code sometimes seen
  GBP_PENCE: { major: "GBP", divisor: 100 },
  ZAC: { major: "ZAR", divisor: 100 }, // South African cents
  ILA: { major: "ILS", divisor: 100 }, // Israeli agorot
};

/**
 * Normalize a (amount, currency) pair to its major unit. If the currency
 * code is already a major unit (USD, CAD, etc), returns as-is. If it's a
 * minor-unit code (GBp, GBX, ZAc, ILA), divides by 100 and returns the
 * major-unit equivalent.
 *
 * Case-insensitive on the currency code so callers don't have to normalize
 * upstream.
 */
export function normalizeToMajorUnit(amount: number, currency: string): { amount: number; currency: string } {
  if (!currency) return { amount, currency };
  const upper = currency.toUpperCase();
  // Look for minor-unit markers: GBp (pence), GBX, ZAc, ILA, etc.
  // Note: case-sensitive on input would distinguish GBP (£) from GBp (pence)
  // but case-insensitive matching means we look at the raw value too.
  const raw = currency.trim();
  if (raw === "GBp" || raw === "GBX" || raw === "GBx") {
    return { amount: amount / 100, currency: "GBP" };
  }
  if (raw === "ZAc") {
    return { amount: amount / 100, currency: "ZAR" };
  }
  if (raw === "ILA" || raw === "ILa") {
    return { amount: amount / 100, currency: "ILS" };
  }
  // Fallback: also accept upper-case codes like "GBPMINOR" if the model emits it
  if (upper in MINOR_UNIT_MAP) {
    const { major, divisor } = MINOR_UNIT_MAP[upper];
    return { amount: amount / divisor, currency: major };
  }
  return { amount, currency: upper };
}

// ── Yahoo FX (historical close on a given date) ──────────────────────

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string };
  };
};

/**
 * Fetch the historical daily close for a Yahoo FX pair on the given UTC date.
 * Returns the actual close date used (which may be earlier than `date` if
 * `date` was a weekend or holiday — Yahoo only quotes on trading days).
 *
 * Cached in Redis at `pm:fx-rate:{PAIR}:{date}` — historical FX is immutable
 * once the close is published, so no TTL. The "actual close date" returned
 * is the user-visible audit trail (so the UI can show "rate as of 2026-05-15"
 * even when the report's asOf was a Saturday).
 */
async function fetchYahooFxClose(pair: string, date: string): Promise<{ rate: number; rateDate: string } | null> {
  // Cache key: PAIR + requested date (not the resolved trading-day date —
  // we want the same cache hit when re-asked for the same Saturday).
  const cacheKey = `pm:fx-rate:${pair}:${date}`;
  let redis;
  try {
    redis = await getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { rate: number; rateDate: string };
        if (typeof parsed.rate === "number" && isFinite(parsed.rate)) return parsed;
      } catch {
        // Bad cache entry — fall through and re-fetch.
      }
    }
  } catch (e) {
    console.error("[fx] Redis read failed (continuing without cache):", e);
  }

  // Build the Yahoo URL. period1 = 7 days before the target date, period2 =
  // target date + 1 day. This window guarantees at least one trading day's
  // close even when the target was a weekend / holiday.
  const target = new Date(`${date}T00:00:00Z`);
  if (isNaN(target.getTime())) return null;
  const period2 = Math.floor(target.getTime() / 1000) + 86400;
  const period1 = period2 - 7 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?period1=${period1}&period2=${period2}&interval=1d`;

  let bars: YahooChartResponse | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 PM-Dashboard FX Fetch" },
    });
    if (!res.ok) return null;
    bars = (await res.json()) as YahooChartResponse;
  } catch (e) {
    console.error(`[fx] Yahoo fetch failed for ${pair}:`, e);
    return null;
  }

  const result = bars?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  if (timestamps.length === 0 || closes.length === 0) return null;

  // Find the most recent valid close at or before the target date.
  const targetSec = period2 - 86400;
  let pickedRate: number | null = null;
  let pickedTs: number | null = null;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] > targetSec) continue; // strictly at-or-before
    const c = closes[i];
    if (typeof c === "number" && isFinite(c) && c > 0) {
      pickedRate = c;
      pickedTs = timestamps[i];
      break;
    }
  }
  if (pickedRate == null || pickedTs == null) return null;
  const rateDate = new Date(pickedTs * 1000).toISOString().slice(0, 10);
  const out = { rate: pickedRate, rateDate };

  // Persist to cache. No TTL — historical rates don't change.
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(out));
    } catch (e) {
      console.error("[fx] Redis write failed:", e);
    }
  }
  return out;
}

/**
 * Get the price of 1 unit of `currency` in USD on the given date. Returns
 * null on failure. USD itself returns { rate: 1, rateDate: date }.
 */
async function rateAgainstUsd(currency: string, date: string): Promise<{ rate: number; rateDate: string } | null> {
  if (currency === "USD") return { rate: 1, rateDate: date };
  // Yahoo convention: CADUSD=X → price of 1 CAD in USD.
  const pair = `${currency}USD=X`;
  const direct = await fetchYahooFxClose(pair, date);
  if (direct) return direct;
  // Some pairs aren't quoted in that direction; try the inverse pair and
  // invert the rate. Example: HUFUSD=X exists but if it didn't, USDHUF=X
  // would and we'd invert.
  const inverse = await fetchYahooFxClose(`USD${currency}=X`, date);
  if (inverse && inverse.rate > 0) {
    return { rate: 1 / inverse.rate, rateDate: inverse.rateDate };
  }
  return null;
}

/**
 * Convert an amount from one currency to another using the historical
 * close on the given date. Routes via USD as the bridge currency, which
 * works for any pair Yahoo quotes against USD (effectively all majors
 * and most non-trivial currencies).
 *
 * Returns null on any fetch failure or unknown currency — caller stores
 * raw amount with a "conversion unavailable" flag.
 */
export async function convertAmount(
  amount: number,
  from: string,
  to: string,
  date: string,
): Promise<{ converted: number; rate: number; rateDate: string } | null> {
  if (!isFinite(amount)) return null;
  // Same-currency: pass through.
  const fromU = from.toUpperCase();
  const toU = to.toUpperCase();
  if (fromU === toU) return { converted: amount, rate: 1, rateDate: date };
  // Both legs against USD.
  const fromUsd = await rateAgainstUsd(fromU, date);
  if (!fromUsd) return null;
  const toUsd = await rateAgainstUsd(toU, date);
  if (!toUsd || toUsd.rate <= 0) return null;
  // 1 fromU = fromUsd.rate USD; 1 toU = toUsd.rate USD; so 1 fromU = (fromUsd / toUsd) toU.
  const rate = fromUsd.rate / toUsd.rate;
  const converted = amount * rate;
  // Pick the earlier of the two trading dates as the "as-of" — guarantees
  // both rates were available on or before that date.
  const rateDate = fromUsd.rateDate < toUsd.rateDate ? fromUsd.rateDate : toUsd.rateDate;
  return { converted, rate, rateDate };
}

/**
 * High-level helper: convert an analyst target from its reported currency to
 * the dashboard ticker's display currency on the report's `asOf` date.
 *
 * Inputs:
 *   - rawTarget: the number extracted from the PDF (may be in minor units)
 *   - reportedCurrency: the currency string extracted from the PDF
 *     (USD, CAD, GBp, etc.) — case is meaningful for minor units
 *   - displayCurrency: the dashboard ticker's currency (from
 *     tickerDisplayCurrency)
 *   - asOf: YYYY-MM-DD report date; if missing, today's date is used
 *
 * Output:
 *   - converted: target in display currency (major unit)
 *   - originalTarget: target in reported currency's MAJOR unit (after GBp/100
 *     normalization). This is what the UI shows in the "converted from" note.
 *   - originalCurrency: major-unit currency code of the original target
 *   - fxRateApplied: the historical FX rate used (1 reportedMajor = rate displayMajor)
 *   - fxRateDate: actual close date the rate came from (may differ from asOf
 *     if asOf was a weekend/holiday)
 *
 * Returns null if anything in the chain failed — caller falls back to
 * storing the raw target with a flag.
 */
export async function convertAnalystTarget(args: {
  rawTarget: number;
  reportedCurrency: string;
  displayCurrency: string;
  asOf?: string;
}): Promise<{
  converted: number;
  originalTarget: number;
  originalCurrency: string;
  fxRateApplied: number;
  fxRateDate: string;
} | null> {
  const { rawTarget, reportedCurrency, displayCurrency, asOf } = args;
  if (!isFinite(rawTarget) || rawTarget <= 0) return null;
  if (!reportedCurrency || !displayCurrency) return null;

  // 1. Normalize minor units (GBp → GBP, ZAc → ZAR, ILA → ILS).
  const { amount: majorTarget, currency: majorCcy } = normalizeToMajorUnit(rawTarget, reportedCurrency);

  // 2. If no conversion needed, short-circuit.
  if (majorCcy.toUpperCase() === displayCurrency.toUpperCase()) {
    return {
      converted: majorTarget,
      originalTarget: majorTarget,
      originalCurrency: majorCcy.toUpperCase(),
      fxRateApplied: 1,
      fxRateDate: asOf ?? new Date().toISOString().slice(0, 10),
    };
  }

  // 3. Fetch historical FX and convert.
  const date = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : new Date().toISOString().slice(0, 10);
  const out = await convertAmount(majorTarget, majorCcy, displayCurrency, date);
  if (!out) return null;
  return {
    converted: parseFloat(out.converted.toFixed(2)),
    originalTarget: majorTarget,
    originalCurrency: majorCcy.toUpperCase(),
    fxRateApplied: parseFloat(out.rate.toFixed(6)),
    fxRateDate: out.rateDate,
  };
}

// ── Currency display helpers (UI-side) ───────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CHF: "CHF ",
  AUD: "A$",
  NZD: "NZ$",
  HKD: "HK$",
  SGD: "S$",
  CNY: "¥",
  KRW: "₩",
  DKK: "kr ",
  SEK: "kr ",
  NOK: "kr ",
  ZAR: "R",
  ILS: "₪",
  MXN: "MX$",
  BRL: "R$",
};

/**
 * Format a numeric amount with the appropriate currency symbol. Falls back
 * to "${code} 245.00" notation for currencies without a known symbol.
 */
export function formatCurrency(amount: number, currency: string): string {
  if (!isFinite(amount)) return "—";
  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOL[code];
  const formatted = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (symbol) return `${symbol}${formatted}`;
  return `${code} ${formatted}`;
}
