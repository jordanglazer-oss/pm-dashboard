/**
 * SEC EDGAR XBRL data helper.
 *
 * STAGE 1: ticker→CIK lookup + raw companyfacts fetch with Redis caching.
 * No concept normalization yet — that's Stage 2's job (industry-aware
 * concept registry so Claude can score a bank on NIM/Tier1Capital while
 * scoring SaaS on FCF margin/RPO).
 *
 * Data sources (all FREE, no API key):
 *   - https://www.sec.gov/files/company_tickers.json
 *       Full ticker→CIK mapping for all SEC-registered issuers (~2MB).
 *       Cached in Redis at `pm:edgar-ticker-map` for 7 days.
 *   - https://data.sec.gov/api/xbrl/companyfacts/CIK{paddedCik}.json
 *       Every XBRL-tagged fact for a company across all filings (10-K,
 *       10-Q, 8-K, etc.). Returned as { facts: { us-gaap: { ConceptName:
 *       { units: { USD: [{ end, val, fy, fp, form, filed }, ... ] } } } } }.
 *       Cached per ticker at `pm:edgar-facts:{ticker}` for 24 hours.
 *
 * SEC requires every caller to identify themselves with a User-Agent
 * header containing a reachable contact email. Set via the
 * SEC_USER_AGENT env var. We refuse to make calls without one rather
 * than risk the SEC blocking the IP — easier to fail loudly.
 *
 * Rate limit: SEC enforces ~10 req/s per IP. We don't approach it
 * because Redis caching means the typical refresh is one ticker-map
 * fetch per week + one companyfacts fetch per ticker per day.
 *
 * Coverage: US-listed issuers only. Canadian listings (-T / .TO) and
 * OTC names without SEC filings will return null — callers should fall
 * back to Yahoo for those.
 */

import { getRedis } from "./redis";

const TICKER_MAP_KEY = "pm:edgar-ticker-map";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const FACTS_URL = (paddedCik: string) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;

const TICKER_MAP_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const FACTS_TTL_SEC = 24 * 60 * 60;          // 24 hours

// ─── Types ──────────────────────────────────────────────────────────

/** One observation of a single XBRL concept (one filing's value). */
export type EdgarFact = {
  /** Period end date (YYYY-MM-DD). */
  end: string;
  /** The reported numeric value in the unit (usually USD). */
  val: number;
  /** Fiscal year (e.g. 2024). */
  fy: number;
  /** Fiscal period: "FY" for annual, "Q1"/"Q2"/"Q3" for quarterly. */
  fp: string;
  /** SEC form type (10-K, 10-Q, 8-K, etc.). */
  form: string;
  /** Date the filing landed at SEC (YYYY-MM-DD). */
  filed: string;
  /** Period start (sometimes present). */
  start?: string;
  /** Accession number — unique per filing. */
  accn?: string;
};

/** Parsed shape of a single concept from companyfacts JSON. */
export type EdgarConcept = {
  label?: string;
  description?: string;
  units: Record<string, EdgarFact[]>; // unit code (USD, shares, etc.) → observations
};

/** Top-level shape of companyfacts JSON for an issuer. */
export type EdgarCompanyFacts = {
  cik: number;
  entityName: string;
  facts: {
    "us-gaap"?: Record<string, EdgarConcept>;
    "dei"?: Record<string, EdgarConcept>;
    [taxonomy: string]: Record<string, EdgarConcept> | undefined;
  };
};

/** Internal: shape of the SEC's company_tickers.json. */
type SecTickerMapEntry = { cik_str: number; ticker: string; title: string };
type SecTickerMap = Record<string, SecTickerMapEntry>;

// ─── User-Agent gate ────────────────────────────────────────────────

function getUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error(
      "SEC_USER_AGENT env var is not set. The SEC EDGAR API requires a User-Agent header containing a contact email (e.g. 'PM Dashboard you@example.com'). Set this in Vercel → Settings → Environment Variables and redeploy."
    );
  }
  return ua;
}

async function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": getUserAgent(),
      "Accept": "application/json",
      // SEC asks API callers to set this so they can clearly distinguish
      // automated traffic from browsers in their logs.
      "Accept-Encoding": "gzip, deflate",
    },
  });
}

// ─── Ticker → CIK mapping ───────────────────────────────────────────

/**
 * Returns the CIK for a US-listed ticker, or null if not in EDGAR.
 *
 * The ticker map is fetched once per 7 days and cached in Redis. First
 * call after expiry triggers the refresh; subsequent calls use the
 * cached blob (lookup is in-memory after we parse it).
 *
 * Tickers are matched case-insensitively. The SEC's mapping uses bare
 * tickers (no -T / .TO suffixes), so Canadian listings are not
 * findable here — that's expected, callers should fall back to Yahoo.
 */
