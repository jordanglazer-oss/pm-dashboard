/**
 * Shared SPY hedging cost fetcher used by both the /api/hedging route
 * (which powers the Hedging tab) and the /api/morning-brief route (which
 * injects live put costs into the Hedging Window analysis prompt).
 *
 * Prices come from the Market Data API (app/lib/marketdata-options.ts) since
 * Nov 2026 — the CBOE delayed chain blocks automated requests. Every result
 * carries the quotes' own time (`quotesAsOf`); on a delayed plan or a closed
 * market that is an earlier session, and history is filed under THAT day.
 */

import { hedgeSentimentGate, type HedgeSentimentInputs, type HedgeSentimentResult } from "@/app/lib/agents/policy";
import { getRedis } from "@/app/lib/redis";
import { easternToday } from "@/app/lib/date-eastern";
import { mergeHedgingSnapshot, snapshotDateFor } from "@/app/lib/hedging-snapshot";
import { newestQuoteTime, putKey, spyExpirations, spyPut, spyPuts, spySpot } from "@/app/lib/marketdata-options";

export type HedgingQuote = {
  expiry: string;
  expiryLabel: string;
  daysToExpiry: number;
  atmStrike: number;
  atmPremium: number | null;
  atmPctOfSpot: number | null;
  otm5Strike: number;
  otm5Premium: number | null;
  otm5PctOfSpot: number | null;
  otm10Strike: number;
  otm10Premium: number | null;
  otm10PctOfSpot: number | null;
};

export type CustomStrikeQuote = {
  expiry: string;
  premium: number | null;
  pctOfSpot: number | null;
};

export type CustomStrikeRow = {
  strike: number;
  quotes: CustomStrikeQuote[];
};

