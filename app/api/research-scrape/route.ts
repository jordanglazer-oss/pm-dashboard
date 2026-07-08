import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import { toCanadianYahooTicker } from "@/app/lib/rbc-canonical";

/**
 * Generic research-screenshot scraper for the four sources beyond
 * Newton's Upticks (which has its own dedicated route at
 * /api/upticks-scrape, kept separate to preserve the existing
 * support/resistance schema).
 *
 * Sources handled here:
 *   - "fundstrat-top"     → Fundstrat Top Ideas → IdeaEntry[]
 *   - "fundstrat-bottom"  → Fundstrat Bottom Ideas → IdeaEntry[]
 *   - "rbc-focus"         → RBC Canadian Focus List → RBCEntry[]
 *   - "seeking-alpha-picks"       → Seeking Alpha Alpha Picks → IdeaEntry[]
 *
 * Cache pattern (mirrors upticks-scrape):
 *   1. Client POSTs current screenshot(s) for ONE source.
 *   2. We fingerprint the images (MD5 over the tail of each dataUrl).
 *   3. If the fingerprint matches what's cached at
 *      pm:research-scrape-cache:{source} → return cached entries
 *      WITHOUT calling Anthropic. Refresh of unchanged image = $0.
 *   4. If the fingerprint differs (or force=true) → run vision, parse
 *      rows, cache, return.
 *
 * Each source has its own cache key so a refresh on one source doesn't
 * invalidate the others. The route is read-only with respect to
 * pm:research — the client merges the returned entries into the
 * appropriate state field and persists via /api/kv/research.
 */

const CACHE_KEY_PREFIX = "pm:research-scrape-cache";
const client = new Anthropic();

type AttachmentInput = { id: string; label: string; dataUrl: string };

export type SourceKey = "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "jpm-us-analyst-focus" | "rbc-equate-cad" | "rbc-equate-usd" | "seeking-alpha-picks" | "rbccm-few";

export type ResearchAttachmentInput = AttachmentInput;

const VALID_SOURCES: readonly SourceKey[] = [
  "fundstrat-top",
  "fundstrat-bottom",
  "fundstrat-smid-top",
  "fundstrat-smid-bottom",
  "rbc-focus",
  "rbc-us-focus",
  "jpm-us-analyst-focus",
  "rbc-equate-cad",
  "rbc-equate-usd",
  "seeking-alpha-picks",
  "rbccm-few",
] as const;

// ── Source-specific output shapes ──────────────────────────────────

/** Idea-style row: ticker + entry price. Used by Fundstrat large-cap +
 *  SMID-cap top/bottom lists. */
export type ScrapedIdea = {
  ticker: string;
  priceWhenAdded?: number;
};

/** Seeking Alpha Alpha Picks row — richer than IdeaEntry because the
 *  SA dashboard exposes name, sector, picked date, return %, rating
 *  badge, and per-pick portfolio weight. The ticker may be Canadian
 *  (with -T) when the model resolved a Canadian-HQ'd company to its
 *  TSX listing. */
export type ScrapedAlphaPick = {
  ticker: string;
  name?: string;
  sector?: string;
  dateAdded?: string;
  returnSinceAdded?: number;
  rating?: string;
  holdingWeight?: number;
};

/** RBC Canadian Focus List row: includes sector and target weight. */
export type ScrapedRbcRow = {
  ticker: string;
  sector?: string;
  weight?: number;
  dateAdded?: string;
  // JPM US Analyst Focus List extras (the JPM card shows these instead of
  // sector/weight): company name, industry, strategy designation, price target.
  name?: string;
  industry?: string;
  strategy?: string;
  priceTarget?: number;
};

/** RBCCM Canadian FEW Portfolio row: ticker (canonicalized to .TO),
 *  company name, industry, and stock price. */
export type ScrapedFewRow = {
  ticker: string;
  name?: string;
  industry?: string;
  price?: number;
};

type CachedScrape = {
  hash: string;
  entries: ScrapedIdea[] | ScrapedRbcRow[] | ScrapedAlphaPick[] | ScrapedFewRow[];
  analyzedAt: string;
};

// ── Hashing + caching ──────────────────────────────────────────────

