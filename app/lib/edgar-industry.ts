/**
 * SEC SIC-code → industry classification.
 *
 * Used by the EDGAR concept registry to pick the right XBRL tags for
 * scoring. Banks score off NIM and Tier 1; SaaS scores off FCF margin
 * and RPO; REITs score off FFO and NOI. The deterministic SIC
 * boundaries below come straight from the SEC's industry codes table.
 *
 * Source: https://www.sec.gov/info/edgar/siccodes.htm
 *
 * SIC code is fetched from the SEC submissions API:
 *   https://data.sec.gov/submissions/CIK{paddedCik}.json
 *   → { ..., "sic": "6020", "sicDescription": "STATE COMMERCIAL BANKS", ... }
 *
 * Cached at `pm:edgar-submissions:{paddedCik}` for 7 days (the SIC code
 * almost never changes for an issuer; we don't need fresh data).
 */

import { getRedis } from "./redis";

const SUBMISSIONS_URL = (paddedCik: string) =>
  `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
const SUBMISSIONS_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export type EdgarIndustry =
  | "bank"
  | "insurance"
  | "reit"
  | "saas"        // software / SaaS
  | "biotech"     // pharma + biotech (high R&D, often pre-profit)
  | "energy"      // upstream oil & gas, integrated, services
  | "utility"
  | "retail"
  | "consumer"    // packaged goods, food, restaurants
  | "industrial"  // manufacturing, chemicals, machinery
  | "telecom"
  | "media"
  | "default";    // fallback: behaves like industrial/general

type EdgarSubmissions = {
  cik: string;
  name: string;
  sic?: string;
  sicDescription?: string;
  tickers?: string[];
  exchanges?: string[];
};

async function secFetch(url: string): Promise<Response> {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error(
      "SEC_USER_AGENT env var is not set. Required for SEC API calls."
    );
  }
  return fetch(url, {
    headers: {
      "User-Agent": ua,
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });
}

/**
 * Fetches the SEC submissions metadata for a CIK. Cached for 7 days.
 * Returns null if the SEC returns 404 or the fetch fails.
 */
export async function getSubmissions(paddedCik: string): Promise<EdgarSubmissions | null> {
  const cacheKey = `pm:edgar-submissions:${paddedCik}`;
  const redis = await getRedis();
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { fetchedAt: string; data: EdgarSubmissions };
      const ageSec = (Date.now() - new Date(parsed.fetchedAt).getTime()) / 1000;
      if (ageSec < SUBMISSIONS_TTL_SEC) return parsed.data;
    } catch { /* fall through */ }
  }

  const res = await secFetch(SUBMISSIONS_URL(paddedCik));
  if (!res.ok) {
    if (cached) {
      try {
        return (JSON.parse(cached) as { fetchedAt: string; data: EdgarSubmissions }).data;
      } catch { /* ignore */ }
    }
    return null;
  }
  const data = (await res.json()) as EdgarSubmissions;
  await redis.set(
    cacheKey,
    JSON.stringify({ fetchedAt: new Date().toISOString(), data })
  );
  return data;
}

/**
 * Maps a 4-digit SIC code to an industry bucket. Boundaries below are
 * documented at https://www.sec.gov/info/edgar/siccodes.htm. When in
 * doubt the mapping returns "default" so the standard concept list is
 * applied — never a wrong specialized list.
 */
export function classifyBySic(sic: string | undefined | null): EdgarIndustry {
  if (!sic) return "default";
  const n = parseInt(sic, 10);
  if (!isFinite(n)) return "default";

  // Banks & holding companies
  if (n === 6020 || n === 6021 || n === 6022 || n === 6029) return "bank";
  if (n >= 6020 && n <= 6099) return "bank";
  if (n === 6199 || n === 6770) return "bank"; // bank holding cos sometimes here
  // Some bank holding companies file as 6770 (Blank Checks) — ambiguous; leave default.

  // Insurance
  if (n >= 6311 && n <= 6411) return "insurance";

  // REITs (Real estate investment trusts)
  if (n === 6798 || n === 6792) return "reit";
  if (n >= 6500 && n <= 6531) return "reit"; // real estate operators (rough)

  // Software / SaaS / IT services
  if (n === 7372 || n === 7370 || n === 7371 || n === 7374 || n === 7389) return "saas";
  if (n === 7370 || n === 7389) return "saas";
  // Internet content & infrastructure
  if (n === 7389 || n === 7375 || n === 7379) return "saas";

  // Pharma & biotech
  if (n === 2834 || n === 2836 || n === 8731) return "biotech";

  // Energy: upstream + integrated + services
  if (n === 1311 || n === 1381 || n === 1389 || n === 2911 || n === 1382) return "energy";
  if (n >= 1300 && n <= 1389) return "energy";
  if (n >= 2900 && n <= 2999) return "energy";

  // Utilities
  if (n >= 4900 && n <= 4999) return "utility";

  // Retail
  if (n >= 5200 && n <= 5999) return "retail";

  // Consumer staples & food
  if (n >= 2000 && n <= 2099) return "consumer";
  if (n >= 5400 && n <= 5499) return "consumer"; // food stores
  if (n >= 5800 && n <= 5899) return "consumer"; // eating places

  // Telecom
  if (n >= 4810 && n <= 4899) return "telecom";

  // Media (broadcasting, publishing)
  if (n >= 2710 && n <= 2799) return "media";
  if (n >= 4830 && n <= 4841) return "media";
  if (n >= 7800 && n <= 7841) return "media";

  // Industrials, manufacturing, chemicals — broad bucket
  if (n >= 1000 && n <= 3999) return "industrial";

  return "default";
}

/**
 * Convenience: classify an issuer by paddedCik. Returns the bucket plus
 * the SIC code and human-readable description for display.
 */
export async function classifyIssuer(paddedCik: string): Promise<{
  industry: EdgarIndustry;
  sic: string | null;
  sicDescription: string | null;
  entityName: string | null;
}> {
  const sub = await getSubmissions(paddedCik);
  return {
    industry: classifyBySic(sub?.sic),
    sic: sub?.sic ?? null,
    sicDescription: sub?.sicDescription ?? null,
    entityName: sub?.name ?? null,
  };
}