export async function getCikForTicker(ticker: string): Promise<{ cik: number; paddedCik: string; entityName: string } | null> {
  const upper = ticker.trim().toUpperCase();
  // Quick exit for obvious non-US tickers — saves a Redis hit and a
  // pointless EDGAR fetch for Canadian / international names.
  if (upper.endsWith("-T") || upper.endsWith(".TO") || upper.endsWith(".U")) return null;

  const map = await loadTickerMap();
  for (const entry of Object.values(map)) {
    if (entry.ticker.toUpperCase() === upper) {
      return {
        cik: entry.cik_str,
        paddedCik: padCik(entry.cik_str),
        entityName: entry.title,
      };
    }
  }
  return null;
}

async function loadTickerMap(): Promise<SecTickerMap> {
  const redis = await getRedis();
  // Try cache first.
  const cached = await redis.get(TICKER_MAP_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { fetchedAt: string; data: SecTickerMap };
      const ageSec = (Date.now() - new Date(parsed.fetchedAt).getTime()) / 1000;
      if (ageSec < TICKER_MAP_TTL_SEC) return parsed.data;
    } catch { /* fall through to re-fetch */ }
  }

  // Fetch fresh from SEC.
  const res = await secFetch(TICKER_MAP_URL);
  if (!res.ok) {
    // If we have a stale cache, prefer that to throwing.
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { fetchedAt: string; data: SecTickerMap };
        return parsed.data;
      } catch { /* ignore */ }
    }
    throw new Error(`SEC ticker map fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as SecTickerMap;
  await redis.set(
    TICKER_MAP_KEY,
    JSON.stringify({ fetchedAt: new Date().toISOString(), data })
  );
  return data;
}

function padCik(cik: number): string {
  // EDGAR endpoints want the CIK zero-padded to 10 digits.
  return cik.toString().padStart(10, "0");
}

// ─── Company facts (XBRL data) ──────────────────────────────────────

/**
 * Returns the full XBRL fact set for a US issuer, or null if the
 * ticker isn't in EDGAR or the fetch fails. Cached per ticker for 24h.
 */
export async function getCompanyFacts(ticker: string): Promise<EdgarCompanyFacts | null> {
  const cikInfo = await getCikForTicker(ticker);
  if (!cikInfo) return null;

  const cacheKey = `pm:edgar-facts:${ticker.trim().toUpperCase()}`;
  const redis = await getRedis();
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { fetchedAt: string; data: EdgarCompanyFacts };
      const ageSec = (Date.now() - new Date(parsed.fetchedAt).getTime()) / 1000;
      if (ageSec < FACTS_TTL_SEC) return parsed.data;
    } catch { /* fall through to re-fetch */ }
  }

  const res = await secFetch(FACTS_URL(cikInfo.paddedCik));
  if (!res.ok) {
    // 404 is real (some issuers in the ticker map don't have XBRL
    // facts — typically very small or recently delisted). Return null
    // rather than caching nothing, so we don't poison the cache.
    if (res.status === 404) return null;
    if (cached) {
      try {
        return (JSON.parse(cached) as { fetchedAt: string; data: EdgarCompanyFacts }).data;
      } catch { /* ignore */ }
    }
    throw new Error(`SEC companyfacts fetch failed for ${ticker} (CIK ${cikInfo.paddedCik}): HTTP ${res.status}`);
  }
  const data = (await res.json()) as EdgarCompanyFacts;
  await redis.set(
    cacheKey,
    JSON.stringify({ fetchedAt: new Date().toISOString(), data })
  );
  return data;
}

// ─── Convenience accessors ──────────────────────────────────────────

/**
 * Returns the most recent N observations of a us-gaap concept, sorted
 * newest-first. Filters to USD only by default. Returns [] if the
 * concept doesn't exist for this issuer.
 *
 * Used in Stage 1 only by the debug route. Stage 2 will replace this
 * with an industry-aware concept lookup that tries multiple tags in
 * priority order (e.g. for a SaaS company: try
 * RevenueFromContractWithCustomerExcludingAssessedTax → Revenues →
 * SalesRevenueNet, return the first one with data).
 */
export function getConceptSeries(
  facts: EdgarCompanyFacts,
  concept: string,
  opts: { taxonomy?: string; unit?: string; limit?: number } = {}
): EdgarFact[] {
  const taxonomy = opts.taxonomy ?? "us-gaap";
  const unit = opts.unit ?? "USD";
  const limit = opts.limit ?? 12;
  const conceptObj = facts.facts[taxonomy]?.[concept];
  if (!conceptObj) return [];
  const series = conceptObj.units[unit] || [];
  // Newest-first. The SEC returns chronological, so reverse.
  return [...series].sort((a, b) => b.end.localeCompare(a.end)).slice(0, limit);
}

/** Returns the list of us-gaap concept names available for this issuer. */
export function listConcepts(facts: EdgarCompanyFacts, taxonomy = "us-gaap"): string[] {
  const tax = facts.facts[taxonomy];
  if (!tax) return [];
  return Object.keys(tax).sort();
}