function hashAttachments(atts: AttachmentInput[]): string {
  if (!atts || atts.length === 0) return "none";
  const ids = atts.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

async function getCached(source: SourceKey, hash: string): Promise<CachedScrape["entries"] | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(`${CACHE_KEY_PREFIX}:${source}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedScrape;
    return cached.hash === hash ? cached.entries : null;
  } catch {
    return null;
  }
}

async function saveCached(source: SourceKey, hash: string, entries: CachedScrape["entries"]) {
  try {
    const redis = await getRedis();
    const payload: CachedScrape = {
      hash,
      entries,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(`${CACHE_KEY_PREFIX}:${source}`, JSON.stringify(payload));
  } catch (e) {
    console.error(`[research-scrape:${source}] cache write failed:`, e);
  }
}

// ── Image block builder (same as upticks-scrape) ───────────────────

function buildImageBlocks(atts: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const att of atts) {
    // PDF first — Anthropic accepts PDFs via the `document` block type.
    const pdfMatch = att.dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
    if (pdfMatch) {
      const data = pdfMatch[1].replace(/\s/g, "");
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      });
      blocks.push({ type: "text", text: `(PDF: ${att.label})` });
      continue;
    }
    const match = att.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) continue;
    const rawMediaType = match[1];
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    const mediaType = (allowed as readonly string[]).includes(rawMediaType)
      ? (rawMediaType as (typeof allowed)[number])
      : "image/png";
    const data = match[2].replace(/\s/g, "");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
    blocks.push({ type: "text", text: `(Image: ${att.label})` });
  }
  return blocks;
}

// ── Source-specific prompts ────────────────────────────────────────

function promptFor(source: SourceKey): string {
  const common = `Respond with ONLY a JSON array — no prose, no markdown fences.
If you genuinely cannot read the screenshot, respond with: []
Tickers should be uppercase. For dual-class shares written with a slash (e.g. "BRK/B"), convert to dash form ("BRK-B"). Strip leading "$" symbols.
The current year is 2026; dates without a year should assume 2026 if ambiguous.`;

  if (source === "fundstrat-top") {
    return `You are reading a Fundstrat "Top Ideas" stock screen screenshot. It is a TABLE of buy-side stock recommendations. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required)
  - Price Added / Entry Price / Price at Add → \`priceWhenAdded\` (NUMBER, strip $ and commas)

If the price column isn't present, omit \`priceWhenAdded\`. Do NOT invent prices.

${common}

Example: [{"ticker":"NVDA","priceWhenAdded":132.10},{"ticker":"META","priceWhenAdded":520.00}]`;
  }

  if (source === "fundstrat-bottom") {
    return `You are reading a Fundstrat "Large-Cap Bottom Ideas" stock screen screenshot. It is a TABLE of sell-side / underperform stock recommendations on large-cap names. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required)
  - Price Added / Entry Price → \`priceWhenAdded\` (NUMBER, strip $ and commas)

If the price column isn't present, omit \`priceWhenAdded\`.

${common}

Example: [{"ticker":"INTC","priceWhenAdded":24.50},{"ticker":"BA","priceWhenAdded":195.00}]`;
  }

  if (source === "fundstrat-smid-top") {
    return `You are reading a Fundstrat "Top SMID-Cap Core Ideas" stock screen screenshot. It is a TABLE of buy-side recommendations on small / mid-cap (SMID-cap) names. Same column layout as the large-cap top ideas list. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required)
  - Price Added / Entry Price / Price at Add → \`priceWhenAdded\` (NUMBER, strip $ and commas)

If the price column isn't present, omit \`priceWhenAdded\`.

${common}

Example: [{"ticker":"AXON","priceWhenAdded":612.40},{"ticker":"CELH","priceWhenAdded":48.20}]`;
  }

  if (source === "fundstrat-smid-bottom") {
    return `You are reading a Fundstrat "Bottom SMID-Cap Core Ideas" stock screen screenshot. It is a TABLE of sell-side / underperform recommendations on small / mid-cap (SMID-cap) names. Same column layout as the large-cap bottom ideas list. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required)
  - Price Added / Entry Price → \`priceWhenAdded\` (NUMBER, strip $ and commas)

If the price column isn't present, omit \`priceWhenAdded\`.

${common}

Example: [{"ticker":"GME","priceWhenAdded":18.40},{"ticker":"AMC","priceWhenAdded":4.85}]`;
  }

  if (source === "rbc-focus") {
    return `You are reading the "RBC Canadian Focus List" screenshot. It is a TABLE of Canadian equity buy recommendations from RBC Capital Markets, with each name carrying a target portfolio weight. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). RBC reports use "-T" suffixes (e.g. "RY-T"); CONVERT these to Yahoo Finance "${"."}TO" form (e.g. "RY.TO", "CNR.TO", "BMO.TO") because that's the canonical convention used by the rest of the app for Canadian listings. If a row is already in ".TO" form leave it as-is. If it has no suffix at all, append ".TO" (it's the Canadian Focus List, every row is a TSX listing).
  - Sector → \`sector\` (string, the GICS or RBC sector label)
  - Weight / Target Weight / Portfolio Weight → \`weight\` (NUMBER as a percentage, e.g. 5.0 for "5.0%". Strip % sign and commas.)
  - Date Added / Date → \`dateAdded\` (string, e.g. "4/15/2026")

If a column is missing or blank, OMIT that key (do not return null or empty string).

${common}

Example: [{"ticker":"RY.TO","sector":"Financials","weight":5.5,"dateAdded":"3/12/2026"},{"ticker":"CNR.TO","sector":"Industrials","weight":4.0,"dateAdded":"1/8/2026"}]`;
  }

  if (source === "rbc-us-focus") {
    return `You are reading the "RBC US Focus List" screenshot. It is a TABLE of US equity buy recommendations from RBC Capital Markets, with each name carrying a target portfolio weight. Extract every row.

Columns to look for:
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). US listings — DO NOT add a "-T" suffix. Tickers should be bare (e.g. "AAPL", "MSFT", "JPM"). For dual-class shares written with "/" (e.g. "BRK/B"), convert to dash form ("BRK-B").
  - Sector → \`sector\` (string, the GICS or RBC sector label)
  - Weight / Target Weight / Portfolio Weight → \`weight\` (NUMBER as a percentage, e.g. 5.0 for "5.0%". Strip % sign and commas.)
  - Date Added / Date → \`dateAdded\` (string, e.g. "4/15/2026")

If a column is missing or blank, OMIT that key (do not return null or empty string).

${common}

Example: [{"ticker":"MSFT","sector":"Technology","weight":5.0,"dateAdded":"3/12/2026"},{"ticker":"JPM","sector":"Financials","weight":4.0,"dateAdded":"1/8/2026"}]`;
  }

  if (source === "jpm-us-analyst-focus") {
    return `You are reading the "J.P. Morgan US Equity Analyst Focus List" screenshot — a LIST of US equities that J.P. Morgan analysts have flagged as focus ideas. Extract EVERY row.

Columns to look for:
  - Company / Name → \`name\` (string, the company name as shown)
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). US listings — bare tickers, NO "-T" suffix (e.g. "AAPL", "MSFT", "JPM"). Dual-class shares written with "/" (e.g. "BRK/B") → dash form ("BRK-B").
  - Industry / Sub-Industry / Sector → \`industry\` (string, the industry label as shown — pass through verbatim)
  - Strategy / Category / Type / List → \`strategy\` (string, JPM's designation for the name, e.g. "Growth", "Value", "Income", "GARP", "Long", "Short" — whatever the strategy/category column shows)
  - Price Target / Target / PT → \`priceTarget\` (NUMBER, strip $ and commas; the analyst target price)

Do NOT extract the current/last price — that is fetched live from FactSet, not the screenshot.
If a column is missing or blank for a row, OMIT that key (do not return null or empty string). Do NOT invent values.

${common}

Example: [{"name":"NVIDIA Corp","ticker":"NVDA","industry":"Semiconductors","strategy":"Growth","priceTarget":210},{"name":"JPMorgan Chase","ticker":"JPM","industry":"Banks","strategy":"Value","priceTarget":320}]`;
  }

  if (source === "rbc-equate-cad") {
    return `You are reading an "RBC Equate" model-portfolio report (PDF or screenshot). This document contains MULTIPLE lists/model portfolios. Extract ONLY the holdings of the "Canada Large Cap CORE 40 Model Portfolio" — IGNORE every other list, table, or model portfolio in the document (e.g. US portfolios, income/dividend models, sector sleeves, benchmark tables). If you cannot clearly identify the "Canada Large Cap CORE 40 Model Portfolio" section, return [].

From the Canada Large Cap CORE 40 Model Portfolio ONLY, extract every constituent:
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). These are Canadian (TSX) listings. RBC may show "-T" suffixes or no suffix; CONVERT every ticker to Yahoo "${"."}TO" form (e.g. "RY-T" → "RY.TO", "CNR" → "CNR.TO"). If already ".TO", keep it. For dual-class shares written with "/" (e.g. "BBD/B"), convert the slash to a dash before adding the suffix ("BBD-B.TO").
  - Company / Name → \`name\` (string, the company name as shown)
  - Industry / Sub-Industry / Sector → \`industry\` (string, the industry label as shown — pass through verbatim)

Do NOT extract weight or the current/last price — the price is fetched live from FactSet, not the document. If a column is missing or blank, OMIT that key.

${common}

Example: [{"ticker":"RY.TO","name":"Royal Bank of Canada","industry":"Banks"},{"ticker":"CNR.TO","name":"Canadian National Railway","industry":"Road & Rail"}]`;
  }

  if (source === "rbc-equate-usd") {
    return `You are reading an "RBC Equate" model-portfolio report (PDF or screenshot). This document contains MULTIPLE lists/model portfolios. Extract ONLY the holdings of the "U.S. All Cap CORE 40 Model Portfolio" — IGNORE every other list, table, or model portfolio in the document (e.g. Canadian portfolios, income/dividend models, sector sleeves, benchmark tables). If you cannot clearly identify the "U.S. All Cap CORE 40 Model Portfolio" section, return [].

From the U.S. All Cap CORE 40 Model Portfolio ONLY, extract every constituent:
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). US listings — bare tickers, NO "-T" or ".TO" suffix (e.g. "AAPL", "MSFT", "JPM"). Dual-class shares written with "/" (e.g. "BRK/B") → dash form ("BRK-B").
  - Company / Name → \`name\` (string, the company name as shown)
  - Industry / Sub-Industry / Sector → \`industry\` (string, the industry label as shown — pass through verbatim)

Do NOT extract weight or the current/last price — the price is fetched live from FactSet, not the document. If a column is missing or blank, OMIT that key.

${common}

Example: [{"ticker":"AAPL","name":"Apple Inc","industry":"Technology Hardware"},{"ticker":"BRK-B","name":"Berkshire Hathaway","industry":"Insurance"}]`;
  }

  if (source === "rbccm-few") {
    return `You are reading the "RBCCM Canadian Fundamental Equity Weighting (FEW) Portfolio" screenshot. It is a TABLE of Canadian equities. Extract EVERY row.

Columns to look for (extract ONLY these four — ignore any other columns):
  - Ticker / Symbol → \`ticker\` (string, required, UPPERCASE). The screenshot generally shows the ticker WITHOUT a suffix (e.g. "RY", "CNR", "BMO"). Because this is a Canadian (TSX) list, append ".TO" to every ticker so it resolves on Yahoo Finance (e.g. "RY" → "RY.TO", "CNR" → "CNR.TO"). If a row already shows "-T" or ".TO", keep the ".TO" form. For dual-class shares written with "/" (e.g. "BBD/B"), convert the slash to a dash BEFORE adding the suffix ("BBD-B.TO").
  - Company / Name → \`name\` (string, the company name as shown)
  - Industry / Sector → \`industry\` (string, the industry label as shown — pass through verbatim)
  - Price / Stock Price / Last → \`price\` (NUMBER, strip $ and commas)

If a column is missing or blank for a row, OMIT that key (do not return null or empty string). Do NOT invent prices.

${common}

Example: [{"ticker":"RY.TO","name":"Royal Bank of Canada","industry":"Banks","price":178.42},{"ticker":"CNR.TO","name":"Canadian National Railway","industry":"Road & Rail","price":154.10}]`;
  }

  // seeking-alpha-picks
  return `You are reading a "Seeking Alpha — Alpha Picks" dashboard screenshot. It is a TABLE of buy recommendations from Seeking Alpha's institutional Alpha Picks service. Extract every active pick. Columns typically include: Company, Symbol, Picked (date), Return (%), Sector, Rating, Holding %.

For EACH active pick, extract these fields:
  - \`ticker\` (string, required) — see CANADIAN MAPPING rule below.
  - \`name\` (string) — full company name from the Company column.
  - \`sector\` (string) — sector label from the Sector column. Pass through verbatim; the app normalizes to GICS form via Yahoo afterward.
  - \`dateAdded\` (string) — the Picked column date, e.g. "10/15/2024" → return as "10/15/2024" (don't reformat).
  - \`returnSinceAdded\` (NUMBER, signed percent) — the Return column. "+510.57%" → 510.57; "-11.18%" → -11.18; strip the % and any commas.
  - \`rating\` (string) — the Rating column. Use the EXACT label from the badge: "Strong Buy", "Buy", "Hold", "Sell", "Strong Sell". Use Title Case as shown.
  - \`holdingWeight\` (NUMBER, percent) — the Holding % column, e.g. "5.60%" → 5.60. Strip the % sign. If absent, omit the field.

CANADIAN MAPPING — when the company is HEADQUARTERED IN CANADA and has a TSX listing, use the TSX ticker form with a "-T" suffix instead of the US listing the screenshot shows. Use your knowledge of public companies. Examples:
  - "Celestica, Inc." → "CLS-T" (NOT "CLS")
  - "Constellation Software" → "CSU-T"
  - "Brookfield Corporation" → "BN-T"
  - "Brookfield Asset Management" → "BAM-T"
  - "Shopify" → "SHOP-T"
  - "Magna International" → "MG-T"
  - "Royal Bank of Canada" → "RY-T"
  - "TD Bank" → "TD-T"
  - "Nutrien" → "NTR-T"
  - "Suncor" → "SU-T"
  - "Canadian National Railway" → "CNR-T"
  - "BCE Inc" → "BCE-T"
  - "Open Text" → "OTEX-T"
  - "Manulife" → "MFC-T"
  - "Sun Life Financial" → "SLF-T"
  - "Barrick Mining" / "Barrick Gold" → "ABX-T" (NOT "B" or "GOLD" — they renamed from GOLD to B in the US, but the Canadian listing is ABX-T)
  - "Kinross Gold" → "K-T" (NOT "KGC")
  - "SSR Mining" → "SSRM-T" (ticker is SSRM on both NASDAQ and TSX, append -T for the TSX listing)
  - "Wheaton Precious Metals" → "WPM-T"
  - "Franco-Nevada" → "FNV-T"
  - "Agnico Eagle" → "AEM-T"
  - "First Quantum Minerals" → "FM-T"
  - "Teck Resources" → "TECK-B-T"
  - "Cameco" → "CCO-T"
  - "Lundin Mining" → "LUN-T"
  - "Canadian Natural Resources" → "CNQ-T"
  - "Cenovus Energy" → "CVE-T"
  - "Enbridge" → "ENB-T"
  - "TC Energy" → "TRP-T"
  - "Bank of Montreal" → "BMO-T"
  - "Bank of Nova Scotia" → "BNS-T"
  - "CIBC" → "CM-T"

CROSS-LISTING RULE — for the same underlying company in the screenshot, emit ONE row per (ticker, date) combination. If a Canadian-HQ company appears in the screenshot under its US ticker, replace it with the -T form per the mapping above. DO NOT emit two rows for the same company on the same date.

TICKER ACCURACY — if you are NOT 100% sure of a Canadian-HQ company's correct TSX ticker, emit the ticker AS SHOWN in the screenshot rather than guessing. Do NOT invent ticker renames or assume a company changed symbols. The mapping list above is the authoritative source; if a company isn't on it and the screenshot shows a US ticker, keep that US ticker.

DUPLICATE ROWS ARE OK — the screenshot may legitimately show the same company appearing twice on different dates (a position was sold and later re-bought, or added to over time). If a ticker appears in the table with two different "Picked" dates, emit BOTH rows. Each (ticker, dateAdded) pair is a unique pick.

For US companies (HQ in the United States) and non-Canadian foreign companies (e.g. Argentinian, European), keep the US ticker as shown — DO NOT add -T. For dual-class shares written with "/" like "BRK/B", convert to dash form ("BRK-B").

Skip closed/exited picks if the screenshot shows them — only include currently-active recommendations.

${common}

Example output:
[
  {"ticker":"AMZN","name":"Amazon.com, Inc.","sector":"Consumer Discretionary","dateAdded":"11/15/2023","returnSinceAdded":78.4,"rating":"Strong Buy","holdingWeight":5.41},
  {"ticker":"CLS-T","name":"Celestica, Inc.","sector":"Information Technology","dateAdded":"10/16/2023","returnSinceAdded":1439.89,"rating":"Strong Buy","holdingWeight":5.99},
  {"ticker":"BRK-B","name":"Berkshire Hathaway Inc.","sector":"Financials","dateAdded":"7/1/2024","returnSinceAdded":14.4,"rating":"Hold","holdingWeight":1.80}
]`;
}