export type HedgingLiveData = {
  fetchedAt: string;
  spotPrice: number;
  quotes: HedgingQuote[];
  customRows: CustomStrikeRow[];
  /** Where the prices came from ("Market Data"); absent on a saved snapshot. */
  source?: string;
  /** Time of the newest option quote (ISO). The prices are as of THIS, not fetchedAt. */
  quotesAsOf?: string;
  /** Eastern calendar day of quotesAsOf (YYYY-MM-DD). */
  quotesAsOfDate?: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function roundToNearest5(v: number): number {
  return Math.round(v / 5) * 5;
}

function thirdFridayIso(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstFri = ((5 - first + 7) % 7) + 1;
  const thirdFri = firstFri + 14;
  return `${year}-${String(month).padStart(2, "0")}-${String(thirdFri).padStart(2, "0")}`;
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

function isoToShortLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}-${MONTHS[m - 1]}`;
}

function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = Date.now();
  return Math.max(0, Math.round((target - now) / 86400000));
}

function midPrice(bid: number | undefined, ask: number | undefined, last: number | undefined): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0) {
    return parseFloat(((bid + ask) / 2).toFixed(2));
  }
  if (last != null && last > 0) return parseFloat(last.toFixed(2));
  return null;
}

/**
 * Fetch live SPY put premiums at ATM / ~5% OTM / ~10% OTM across the next
 * 9 calendar months, plus any user-supplied custom strikes.
 *
 * @param extraStrikes  Optional list of custom strikes to price at each expiry
 */
/**
 * Live mid price for an arbitrary SPY put, keyed the way a logged hedge is
 * (expiry + absolute strike). Same Market Data feed fetchLiveHedgingCosts uses — the
 * dashboard narrows that chain to monthly expiries and three strikes, but the
 * raw response carries every listed contract, so a position can be marked
 * directly rather than approximated from the nearest displayed tenor.
 *
 * Returns null when the exact contract is not listed (the exchange lists discrete
 * strikes; a hedge recorded with an off-grid strike cannot be marked) or when
 * bid/ask/last are all absent. Callers must treat null as "unknown", never as
 * zero — a hedge silently valued at zero would overstate a drawdown.
 */
export async function fetchPutQuotes(
  wanted: Array<{ expiry: string; strike: number }>,
): Promise<Map<string, { mid: number | null; bid?: number; ask?: number; last?: number; spot: number }>> {
  const out = new Map<string, { mid: number | null; bid?: number; ask?: number; last?: number; spot: number }>();
  if (wanted.length === 0) return out;

  const [puts, quoteSpot] = await Promise.all([spyPuts(wanted), spySpot()]);
  // SPY at the quotes' own time when the feed gives it (a delayed feed's puts and a newer SPY price must not be mixed).
  const spot = [...puts.values()].find((p) => p?.underlying && p.underlying > 0)?.underlying ?? quoteSpot;
  if (!spot) throw new Error("Could not parse SPY quote or options");

  for (const w of wanted) {
    const key = putKey(w.expiry, w.strike);
    const opt = puts.get(key);
    out.set(key, opt ? { mid: midPrice(opt.bid, opt.ask, opt.last), bid: opt.bid, ask: opt.ask, last: opt.last, spot } : { mid: null, spot });
  }
  return out;
}

export async function fetchLiveHedgingCosts(extraStrikes: number[] = []): Promise<HedgingLiveData> {
  const [allListed, quoteSpot] = await Promise.all([spyExpirations(), spySpot()]);
  if (!quoteSpot || allListed.length === 0) {
    throw new Error("Could not parse SPY quote or options");
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  // Pick best available expiry per calendar month for next 9 months
  const allExpiries = allListed.filter((e) => e > todayIso);
  const now = new Date();
  const monthlyExpiries: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const probe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const y = probe.getUTCFullYear();
    const m = probe.getUTCMonth() + 1;
    const prefix = `${y}-${String(m).padStart(2, "0")}-`;
    const target = thirdFridayIso(y, m);
    const candidates = allExpiries.filter((e) => e.startsWith(prefix) && e > todayIso);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => dayDiff(a, target) - dayDiff(b, target));
    const pick = candidates[0];
    if (!seen.has(pick)) {
      seen.add(pick);
      monthlyExpiries.push(pick);
    }
  }
  monthlyExpiries.sort();

  if (monthlyExpiries.length === 0) throw new Error("No monthly expiries in option chain");

  // One put first, to read SPY at the QUOTES' time: on a delayed feed the puts
  // can be a session behind the stock quote, and strikes and "% of spot" must
  // be measured against the same moment as the premiums.
  const probeStrike = roundToNearest5(quoteSpot);
  const probe = await spyPut(monthlyExpiries[0], probeStrike);
  const spot = probe?.underlying && probe.underlying > 0 ? probe.underlying : quoteSpot;

  const atmStrike = roundToNearest5(spot);
  const otm5Strike = roundToNearest5(spot * 0.95);
  const otm10Strike = roundToNearest5(spot * 0.9);

  const strikes = [...new Set([atmStrike, otm5Strike, otm10Strike, ...extraStrikes])];
  const wanted = monthlyExpiries.flatMap((expiry) => strikes.map((strike) => ({ expiry, strike })));
  const probeKey = putKey(monthlyExpiries[0], probeStrike);
  const puts = await spyPuts(wanted.filter((w) => putKey(w.expiry, w.strike) !== probeKey));
  puts.set(probeKey, probe);
  const premium = (expiry: string, strike: number): number | null => {
    const o = puts.get(putKey(expiry, strike));
    return o ? midPrice(o.bid, o.ask, o.last) : null;
  };
  const pctOfSpot = (v: number | null) => (v != null ? parseFloat(((v / spot) * 100).toFixed(2)) : null);

  const quotes: HedgingQuote[] = monthlyExpiries.map((expiry) => {
    const atmPremium = premium(expiry, atmStrike);
    const otm5Premium = premium(expiry, otm5Strike);
    const otm10Premium = premium(expiry, otm10Strike);
    return {
      expiry,
      expiryLabel: isoToShortLabel(expiry),
      daysToExpiry: daysUntil(expiry),
      atmStrike,
      atmPremium,
      atmPctOfSpot: pctOfSpot(atmPremium),
      otm5Strike,
      otm5Premium,
      otm5PctOfSpot: pctOfSpot(otm5Premium),
      otm10Strike,
      otm10Premium,
      otm10PctOfSpot: pctOfSpot(otm10Premium),
    };
  });
  if (quotes.every((q) => q.atmPremium == null && q.otm5Premium == null && q.otm10Premium == null)) throw new Error("Market Data returned no SPY put prices");

  const customRows: CustomStrikeRow[] = extraStrikes.map((strike) => ({
    strike,
    quotes: monthlyExpiries.map((expiry) => {
      const p = premium(expiry, strike);
      return { expiry, premium: p, pctOfSpot: pctOfSpot(p) };
    }),
  }));

  const quotesAsOf = newestQuoteTime(puts.values());
  return {
    fetchedAt: new Date().toISOString(),
    spotPrice: parseFloat(spot.toFixed(2)),
    quotes,
    customRows,
    source: "Market Data",
    ...(quotesAsOf ? { quotesAsOf, quotesAsOfDate: easternToday(new Date(quotesAsOf)) } : {}),
  };
}

// ---- Hedging history snapshot helpers (shared with /api/kv/hedging-history) ----

type SnapshotQuote = {
  expiry: string;
  atmStrike: number;
  atmPremium: number | null;
  otm5Strike: number;
  otm5Premium: number | null;
  otm10Strike: number;
  otm10Premium: number | null;
};

type HedgingSnapshotShape = {
  date: string;
  spotPrice: number;
  quotes: SnapshotQuote[];
};

/** Read the full snapshot ledger from Redis. Empty array on error. */
export async function loadHedgingHistory(): Promise<HedgingSnapshotShape[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:hedging-history");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  } catch {
    return [];
  }
}

/**
 * Fetch live SPY hedging costs and append them to the `pm:hedging-history`
 * ledger as today's snapshot — the same shape the Hedging tab writes on
 * refresh. Meant to be called from the daily cron so the ledger builds
 * density even on days the user never opens the tab (which is why
 * week-over-week comparisons were coming up empty). Read-modify-write:
 * replaces today's entry if present, else appends; never touches prior days.
 *
 * Best-effort — throws are the caller's to swallow so the cron's primary job
 * (the nightly backup) is never jeopardised.
 */
export async function captureLiveHedgingSnapshot(): Promise<{ date: string; totalSnapshots: number }> {
  const redis = await getRedis();

  // Include any custom strikes the user tracks so their WoW/MoM rows fill too.
  let extraStrikes: number[] = [];
  try {
    const rawCs = await redis.get("pm:hedging-custom-strikes");
    if (rawCs) {
      const parsed = JSON.parse(rawCs);
      const list = Array.isArray(parsed?.strikes) ? parsed.strikes : [];
      extraStrikes = list.filter((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0);
    }
  } catch {
    extraStrikes = [];
  }

  const live = await fetchLiveHedgingCosts(extraStrikes);
  if (!live.quotes.length) throw new Error("No quotes in live hedging data — refusing to write empty snapshot");

  const date = snapshotDateFor(live);
  const snapshot = {
    date,
    fetchedAt: live.quotesAsOf ?? live.fetchedAt,
    spotPrice: live.spotPrice,
    quotes: live.quotes.map((q) => ({
      expiry: q.expiry,
      atmStrike: q.atmStrike,
      atmPremium: q.atmPremium,
      otm5Strike: q.otm5Strike,
      otm5Premium: q.otm5Premium,
      otm10Strike: q.otm10Strike,
      otm10Premium: q.otm10Premium,
    })),
    customRows: (live.customRows || []).map((r) => ({
      strike: r.strike,
      quotes: r.quotes.map((q) => ({ expiry: q.expiry, premium: q.premium })),
    })),
  };

  // Read-modify-write: preserve every prior day; replace only today's entry.
  const raw = await redis.get("pm:hedging-history");
  const history = raw ? JSON.parse(raw) : { snapshots: [], lastUpdated: null };
  const prior: Array<{ date: string }> = Array.isArray(history.snapshots) ? history.snapshots : [];
  const { snapshots, wrote } = mergeHedgingSnapshot(prior, snapshot);
  if (wrote) await redis.set("pm:hedging-history", JSON.stringify({ ...history, snapshots, lastUpdated: new Date().toISOString() }));

  return { date, totalSnapshots: snapshots.length };
}

/** Closest snapshot within ±tolerance days of daysAgo, else null. */
export function findSnapshotDaysAgo(
  history: HedgingSnapshotShape[],
  daysAgo: number,
  toleranceDays: number,
): HedgingSnapshotShape | null {
  if (history.length === 0) return null;
  const target = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  let best: HedgingSnapshotShape | null = null;
  let bestDiff = Infinity;
  for (const s of history) {
    const diff = dayDiff(s.date, target);
    if (diff <= toleranceDays && diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// ---- Premium context: percentiles vs the ledger's own history ----------------

/** Tenor buckets used to compare like-for-like across snapshots (a "3M" put
 *  today must be ranked against ~3M puts historically, not the whole surface). */
/**
 * MONTHLY ORDINAL buckets: M1 = the nearest monthly expiry, M2 the next, and
 * so on out to M9. The snapshot ledger already stores one quote per calendar
 * month, so this is computable retroactively over the whole history.
 *
 * Replaces three wide DTE bands. The old "2-4M" band spanned 46-135 days — a
 * 2.9x range in time — and premium scales with sqrt(t), so identical
 * volatility produced premiums differing by 1.71x WITHIN one bucket. The
 * percentile was therefore ranking tenor as much as vol, which is how a
 * contract down 30% MoM still read 60th percentile while its neighbours read
 * 0th and 15th. An ordinal drifts only ~30 days (1.22x), and the sqrt(t)
 * normalisation below removes what remains.
 */
const MONTH_BUCKETS = Array.from({ length: 9 }, (_, i) => ({
  key: `m${i + 1}`,
  label: `M${i + 1}`,
  ordinal: i,
}));

/**
 * Rank a VOL-LIKE quantity, not a raw premium: premium-as-%-of-spot divided by
 * sqrt(years). Two observations of the same bucket taken at 60 and 90 DTE are
 * otherwise ~22% apart for no volatility reason at all.
 */
const volNormalize = (pctOfSpot: number, dte: number): number | null =>
  dte > 0 ? pctOfSpot / Math.sqrt(dte / 365) : null;

export type PremiumBucketContext = {
  bucket: string;          // label
  daysToExpiry: number;    // today's anchor tenor
  otm5Pct: number | null;      // % of spot today
  otm5Percentile: number | null;   // 0-100 within trailing history
  otm10Pct: number | null;
  otm10Percentile: number | null;
  skewRatio: number | null;        // 10% OTM premium ÷ ATM premium (steepness proxy)
  skewPercentile: number | null;
};

export type PremiumContext = {
  sessions: number; // distinct history dates contributing
  windowDays: number;
  /** Earliest ledger date contributing — surfaced so "percentile" claims are
   *  always labeled with the span they actually rank within. */
  firstDate: string | null;
  /** Long-horizon VIX/VIX3M anchor — the multi-regime guard against the
   *  ledger's short collection window. Null when unavailable. */
  volAnchor: VolAnchor | null;
  buckets: PremiumBucketContext[];
  vvix: number | null;
};

/** Percentile (0-100) of `value` within `dist` (share of observations ≤ value). */
function percentileOf(value: number, dist: number[]): number | null {
  if (dist.length < 20) return null; // too thin to rank honestly
  const below = dist.filter((x) => x <= value).length;
  return Math.round((below / dist.length) * 100);
}

// ---- Long-horizon vol anchor: the guard against short-window bias -----------
//
// The ledger percentiles rank today's premiums ONLY within our own collection
// window — if that window spans a single vol regime, "cheap" merely means
// "cheapest corner of that regime". VIX (1990+) and VIX3M (2009+) have decades
// of free daily history and a 2-4M put premium tracks VIX3M tightly, so their
// full-history percentile tells us whether the WHOLE window is itself a cheap
// or expensive vol regime. The two rulers are always read together.

export type VolAnchor = {
  computedAt: string;
  vix: { level: number; percentile: number; years: number } | null;
  vix3m: { level: number; percentile: number; years: number } | null;
};

const VOL_ANCHOR_KEY = "pm:vol-anchor";
const VOL_ANCHOR_TTL_MS = 24 * 60 * 60 * 1000;

/** Full daily close history for an index symbol from Yahoo. Explicit epoch
 *  bounds (period1=0) — `range=max` silently truncates for ^VIX/^VIX3M
 *  (verified: 439 bars vs 9200+ with epoch bounds). */
async function fetchIndexHistory(symbol: string): Promise<number[] | null> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`,
      { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(
      (c): c is number => typeof c === "number" && isFinite(c) && c > 0,
    );
    return closes.length >= 500 ? closes : null; // need real multi-year history
  } catch {
    return null;
  }
}

