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

type SourceKey = "fundstrat-top" | "fundstrat-bottom" | "fundstrat-smid-top" | "fundstrat-smid-bottom" | "rbc-focus" | "rbc-us-focus" | "seeking-alpha-picks";

const VALID_SOURCES: readonly SourceKey[] = [
  "fundstrat-top",
  "fundstrat-bottom",
  "fundstrat-smid-top",
  "fundstrat-smid-bottom",
  "rbc-focus",
  "rbc-us-focus",
  "seeking-alpha-picks",
] as const;

// ── Source-specific output shapes ──────────────────────────────────

/** Idea-style row: ticker + entry price. Used by Fundstrat large-cap +
 *  SMID-cap top/bottom lists. */
export type ScrapedIdea = {
  ticker: string;
  priceWhenAdded?: number;
};

/** Seeking Alpha Alpha Picks row — richer than IdeaEntry because the
 *  SA dashboard exposes name, sector, picked date, return %, and a
 *  rating badge per pick. The ticker may be Canadian (with -T) when
 *  the model resolved a Canadian-HQ'd company to its TSX listing. */
export type ScrapedAlphaPick = {
  ticker: string;
  name?: string;
  sector?: string;
  dateAdded?: string;
  returnSinceAdded?: number;
  rating?: string;
};

/** RBC Canadian Focus List row: includes sector and target weight. */
export type ScrapedRbcRow = {
  ticker: string;
  sector?: string;
  weight?: number;
  dateAdded?: string;
};

type CachedScrape = {
  hash: string;
  entries: ScrapedIdea[] | ScrapedRbcRow[] | ScrapedAlphaPick[];
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

  // seeking-alpha-picks
  return `You are reading a "Seeking Alpha — Alpha Picks" dashboard screenshot. It is a TABLE of buy recommendations from Seeking Alpha's institutional Alpha Picks service. Extract every active pick. Columns typically include: Company, Symbol, Picked (date), Return (%), Sector, Rating, Holding %.

For EACH active pick, extract these fields:
  - \`ticker\` (string, required) — see CANADIAN MAPPING rule below.
  - \`name\` (string) — full company name from the Company column.
  - \`sector\` (string) — sector label from the Sector column. Pass through verbatim; the app normalizes to GICS form via Yahoo afterward.
  - \`dateAdded\` (string) — the Picked column date, e.g. "10/15/2024" → return as "10/15/2024" (don't reformat).
  - \`returnSinceAdded\` (NUMBER, signed percent) — the Return column. "+510.57%" → 510.57; "-11.18%" → -11.18; strip the % and any commas.
  - \`rating\` (string) — the Rating column. Use the EXACT label from the badge: "Strong Buy", "Buy", "Hold", "Sell", "Strong Sell". Use Title Case as shown.

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

For US companies (HQ in the United States) and non-Canadian foreign companies (e.g. Argentinian, European), keep the US ticker as shown — DO NOT add -T. For dual-class shares written with "/" like "BRK/B", convert to dash form ("BRK-B").

Skip closed/exited picks if the screenshot shows them — only include currently-active recommendations.

${common}

Example output:
[
  {"ticker":"AMZN","name":"Amazon.com, Inc.","sector":"Consumer Discretionary","dateAdded":"11/15/2023","returnSinceAdded":78.4,"rating":"Strong Buy"},
  {"ticker":"CLS-T","name":"Celestica, Inc.","sector":"Information Technology","dateAdded":"10/16/2023","returnSinceAdded":1439.89,"rating":"Strong Buy"},
  {"ticker":"BRK-B","name":"Berkshire Hathaway Inc.","sector":"Financials","dateAdded":"7/1/2024","returnSinceAdded":14.4,"rating":"Hold"}
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
        // Canonicalize Canadian list to .TO so Yahoo lookups succeed.
        if (source === "rbc-focus") ticker = toCanadianYahooTicker(ticker);
        const out: ScrapedRbcRow = { ticker };
        if (r.sector != null && String(r.sector).trim()) out.sector = String(r.sector).trim();
        if (r.weight != null) {
          const n = Number(String(r.weight).replace(/[%,]/g, ""));
          if (Number.isFinite(n)) out.weight = n;
        }
        if (r.dateAdded != null && String(r.dateAdded).trim()) out.dateAdded = String(r.dateAdded).trim();
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
    (source === "rbc-focus" || source === "rbc-us-focus") ? parseRbcRows(text, source)
  : source === "seeking-alpha-picks" ? parseAlphaPickRows(text)
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