// ── Parsers ────────────────────────────────────────────────────────

function parseIdeaRows(text: string): ScrapedIdea[] {
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => {
        const ticker = String(r.ticker).trim().toUpperCase().replace(/^\$+/, "").replace(/\//g, "-");
        const out: ScrapedIdea = { ticker };
        if (r.priceWhenAdded != null) {
          const n = Number(String(r.priceWhenAdded).replace(/[$,]/g, ""));
          if (Number.isFinite(n)) out.priceWhenAdded = n;
        }
        return out;
      });
  } catch {
    return [];
  }
}

// Canadian ticker canonicalization is shared with the frontend (which
// runs the same dedupe on load). Single source of truth lives in
// app/lib/rbc-canonical.ts. Removed the inline duplicate.

/** Parse Seeking Alpha Alpha Picks JSON output. Captures the richer
 *  per-pick fields (name, sector, dateAdded, returnSinceAdded, rating)
 *  in addition to the ticker. */
function parseAlphaPickRows(text: string): ScrapedAlphaPick[] {
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => {
        const ticker = String(r.ticker).trim().toUpperCase().replace(/^\$+/, "").replace(/\//g, "-");
        const out: ScrapedAlphaPick = { ticker };
        if (r.name && String(r.name).trim()) out.name = String(r.name).trim();
        if (r.sector && String(r.sector).trim()) out.sector = String(r.sector).trim();
        if (r.dateAdded && String(r.dateAdded).trim()) out.dateAdded = String(r.dateAdded).trim();
        if (r.returnSinceAdded != null) {
          const n = Number(String(r.returnSinceAdded).replace(/[%,+]/g, ""));
          if (Number.isFinite(n)) out.returnSinceAdded = n;
        }
        if (r.rating && String(r.rating).trim()) out.rating = String(r.rating).trim();
        if (r.holdingWeight != null) {
          const n = Number(String(r.holdingWeight).replace(/[%,+]/g, ""));
          if (Number.isFinite(n) && n > 0) out.holdingWeight = n;
        }
        return out;
      });
  } catch {
    return [];
  }
}