/**
 * Current VIX / VIX3M level ranked against their FULL available history.
 * Cached 24h in pm:vol-anchor (regenerable — safe to nuke); vol regimes don't
 * move enough intraday to justify re-downloading ~9000 bars per brief.
 */
export async function getVolAnchor(): Promise<VolAnchor | null> {
  try {
    const redis = await getRedis();
    const cachedRaw = await redis.get(VOL_ANCHOR_KEY);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as VolAnchor;
        if (Date.now() - new Date(cached.computedAt).getTime() < VOL_ANCHOR_TTL_MS) return cached;
      } catch { /* recompute */ }
    }
    const [vixHist, vix3mHist] = await Promise.all([fetchIndexHistory("^VIX"), fetchIndexHistory("^VIX3M")]);
    const rank = (hist: number[] | null): VolAnchor["vix"] => {
      if (!hist || hist.length < 500) return null;
      const level = hist[hist.length - 1];
      const below = hist.filter((x) => x <= level).length;
      return {
        level: Math.round(level * 10) / 10,
        percentile: Math.round((below / hist.length) * 100),
        years: Math.round(hist.length / 252),
      };
    };
    const anchor: VolAnchor = { computedAt: new Date().toISOString(), vix: rank(vixHist), vix3m: rank(vix3mHist) };
    if (!anchor.vix && !anchor.vix3m) return null;
    await redis.set(VOL_ANCHOR_KEY, JSON.stringify(anchor));
    return anchor;
  } catch {
    return null;
  }
}

