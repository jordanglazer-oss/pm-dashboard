/**
 * SEC Form 4 (insider transactions) helper.
 *
 * Form 4 is filed within 2 business days of any insider transaction
 * (officer, director, or 10%+ owner buying or selling the issuer's
 * stock). The data is XBRL-tagged via the SEC's "ownership" taxonomy
 * and exposed as XML at predictable URLs.
 *
 * For scoring purposes we care about OPEN-MARKET trades:
 *   - Transaction code "P" (Purchase) — bullish signal
 *   - Transaction code "S" (Sale) — bearish-ish (could be diversification)
 *
 * We DELIBERATELY skip:
 *   - "A" (Award/Grant) — RSU/PSU/option grants from the company on a vesting schedule, not a discretionary buy
 *   - "M" (Exercise) — option exercises where the insider then often sells, not informational on its own
 *   - "F" (Tax withholding) — automatic share sales to cover RSU vest taxes, mechanical
 *   - "G" (Gift) — wealth transfer, not a market signal
 *   - Derivative transactions — option-related activity is signal-poor for sentiment
 *
 * Cached per ticker at `pm:edgar-form4:{TICKER}` for 24 hours. Form 4s
 * land within 2 business days but we don't need real-time — daily cache
 * is plenty for scoring purposes.
 *
 * Returns null cleanly for non-US tickers so callers can fall back to
 * Yahoo (or simply omit insider analysis for Canadian names).
 */

import { getRedis } from "./redis";
import { getCikForTicker } from "./edgar";