function parseRbcRows(text: string, source: SourceKey): ScrapedRbcRow[] {
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => {
        let ticker = String(r.ticker).trim().toUpperCase().replace(/^\$+/, "").replace(/\//g, "-");
        // Canonicalize Canadian lists to .TO so Yahoo lookups succeed.
        if (source === "rbc-focus" || source === "rbc-equate-cad") ticker = toCanadianYahooTicker(ticker);
        const out: ScrapedRbcRow = { ticker };
        if (r.sector != null && String(r.sector).trim()) out.sector = String(r.sector).trim();
        if (r.weight != null) {
          const n = Number(String(r.weight).replace(/[%,]/g, ""));
          if (Number.isFinite(n)) out.weight = n;
        }
        if (r.dateAdded != null && String(r.dateAdded).trim()) out.dateAdded = String(r.dateAdded).trim();
        // JPM-specific columns (company name / industry / strategy / price target).
        if (r.name != null && String(r.name).trim()) out.name = String(r.name).trim();
        if (r.industry != null && String(r.industry).trim()) out.industry = String(r.industry).trim();
        if (r.strategy != null && String(r.strategy).trim()) out.strategy = String(r.strategy).trim();
        if (r.priceTarget != null) {
          const n = Number(String(r.priceTarget).replace(/[$,]/g, ""));
          if (Number.isFinite(n) && n > 0) out.priceTarget = n;
        }
        return out;
      });
  } catch {
    return [];
  }
}