/** Latest ^VVIX close from Yahoo (vol-of-vol — cheapness context for options).
 *  Null on any failure; never throws. */
export async function fetchVvix(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5EVVIX?range=5d&interval=1d",
      { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(
      (c): c is number => typeof c === "number" && isFinite(c),
    );
    return closes.length ? Math.round(closes[closes.length - 1] * 10) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * Rank today's anchor premiums (and skew) against the ledger's trailing
 * ~6 months, per tenor bucket. Pure math over data we already collect —
 * this is what turns "premiums are reasonable" from a vibe into a measured
 * percentile. Null percentiles when the ledger is too thin (<20 sessions).
 */
export function computePremiumContext(
  live: HedgingLiveData,
  history: HedgingSnapshotShape[],
  windowDays = 185,
): Omit<PremiumContext, "vvix" | "volAnchor"> {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const recent = history.filter((s) => s.date >= cutoff && s.spotPrice > 0);

  // Distributions per bucket: pct-of-spot for 5%/10% OTM + skew ratio. One
  // observation per (snapshot, bucket): the quote closest to the bucket's
  // tenor midpoint.
  const dist: Record<string, { otm5: number[]; otm10: number[]; skew: number[] }> = {};
  for (const b of MONTH_BUCKETS) dist[b.key] = { otm5: [], otm10: [], skew: [] };
  for (const snap of recent) {
    // The Nth-nearest monthly expiry on that day — constant maturity by
    // construction, so today's M3 is compared against past M3s.
    const dated = snap.quotes
      .map((qt) => ({ qt, dte: dayDiff(qt.expiry, snap.date) }))
      .filter((x) => x.dte > 0)
      .sort((a, b) => a.dte - b.dte);
    for (const b of MONTH_BUCKETS) {
      const hit = dated[b.ordinal];
      if (!hit) continue;
      const { qt, dte } = hit;
      if (qt.otm5Premium != null) {
        const v = volNormalize((qt.otm5Premium / snap.spotPrice) * 100, dte);
        if (v != null) dist[b.key].otm5.push(v);
      }
      if (qt.otm10Premium != null) {
        const v = volNormalize((qt.otm10Premium / snap.spotPrice) * 100, dte);
        if (v != null) dist[b.key].otm10.push(v);
      }
      // Skew is already a RATIO of two premiums at the same tenor, so it needs
      // no normalisation — the tenor cancels.
      if (qt.otm10Premium != null && qt.atmPremium != null && qt.atmPremium > 0) {
        dist[b.key].skew.push(qt.otm10Premium / qt.atmPremium);
      }
    }
  }

  const buckets: PremiumBucketContext[] = [];
  const liveSorted = [...live.quotes].filter((q) => q.daysToExpiry > 0).sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  for (const b of MONTH_BUCKETS) {
    const anchor: HedgingQuote | null = liveSorted[b.ordinal] ?? null;
    if (!anchor) continue;
    const skewRatio =
      anchor.otm10Premium != null && anchor.atmPremium != null && anchor.atmPremium > 0
        ? Math.round((anchor.otm10Premium / anchor.atmPremium) * 1000) / 1000
        : null;
    buckets.push({
      bucket: b.label,
      daysToExpiry: anchor.daysToExpiry,
      otm5Pct: anchor.otm5PctOfSpot,
      otm5Percentile: (() => {
        const v = anchor.otm5PctOfSpot != null ? volNormalize(anchor.otm5PctOfSpot, anchor.daysToExpiry) : null;
        return v != null ? percentileOf(v, dist[b.key].otm5) : null;
      })(),
      otm10Pct: anchor.otm10PctOfSpot,
      otm10Percentile: (() => {
        const v = anchor.otm10PctOfSpot != null ? volNormalize(anchor.otm10PctOfSpot, anchor.daysToExpiry) : null;
        return v != null ? percentileOf(v, dist[b.key].otm10) : null;
      })(),
      skewRatio,
      skewPercentile: skewRatio != null ? percentileOf(skewRatio, dist[b.key].skew) : null,
    });
  }

  return {
    sessions: recent.length,
    windowDays,
    firstDate: recent.length ? recent.reduce((a, s) => (s.date < a ? s.date : a), recent[0].date) : null,
    buckets,
  };
}

/** Inputs for the deterministic hedge-entry checklist. All nullable — a null
 *  renders as "?" (data unavailable) rather than a fabricated verdict. */
export type HedgeChecklistInputs = {
  consolidatedRegime: string;
  transitionLeaning: string | null;    // e.g. "toward Risk-Off"
  transitionLikelihood: string | null; // "Low" | "Watch" | "Elevated" | "High"
  riskOffSignalCount: number | null;
  ctx: PremiumContext | null;
  fearGreed: number | null;
  oscillator: number | null;
  vix: number | null;
  termStructure: string;
  /** The policy's sentiment tests (app/lib/agents/policy.ts). The skew
   *  percentile is filled from `ctx` when not given. */
  sentiment?: Omit<HedgeSentimentInputs, "skewPercentile"> & { skewPercentile?: number | null };
};

/** One scored checklist condition. `ok: null` = data unavailable ("?"). */
export type HedgeChecklistItem = {
  /** "risk-off" survives only on briefs stored before Nov 2026 — the
   *  classic Risk-Off route was removed from the policy. */
  path: "risk-off" | "cheap" | "sentiment";
  label: string;
  ok: boolean | null;
};

/** One anchor expiry's full quote row — surfaced to the UI so the tile can
 *  show the exact premiums the call was priced against. */
export type HedgingAnchorDetail = {
  expiryLabel: string;
  daysToExpiry: number;
  atmStrike: number;
  atmPremium: number | null;
  atmPctOfSpot: number | null;
  otm5Strike: number;
  otm5Premium: number | null;
  otm5PctOfSpot: number | null;
  otm10Strike: number;
  otm10Premium: number | null;
  otm10PctOfSpot: number | null;
};

/** One WoW/MoM trend comparison row per anchor expiry. */
export type HedgingTrendRow = {
  expiryLabel: string;
  otm5Prior: number | null;
  otm5Curr: number | null;
  otm5DeltaPct: number | null;
  otm10Prior: number | null;
  otm10Curr: number | null;
  otm10DeltaPct: number | null;
};

/** The COMPLETE data basis behind the hedging call — everything quantitative
 *  the model is shown, in structured form, so the Hedging tile can render it
 *  and the decision is never a black box. */
export type HedgingDetail = {
  fetchedAt: string;
  spotPrice: number;
  anchors: HedgingAnchorDetail[];
  wow: { vsDate: string; rows: HedgingTrendRow[] } | null;
  mom: { vsDate: string; rows: HedgingTrendRow[] } | null;
  /** Percentile context per tenor bucket (same object the checklist ranks on). */
  buckets: PremiumBucketContext[];
  sessions: number;
  windowDays: number;
  firstDate: string | null;
  volAnchor: VolAnchor | null;
  vvix: number | null;
};

/** Structured checklist + the headline numbers the UI surfaces beside it. */
export type HedgeChecklist = {
  items: HedgeChecklistItem[];
  /** Mid (2-4M) bucket headline stats — the default tenor the prompt cites. */
  midOtm5Percentile: number | null;
  midOtm10Percentile: number | null;
  midSkewPercentile: number | null;
  vvix: number | null;
  sessions: number | null; // ledger depth behind the percentiles
  /** The policy's sentiment window. ADD requires "open". Absent on old briefs. */
  sentimentGate?: HedgeSentimentResult;
  /** Echo of the scalar inputs the checklist was scored from — surfaced on
   *  the tile's data-basis panel so the regime/vol/sentiment side of the
   *  decision is as inspectable as the premium side. */
  inputs: {
    consolidatedRegime: string;
    transitionLeaning: string | null;
    transitionLikelihood: string | null;
    riskOffSignalCount: number | null;
    fearGreed: number | null;
    oscillator: number | null;
    vix: number | null;
    termStructure: string;
  };
};

/**
 * Deterministic hedge-entry checklist — scores each condition of the two ADD
 * paths from computed data so the hedging call is grounded and consistent.
 * EVIDENCE, not the verdict: the model judges and may override with stated
 * reasons. Shared by the morning brief AND the standalone hedging-refresh
 * endpoint so both always score identically; the STRUCTURED form is returned
 * to the client so the Hedging tile can show the receipts behind the call.
 */
export function computeHedgeChecklist(p: HedgeChecklistInputs): HedgeChecklist {
  // The checklist gates on M3 — the 3rd monthly expiry, ~2.5-3 months out.
  // That is what the old "2-4M" anchor actually resolved to, so the intent is
  // unchanged; it is now a clean constant-maturity point instead of a 46-135d
  // smear. One line to move to M4 if protection is usually bought further out.
  const GATE = "M3";
  const midB = p.ctx?.buckets.find((b) => b.bucket === GATE) ?? p.ctx?.buckets[0] ?? null;
  const gateLabel = midB ? `${midB.bucket} (~${midB.daysToExpiry}d)` : GATE;

  // Sentiment window — the policy's "never hedge into fear" rule. Any one
  // failing test closes it; thin data leaves it "unknown" (also no ADD).
  const sentimentGate = hedgeSentimentGate({
    fearGreed: p.sentiment?.fearGreed ?? p.fearGreed,
    vixDayChangePct: p.sentiment?.vixDayChangePct ?? null,
    aaiiSpread: p.sentiment?.aaiiSpread ?? null,
    putCall: p.sentiment?.putCall ?? null,
    skewPercentile: p.sentiment?.skewPercentile ?? midB?.skewPercentile ?? null,
  });

  const items: HedgeChecklistItem[] = [
    ...sentimentGate.tests.map<HedgeChecklistItem>((t) => ({
      path: "sentiment",
      ok: t.pass,
      label: `${t.label}${t.value != null ? ` (currently: ${t.value})` : " (unavailable)"} — ${t.limit}`,
    })),
    {
      path: "cheap",
      ok: midB?.otm5Percentile != null ? midB.otm5Percentile <= 35 : null,
      label: `${gateLabel} 5%OTM premium ≤35th percentile${midB?.otm5Percentile != null ? ` (currently: ${midB.otm5Percentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: midB?.otm10Percentile != null ? midB.otm10Percentile <= 35 : null,
      label: `${gateLabel} 10%OTM premium ≤35th percentile${midB?.otm10Percentile != null ? ` (currently: ${midB.otm10Percentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: p.ctx?.vvix != null ? p.ctx.vvix <= 100 : null,
      label: `VVIX ≤100${p.ctx?.vvix != null ? ` (currently: ${p.ctx.vvix})` : " (unavailable)"}`,
    },
    {
      // The guard against short-window bias: the ledger percentile only ranks
      // within our own collection span; this line asks whether the WHOLE
      // window sits in a cheap-vol regime by multi-decade standards.
      path: "cheap",
      ok: (() => {
        const a = p.ctx?.volAnchor;
        const anchor = a?.vix3m ?? a?.vix ?? null;
        return anchor ? anchor.percentile <= 60 : null;
      })(),
      label: (() => {
        const a = p.ctx?.volAnchor;
        const anchor = a?.vix3m ?? a?.vix ?? null;
        const name = a?.vix3m ? "VIX3M" : "VIX";
        return `Long-horizon vol not elevated: ${name} ≤60th percentile of full history${anchor ? ` (currently: ${anchor.level} = ${anchor.percentile}th of ~${anchor.years}y)` : " (anchor unavailable)"}`;
      })(),
    },
    {
      path: "cheap",
      ok: midB?.skewPercentile != null ? midB.skewPercentile <= 50 : null,
      label: `Skew ≤50th percentile — tails not already bid${midB?.skewPercentile != null ? ` (currently: ${midB.skewPercentile}th)` : " (unranked)"}`,
    },
    {
      path: "cheap",
      ok: p.fearGreed != null ? p.fearGreed >= 70 : null,
      label: `Late-cycle: F&G ≥70${p.fearGreed != null ? ` (currently: ${p.fearGreed})` : ""}`,
    },
    {
      path: "cheap",
      ok: p.oscillator != null ? p.oscillator >= 2.5 : null,
      label: `Late-cycle: S&P Oscillator ≥ +2.5%${p.oscillator != null ? ` (currently: ${p.oscillator >= 0 ? "+" : ""}${p.oscillator}%)` : ""}`,
    },
    {
      path: "cheap",
      ok: p.vix != null ? p.vix <= 16 : null,
      label: `Late-cycle: VIX ≤16 complacency${p.vix != null ? ` (currently: ${p.vix})` : ""}${p.termStructure ? ` — term structure ${p.termStructure}` : ""}`,
    },
  ];

  return {
    items,
    midOtm5Percentile: midB?.otm5Percentile ?? null,
    midOtm10Percentile: midB?.otm10Percentile ?? null,
    midSkewPercentile: midB?.skewPercentile ?? null,
    vvix: p.ctx?.vvix ?? null,
    sessions: p.ctx?.sessions ?? null,
    sentimentGate,
    inputs: {
      consolidatedRegime: p.consolidatedRegime,
      transitionLeaning: p.transitionLeaning,
      transitionLikelihood: p.transitionLikelihood,
      riskOffSignalCount: p.riskOffSignalCount,
      fearGreed: p.fearGreed,
      oscillator: p.oscillator,
      vix: p.vix,
      termStructure: p.termStructure,
    },
  };
}

/** Prompt rendering of the same checklist (delegates to computeHedgeChecklist
 *  so prompt and UI can never disagree). */
/** Below this many ledger sessions the premium percentiles have not yet seen a
 *  vol spike, so the multi-decade anchor line gates the cheap-insurance path. */
export const LEDGER_MATURE_SESSIONS = 250;

export function buildHedgeChecklistBlock(p: HedgeChecklistInputs): string {
  const cl = computeHedgeChecklist(p);
  const youngLedger = (cl.sessions ?? 0) < LEDGER_MATURE_SESSIONS;
  const line = (i: HedgeChecklistItem): string => `  ${i.ok == null ? "?" : i.ok ? "✓" : "✗"} ${i.label}`;
  return [
    "",
    "",
    "HEDGE-ENTRY CHECKLIST (computed from live data — evidence for hedgingAnalysis/hedgingCall):",
    `Sentiment window (POLICY — not overridable): ${cl.sentimentGate?.window.toUpperCase() ?? "UNKNOWN"}. Any one ✗ closes it; too little data leaves it unknown.`,
    ...cl.items.filter((i) => i.path === "sentiment").map(line),
    "Cheap insurance (premium conditions) + late-cycle warning (need ≥2 of the 3 late-cycle signs):",
    ...cl.items.filter((i) => i.path === "cheap").map(line),
    `Reading it: ADD needs ALL of — (a) the sentiment window OPEN; (b) at least one premium condition ✓ with VVIX/skew not contradicting; (c) at least TWO of the three late-cycle signs ✓.${youngLedger ? ` LEDGER GATE: the premium ledger holds only ${cl.sessions ?? 0} sessions (under ${LEDGER_MATURE_SESSIONS}), so its percentiles cannot see a vol spike yet — until it matures, ADD ALSO requires the "Long-horizon vol not elevated" line to be ✓.` : ""} A Risk-Off regime on its own is NOT a reason to ADD — the policy hedges BEFORE fear, never reactively after a spike; the regime's horizons only choose the tenor. If the sentiment window is not OPEN the call is SKIP (or HOLD if protection is already on) — the server enforces this. Otherwise the default is SKIP. Cite the specific ✓/✗ lines that drove your call; you may override a premium or late-cycle line with a stated reason, never the sentiment window.`,
  ].join("\n");
}

/** Plain-English cheapness label for a premium percentile. */
export function percentileLabel(p: number | null): string {
  if (p == null) return "no rank (ledger too thin)";
  if (p <= 25) return "CHEAP";
  if (p <= 45) return "below average";
  if (p <= 60) return "average";
  if (p <= 80) return "above average";
  return "RICH";
}

/**
 * Render a compact text block summarizing live SPY put costs + WoW trend +
 * percentile context, suitable for injection into a Claude prompt. Returns
 * { text: "", ctx: null, detail: null } on error so the brief still generates.
 * `ctx` is the structured premium context shared with the hedge-entry
 * checklist and the hedge-timing score; `detail` is the SAME data in full
 * structured form for the Hedging tile's expandable data-basis panel — the
 * text (model) and detail (UI) are built from the same values in the same
 * pass, so they can never diverge.
 */
export async function buildHedgingCostsBlock(): Promise<{
  text: string;
  ctx: PremiumContext | null;
  detail: HedgingDetail | null;
}> {
  try {
    const live = await fetchLiveHedgingCosts();
    const history = await loadHedgingHistory();
    const wow = findSnapshotDaysAgo(history, 7, 2);
    const mom = findSnapshotDaysAgo(history, 30, 5);
    const [premiumCtx, vvix, volAnchor] = await Promise.all([
      Promise.resolve(computePremiumContext(live, history)),
      fetchVvix(),
      getVolAnchor(),
    ]);

    // Pick 3 anchor expiries: nearest ≤45d, mid 60–120d, and longest-dated
    const q = live.quotes;
    const pickAnchor = (predicate: (d: number) => boolean) => q.find((x) => predicate(x.daysToExpiry));
    const near = pickAnchor((d) => d <= 45) || q[0];
    const mid = pickAnchor((d) => d >= 60 && d <= 120) || q[Math.floor(q.length / 2)];
    const far = q[q.length - 1];
    const anchors = Array.from(new Set([near, mid, far].filter(Boolean))) as HedgingQuote[];

    const lines: string[] = [];
    const asOfEt = live.quotesAsOf ? new Date(live.quotesAsOf).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " ET" : null;
    const staleDay = live.quotesAsOfDate && live.quotesAsOfDate !== easternToday();
    lines.push(`SPY Hedging Costs (Market Data${asOfEt ? `, prices as of ${asOfEt}` : ""}${staleDay ? " — an EARLIER session, NOT today's prices; say so when citing a premium" : ""}):`);
    lines.push(`- SPY Spot: $${live.spotPrice.toFixed(2)}`);
    lines.push(`- Strike ladder: ATM $${anchors[0].atmStrike} / ~5% OTM $${anchors[0].otm5Strike} / ~10% OTM $${anchors[0].otm10Strike}`);
    lines.push("");
    lines.push("Put premiums (mid price, % of spot):");
    for (const a of anchors) {
      const fmt = (p: number | null, pct: number | null) =>
        p != null && pct != null ? `$${p.toFixed(2)} (${pct.toFixed(2)}%)` : "—";
      lines.push(
        `- ${a.expiryLabel} (${a.daysToExpiry}d): ATM ${fmt(a.atmPremium, a.atmPctOfSpot)} | 5%OTM ${fmt(a.otm5Premium, a.otm5PctOfSpot)} | 10%OTM ${fmt(a.otm10Premium, a.otm10PctOfSpot)}`,
      );
    }

    // WoW / MoM trend on the 5% OTM and 10% OTM premiums for the anchor
    // expiries. These are the strikes the morning-brief hedgingAnalysis
    // prompt cites by default (5–10% OTM tail protection), so the trend
    // signal needs to follow the same strikes — tracking ATM here would
    // force the model to extrapolate from a different point on the
    // skew curve. ATM is omitted entirely.
    /**
     * CONSTANT-MATURITY lookup: the prior snapshot's quote at the SAME MONTHLY
     * ORDINAL, not the same expiry.
     *
     * Matching on expiry compared one contract to itself a week older, so the
     * delta was dominated by theta: the 21-Aug put went 22 DTE -> 16 DTE and
     * printed "-69.5% WoW", which read as premiums collapsing when it mostly
     * meant a week had passed. Comparing the Nth-nearest monthly then vs now
     * holds maturity roughly fixed, so what is left is an actual move in the
     * cost of protection.
     */
    const liveByDte = [...live.quotes].filter((x) => x.daysToExpiry > 0).sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    const priorAtSameOrdinal = (snap: HedgingSnapshotShape, a: HedgingQuote) => {
      const ordinal = liveByDte.findIndex((x) => x.expiry === a.expiry);
      if (ordinal < 0) return undefined;
      const dated = snap.quotes
        .map((qt) => ({ qt, dte: dayDiff(qt.expiry, snap.date) }))
        .filter((x) => x.dte > 0)
        .sort((x, y) => x.dte - y.dte);
      return dated[ordinal]?.qt;
    };

    const structuredTrend = (snap: HedgingSnapshotShape | null): { vsDate: string; rows: HedgingTrendRow[] } | null => {
      if (!snap) return null;
      const rows: HedgingTrendRow[] = anchors.map((a) => {
        const priorRow = priorAtSameOrdinal(snap, a);
        const delta = (prior: number | null | undefined, curr: number | null): number | null =>
          prior != null && curr != null && prior !== 0 ? Math.round(((curr - prior) / prior) * 1000) / 10 : null;
        return {
          expiryLabel: a.expiryLabel,
          otm5Prior: priorRow?.otm5Premium ?? null,
          otm5Curr: a.otm5Premium,
          otm5DeltaPct: delta(priorRow?.otm5Premium, a.otm5Premium),
          otm10Prior: priorRow?.otm10Premium ?? null,
          otm10Curr: a.otm10Premium,
          otm10DeltaPct: delta(priorRow?.otm10Premium, a.otm10Premium),
        };
      });
      return { vsDate: snap.date, rows };
    };

    const trendBlock = (label: string, snap: HedgingSnapshotShape | null, daysAgoLabel: string): string[] => {
      if (!snap) return [`${label}: no snapshot ~${daysAgoLabel} ago in ledger yet`];
      const rows: string[] = [
        `${label} (vs ${snap.date}, SPY $${snap.spotPrice.toFixed(2)}) — constant maturity: same Nth monthly, not the same contract, so theta is excluded:`,
      ];
      for (const a of anchors) {
        const priorRow = priorAtSameOrdinal(snap, a);
        const fmtDelta = (label: string, prior: number | null | undefined, curr: number | null) => {
          if (prior == null || curr == null || prior === 0) return `${label} —`;
          const dPct = ((curr - prior) / prior) * 100;
          const sign = dPct >= 0 ? "+" : "";
          return `${label} $${prior.toFixed(2)} → $${curr.toFixed(2)} (${sign}${dPct.toFixed(1)}%)`;
        };
        const otm5 = fmtDelta("5%OTM", priorRow?.otm5Premium, a.otm5Premium);
        const otm10 = fmtDelta("10%OTM", priorRow?.otm10Premium, a.otm10Premium);
        rows.push(`- ${a.expiryLabel}: ${otm5} | ${otm10}`);
      }
      return rows;
    };

    lines.push("");
    lines.push(...trendBlock("Week-over-week", wow, "7 days"));
    lines.push("");
    lines.push(...trendBlock("Month-over-month", mom, "30 days"));

    // ── Percentile context: is "reasonable premium" actually true today? ──
    lines.push("");
    if (premiumCtx.buckets.length > 0 && premiumCtx.sessions >= 20) {
      lines.push(
        `Premium percentile context (each tenor ranked against its own trailing ${premiumCtx.windowDays}-day ledger, ${premiumCtx.sessions} sessions — LOW percentile = historically cheap):`,
      );
      for (const b of premiumCtx.buckets) {
        const p5 = b.otm5Percentile != null ? `${b.otm5Percentile}th pct (${percentileLabel(b.otm5Percentile)})` : "unranked";
        const p10 = b.otm10Percentile != null ? `${b.otm10Percentile}th pct (${percentileLabel(b.otm10Percentile)})` : "unranked";
        const sk = b.skewRatio != null
          ? `skew (10%OTM/ATM) ${b.skewRatio.toFixed(2)}${b.skewPercentile != null ? ` = ${b.skewPercentile}th pct` : ""}`
          : "skew —";
        lines.push(`- ${b.bucket} (${b.daysToExpiry}d): 5%OTM ${b.otm5Pct?.toFixed(2) ?? "—"}% of spot → ${p5} | 10%OTM ${b.otm10Pct?.toFixed(2) ?? "—"}% → ${p10} | ${sk}`);
      }
    } else {
      lines.push(
        `Premium percentile context: ledger too thin to rank (${premiumCtx.sessions} sessions in window) — judge cheapness from the WoW/MoM trend and VIX/VVIX levels instead, and say you are doing so.`,
      );
    }
    lines.push(
      vvix != null
        ? `VVIX (vol-of-vol): ${vvix} — <90 low (options cheap to gamma), 90-110 normal, >110 elevated (protection demand bid).`
        : "VVIX: unavailable this run.",
    );

    // ── Long-horizon anchor: guard against the ledger's short window ──
    lines.push("");
    if (premiumCtx.firstDate) {
      lines.push(
        `LEDGER SPAN HONESTY: the percentiles above rank ONLY within our own collection window (since ${premiumCtx.firstDate}, ${premiumCtx.sessions} sessions) — they cannot see vol regimes outside it.`,
      );
    }
    if (volAnchor && (volAnchor.vix || volAnchor.vix3m)) {
      const parts: string[] = [];
      if (volAnchor.vix) parts.push(`VIX ${volAnchor.vix.level} = ${volAnchor.vix.percentile}th percentile of ~${volAnchor.vix.years}y of history`);
      if (volAnchor.vix3m) parts.push(`VIX3M ${volAnchor.vix3m.level} = ${volAnchor.vix3m.percentile}th percentile of ~${volAnchor.vix3m.years}y (the closest proxy for 2-4M put pricing)`);
      lines.push(`Long-horizon vol anchor (multi-regime): ${parts.join("; ")}.`);
      lines.push(
        `READ THE TWO RULERS TOGETHER: ledger percentile LOW + anchor percentile LOW → genuinely cheap insurance in absolute regime terms. Ledger LOW but anchor HIGH → only locally cheap within an elevated-vol window — protection is still expensive by multi-year standards; say which case applies whenever you call premiums cheap or rich.`,
      );
    } else {
      lines.push("Long-horizon vol anchor: unavailable this run — treat ledger percentiles as window-relative only and say so.");
    }

    const detail: HedgingDetail = {
      fetchedAt: live.fetchedAt,
      spotPrice: live.spotPrice,
      anchors: anchors.map((a) => ({
        expiryLabel: a.expiryLabel,
        daysToExpiry: a.daysToExpiry,
        atmStrike: a.atmStrike,
        atmPremium: a.atmPremium,
        atmPctOfSpot: a.atmPctOfSpot,
        otm5Strike: a.otm5Strike,
        otm5Premium: a.otm5Premium,
        otm5PctOfSpot: a.otm5PctOfSpot,
        otm10Strike: a.otm10Strike,
        otm10Premium: a.otm10Premium,
        otm10PctOfSpot: a.otm10PctOfSpot,
      })),
      wow: structuredTrend(wow),
      mom: structuredTrend(mom),
      buckets: premiumCtx.buckets,
      sessions: premiumCtx.sessions,
      windowDays: premiumCtx.windowDays,
      firstDate: premiumCtx.firstDate,
      volAnchor,
      vvix,
    };

    return { text: lines.join("\n"), ctx: { ...premiumCtx, vvix, volAnchor }, detail };
  } catch (e) {
    console.error("buildHedgingCostsBlock failed:", e);
    return { text: "", ctx: null, detail: null };
  }
}