const CACHE_TTL_SEC = 24 * 60 * 60; // 24 hours
const SUBMISSIONS_URL = (paddedCik: string) =>
  `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
const FILING_BASE = (cikUnpadded: number, accessionNoDashes: string, primaryDoc: string) =>
  `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${accessionNoDashes}/${primaryDoc}`;

// Window: aggregate the last 90 days of transactions for the summary.
const WINDOW_DAYS = 90;
// Cap: don't fetch more than this many Form 4 XMLs per ticker per refresh
// (insider-heavy issuers like AAPL/JPM file dozens per quarter).
const MAX_FORM4_FETCHES = 50;

// ─── Types ──────────────────────────────────────────────────────────

export type Form4Transaction = {
  /** Insider's full name as filed (e.g., "TIM COOK", "Smith John A"). */
  insider: string;
  /** Insider's relationship: "Officer", "Director", "10% Owner", or comma-separated combo. */
  relationship: string;
  /** Transaction date (YYYY-MM-DD). */
  date: string;
  /** Filing date (YYYY-MM-DD) — when the form was submitted to SEC. */
  filed: string;
  /** "P" = open-market purchase, "S" = open-market sale. */
  code: "P" | "S";
  /** Number of shares transacted. */
  shares: number;
  /** Price per share at execution. */
  pricePerShare: number;
  /** Total dollar value of the transaction (shares × price). */
  totalValue: number;
  /** Shares owned by this insider after this transaction. */
  sharesOwnedAfter: number;
  /** Officer title if known (e.g., "CEO", "CFO"). */
  officerTitle?: string;
};

export type Form4Summary = {
  ticker: string;
  paddedCik: string;
  windowDays: number;
  asOf: string; // ISO timestamp of when this was computed
  transactionCount: number;
  buyCount: number;
  sellCount: number;
  totalBuyValue: number;
  totalSellValue: number;
  netDollarValue: number; // buys - sells
  uniqueBuyers: string[];
  uniqueSellers: string[];
  topBuys: Form4Transaction[]; // up to 5 largest by dollar value
  topSells: Form4Transaction[]; // up to 5 largest by dollar value
  recentTransactions: Form4Transaction[]; // most recent 10 (any direction)
};

// ─── Helpers ────────────────────────────────────────────────────────

function getUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error(
      "SEC_USER_AGENT env var is not set. Required for SEC API calls."
    );
  }
  return ua;
}

async function secFetch(url: string, accept = "application/json"): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": getUserAgent(),
      "Accept": accept,
      "Accept-Encoding": "gzip, deflate",
    },
  });
}

function todayIso(): string {
  return new Date().toISOString();
}

function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

/**
 * Extracts the value of an XML element, handling both `<x>v</x>` and
 * `<x><value>v</value></x>` patterns (Form 4 uses both depending on
 * whether the element wraps a typed scalar). Returns null if not found.
 */
function extractXml(xml: string, tag: string): string | null {
  // Pattern 1: <tag><value>X</value></tag>
  const wrapped = new RegExp(`<${tag}>\\s*<value>\\s*([\\s\\S]*?)\\s*</value>\\s*</${tag}>`, "i");
  const m1 = xml.match(wrapped);
  if (m1) return m1[1].trim();
  // Pattern 2: <tag>X</tag>
  const flat = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  const m2 = xml.match(flat);
  if (m2) return m2[1].trim();
  return null;
}

/**
 * Parse one Form 4 XML document into 0-N transactions. Filters to
 * non-derivative open-market P/S only.
 */
function parseForm4Xml(xml: string, filingDate: string): Form4Transaction[] {
  // Reporting owner identity (shared across all transactions in this filing).
  const ownerSection = xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/);
  if (!ownerSection) return [];
  const ownerXml = ownerSection[0];

  const insider = extractXml(ownerXml, "rptOwnerName") ?? "Unknown";
  const isDirector = extractXml(ownerXml, "isDirector") === "true" || extractXml(ownerXml, "isDirector") === "1";
  const isOfficer = extractXml(ownerXml, "isOfficer") === "true" || extractXml(ownerXml, "isOfficer") === "1";
  const isTenPctOwner = extractXml(ownerXml, "isTenPercentOwner") === "true" || extractXml(ownerXml, "isTenPercentOwner") === "1";
  const isOther = extractXml(ownerXml, "isOther") === "true" || extractXml(ownerXml, "isOther") === "1";
  const officerTitle = extractXml(ownerXml, "officerTitle") ?? undefined;

  const relationships: string[] = [];
  if (isOfficer) relationships.push("Officer");
  if (isDirector) relationships.push("Director");
  if (isTenPctOwner) relationships.push("10% Owner");
  if (isOther) relationships.push("Other");
  const relationship = relationships.join(", ") || "Unknown";

  // Find all <nonDerivativeTransaction> blocks (open-market trades in
  // common stock). We deliberately skip <derivativeTransaction>.
  const txRegex = /<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g;
  const txs: Form4Transaction[] = [];
  for (const match of xml.matchAll(txRegex)) {
    const txXml = match[0];

    const code = extractXml(txXml, "transactionCode");
    if (code !== "P" && code !== "S") continue; // skip awards / exercises / tax / gift

    const dateStr = extractXml(txXml, "transactionDate");
    const sharesStr = extractXml(txXml, "transactionShares");
    const priceStr = extractXml(txXml, "transactionPricePerShare");
    const ownedAfterStr = extractXml(txXml, "sharesOwnedFollowingTransaction");

    if (!dateStr || !sharesStr) continue;
    const shares = parseFloat(sharesStr);
    const pricePerShare = priceStr ? parseFloat(priceStr) : 0;
    const sharesOwnedAfter = ownedAfterStr ? parseFloat(ownedAfterStr) : 0;
    if (!isFinite(shares) || shares <= 0) continue;

    txs.push({
      insider,
      relationship,
      date: dateStr,
      filed: filingDate,
      code,
      shares,
      pricePerShare,
      totalValue: shares * pricePerShare,
      sharesOwnedAfter,
      officerTitle,
    });
  }
  return txs;
}

// ─── Public: get summary ────────────────────────────────────────────

export async function getInsiderActivity(ticker: string): Promise<Form4Summary | null> {
  const upper = ticker.trim().toUpperCase();
  const cikInfo = await getCikForTicker(upper);
  if (!cikInfo) return null;

  // Cache check.
  const cacheKey = `pm:edgar-form4:${upper}`;
  const redis = await getRedis();
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { fetchedAt: string; data: Form4Summary };
      const ageSec = (Date.now() - new Date(parsed.fetchedAt).getTime()) / 1000;
      if (ageSec < CACHE_TTL_SEC) return parsed.data;
    } catch { /* fall through */ }
  }

  // Fetch submissions to find recent Form 4s.
  const subRes = await secFetch(SUBMISSIONS_URL(cikInfo.paddedCik));
  if (!subRes.ok) {
    if (cached) {
      try { return (JSON.parse(cached) as { fetchedAt: string; data: Form4Summary }).data; } catch { /* ignore */ }
    }
    return null;
  }
  const sub = await subRes.json() as {
    filings?: {
      recent?: {
        accessionNumber: string[];
        filingDate: string[];
        form: string[];
        primaryDocument: string[];
      };
    };
  };

  const recent = sub.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return null;

  // Filter to Form 4 / 4/A within the window, capped by MAX_FORM4_FETCHES.
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const candidates: Array<{ accession: string; filed: string; primary: string }> = [];
  for (let i = 0; i < recent.form.length; i++) {
    const f = recent.form[i];
    if (f !== "4" && f !== "4/A") continue;
    const filed = recent.filingDate[i];
    if (filed < cutoffIso) break; // recent[] is newest-first; stop once we pass the window
    candidates.push({
      accession: recent.accessionNumber[i],
      filed,
      primary: recent.primaryDocument[i],
    });
    if (candidates.length >= MAX_FORM4_FETCHES) break;
  }

  if (candidates.length === 0) {
    // Empty summary — still cache so we don't refetch every score.
    const empty: Form4Summary = {
      ticker: upper,
      paddedCik: cikInfo.paddedCik,
      windowDays: WINDOW_DAYS,
      asOf: todayIso(),
      transactionCount: 0,
      buyCount: 0,
      sellCount: 0,
      totalBuyValue: 0,
      totalSellValue: 0,
      netDollarValue: 0,
      uniqueBuyers: [],
      uniqueSellers: [],
      topBuys: [],
      topSells: [],
      recentTransactions: [],
    };
    await redis.set(cacheKey, JSON.stringify({ fetchedAt: todayIso(), data: empty }));
    return empty;
  }

  // Fetch + parse each Form 4 XML in series with small concurrency to
  // stay polite under SEC's 10 req/s limit. We use simple sequential
  // fetches rather than Promise.all because each Form 4 fetch is
  // cheap and the cache layer absorbs the cost across days.
  const allTxs: Form4Transaction[] = [];
  for (const c of candidates) {
    try {
      const accessionNoDashes = c.accession.replace(/-/g, "");
      const url = FILING_BASE(cikInfo.cik, accessionNoDashes, c.primary);
      const res = await secFetch(url, "application/xml");
      if (!res.ok) continue;
      const xml = await res.text();
      const txs = parseForm4Xml(xml, c.filed);
      allTxs.push(...txs);
    } catch (err) {
      console.error(`[Form 4] parse failed for ${c.accession}:`, err);
    }
  }

  // Aggregate.
  const buys = allTxs.filter((t) => t.code === "P");
  const sells = allTxs.filter((t) => t.code === "S");
  const totalBuyValue = buys.reduce((s, t) => s + t.totalValue, 0);
  const totalSellValue = sells.reduce((s, t) => s + t.totalValue, 0);
  const uniqueBuyers = Array.from(new Set(buys.map((t) => t.insider))).sort();
  const uniqueSellers = Array.from(new Set(sells.map((t) => t.insider))).sort();

  const topBuys = [...buys].sort((a, b) => b.totalValue - a.totalValue).slice(0, 5);
  const topSells = [...sells].sort((a, b) => b.totalValue - a.totalValue).slice(0, 5);
  const recentTransactions = [...allTxs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

  const summary: Form4Summary = {
    ticker: upper,
    paddedCik: cikInfo.paddedCik,
    windowDays: WINDOW_DAYS,
    asOf: todayIso(),
    transactionCount: allTxs.length,
    buyCount: buys.length,
    sellCount: sells.length,
    totalBuyValue,
    totalSellValue,
    netDollarValue: totalBuyValue - totalSellValue,
    uniqueBuyers,
    uniqueSellers,
    topBuys,
    topSells,
    recentTransactions,
  };

  await redis.set(cacheKey, JSON.stringify({ fetchedAt: todayIso(), data: summary }));
  return summary;

  // Suppress unused-import warning during build if daysBetween isn't
  // referenced. Keep it exported for future use (e.g., velocity calcs
  // in Stage 4: "X buys in last 30d vs prior 60d").
  void daysBetween;
}