/** Parse RBCCM Canadian FEW rows. Canonicalizes every ticker to .TO
 *  (the screenshot omits the suffix; it's an all-TSX list). */
function parseFewRows(text: string): ScrapedFewRow[] {
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => {
        let ticker = String(r.ticker).trim().toUpperCase().replace(/^\$+/, "").replace(/\//g, "-");
        // Force every row to the Canadian Yahoo (.TO) convention.
        ticker = toCanadianYahooTicker(ticker);
        const out: ScrapedFewRow = { ticker };
        if (r.name != null && String(r.name).trim()) out.name = String(r.name).trim();
        if (r.industry != null && String(r.industry).trim()) out.industry = String(r.industry).trim();
        if (r.price != null) {
          const n = Number(String(r.price).replace(/[$,]/g, ""));
          if (Number.isFinite(n) && n > 0) out.price = n;
        }
        return out;
      });
  } catch {
    return [];
  }
}

// ── Vision call ────────────────────────────────────────────────────

async function runVision(source: SourceKey, atts: AttachmentInput[]): Promise<{ entries: CachedScrape["entries"]; rawText: string }> {
  const imageBlocks = buildImageBlocks(atts);
  if (imageBlocks.length === 0) return { entries: [], rawText: "" };

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptFor(source) },
          ...imageBlocks,
        ],
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log(`[research-scrape:${source}] raw vision output:`, text.slice(0, 4000));

  const entries =
    (source === "rbc-focus" || source === "rbc-us-focus" || source === "jpm-us-analyst-focus" || source === "rbc-equate-cad" || source === "rbc-equate-usd") ? parseRbcRows(text, source)
  : source === "seeking-alpha-picks" ? parseAlphaPickRows(text)
  : source === "rbccm-few" ? parseFewRows(text)
  : parseIdeaRows(text);
  return { entries, rawText: text };
}

// ── Route handler ──────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sourceRaw = String(body?.source ?? "").trim() as SourceKey;
    if (!VALID_SOURCES.includes(sourceRaw)) {
      return NextResponse.json(
        { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}` },
        { status: 400 }
      );
    }
    const source = sourceRaw;

    const attachments: AttachmentInput[] = Array.isArray(body?.attachments) ? body.attachments : [];
    const force = Boolean(body?.force);

    if (attachments.length === 0) {
      return NextResponse.json({ source, entries: [], cached: false, reason: "no-attachments" });
    }

    const hash = hashAttachments(attachments);

    // Cache hit → zero Anthropic tokens spent.
    if (!force) {
      const cached = await getCached(source, hash);
      if (cached) {
        return NextResponse.json({ source, entries: cached, cached: true, hash });
      }
    }

    const { entries, rawText } = await runVision(source, attachments);
    await saveCached(source, hash, entries);
    return NextResponse.json({ source, entries, cached: false, hash, rawText });
  } catch (e) {
    console.error("research-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape research screenshot" }, { status: 500 });
  }
}

/**
 * Server-callable wrapper around the same extraction the POST handler uses.
 * Used by the email-inbox dispatcher (app/lib/inbox-dispatch.ts) so emailed
 * research screenshots/PDFs go through the exact same vision + caching path
 * as the manual UI. Honors the same per-source cache key
 * (pm:research-scrape-cache:<source>), so re-uploading an unchanged image
 * costs zero Anthropic tokens.
 *
 * Returns { entries, cached, hash, rawText? } shaped identically to the
 * POST response, minus the `source` echo (caller already knows it).
 */
export async function extractResearchEntries(
  source: SourceKey,
  attachments: ResearchAttachmentInput[],
  opts: { force?: boolean } = {},
): Promise<{ entries: CachedScrape["entries"]; cached: boolean; hash: string; rawText?: string }> {
  if (attachments.length === 0) return { entries: [], cached: false, hash: "none" };
  const hash = hashAttachments(attachments);
  if (!opts.force) {
    const cached = await getCached(source, hash);
    if (cached) return { entries: cached, cached: true, hash };
  }
  const { entries, rawText } = await runVision(source, attachments);
  await saveCached(source, hash, entries);
  return { entries, cached: false, hash, rawText };
}
