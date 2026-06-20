/**
 * Server-callable wrappers for the SIA + BoostedAI screenshot vision calls.
 *
 * The /api/sia-scrape and /api/boosted-ai-scrape routes are thin handlers
 * over these functions; the inbox-email webhook also imports them so an
 * email-attached screenshot follows the EXACT same vision + parsing path
 * as a manual upload.
 *
 * Hash-gated by image fingerprint — re-running an unchanged screenshot
 * costs zero Anthropic tokens.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { getRedis } from "./redis";
import type { BoostedAiConsensus } from "./external-scoring";

const client = new Anthropic();

const SIA_CACHE_KEY = "pm:sia-scrape-cache";
const BOOSTED_CACHE_KEY = "pm:boosted-ai-scrape-cache";

export type AttachmentInput = { id: string; label: string; dataUrl: string };

export type ScrapedSia = {
  ticker: string;
  smax?: number; // 0..10 integer
};

export type ScrapedBoosted = {
  ticker: string;
  rating?: number; // 0..5 decimal
  consensus?: BoostedAiConsensus;
};

type CachedScrape<T> = {
  hash: string;
  entries: T[];
  analyzedAt: string;
};

// ── Shared image-block builder ──────────────────────────────────────

export function hashAttachments(atts: AttachmentInput[]): string {
  if (!atts || atts.length === 0) return "none";
  const ids = atts.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

export function buildImageBlocks(atts: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const att of atts) {
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
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    });
    blocks.push({ type: "text", text: `(Image: ${att.label})` });
  }
  return blocks;
}

// ── SIA ─────────────────────────────────────────────────────────────

function parseSiaRows(text: string): ScrapedSia[] {
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
        const ticker = String(r.ticker).trim().toUpperCase().replace(/\//g, "-").replace(/^\$+/, "");
        const out: ScrapedSia = { ticker };
        if (r.smax != null) {
          const n = Number(String(r.smax).replace(/[^0-9.\-]/g, ""));
          if (Number.isFinite(n)) {
            out.smax = Math.max(0, Math.min(10, Math.round(n)));
          }
        }
        return out;
      });
  } catch {
    return [];
  }
}

const SIA_PROMPT = `You are reading a SIACharts watchlist screenshot. It is a TABLE of stocks with a SIA SMAX score for each.

Extract every visible row and return ONLY:
  - ticker (string, UPPERCASE, required) — the stock's ticker symbol. Strip any leading "$". Convert slash class notation to dash ("BRK/B" → "BRK-B"). For Canadian listings shown with ".TO" or "-T", PRESERVE the suffix as shown.
  - smax (integer 0-10) — the SMAX score column. Look for a column labeled "SMAX", "Smax", "S-MAX", or just a 0-10 integer per row.

CRITICAL rules:
  - Extract EVERY ticker row you can see, even if the SMAX column is blank or unreadable for some rows.
  - If the SMAX value is unreadable, missing, or you are not confident about it, OMIT the smax key entirely for that row. Do NOT guess. The caller will treat the missing value as "not read" and warn the user.
  - SMAX is always a single integer 0-10. If you see a decimal, round to the nearest integer.
  - Do not invent rows that aren't visibly in the screenshot.

Respond with ONLY a JSON array — no prose, no markdown fences.

Example:
[{"ticker":"AAPL","smax":7},{"ticker":"NVDA","smax":9},{"ticker":"CLS-T","smax":10},{"ticker":"BLURRED_ROW"}]

If you genuinely cannot read the screenshot at all, respond with: []`;

/** Server-callable SIA extractor. Returns `{ entries, cached, hash }`. */
export async function extractSiaFromAttachments(
  attachments: AttachmentInput[],
  opts: { force?: boolean } = {},
): Promise<{ entries: ScrapedSia[]; cached: boolean; hash: string; rawText?: string }> {
  if (attachments.length === 0) return { entries: [], cached: false, hash: "none" };
  const hash = hashAttachments(attachments);
  if (!opts.force) {
    try {
      const redis = await getRedis();
      const raw = await redis.get(SIA_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as CachedScrape<ScrapedSia>;
        if (cached.hash === hash) {
          return { entries: cached.entries, cached: true, hash };
        }
      }
    } catch { /* fall through */ }
  }
  const imageBlocks = buildImageBlocks(attachments);
  if (imageBlocks.length === 0) return { entries: [], cached: false, hash };
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: SIA_PROMPT }, ...imageBlocks] }],
  });
  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[sia-extract] raw vision output:", text.slice(0, 4000));
  const entries = parseSiaRows(text);
  try {
    const redis = await getRedis();
    await redis.set(SIA_CACHE_KEY, JSON.stringify({ hash, entries, analyzedAt: new Date().toISOString() } satisfies CachedScrape<ScrapedSia>));
  } catch (e) {
    console.error("Failed to cache SIA scrape:", e);
  }
  return { entries, cached: false, hash, rawText: text };
}

// ── BoostedAI ───────────────────────────────────────────────────────

function normalizeConsensus(raw: unknown): BoostedAiConsensus | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (s) {
    case "strong-buy": case "strongly-buy": return "strong-buy";
    case "buy": return "buy";
    case "hold": case "neutral": return "hold";
    case "sell": return "sell";
    case "strong-sell": case "strongly-sell": return "strong-sell";
    default: return undefined;
  }
}

function parseBoostedRows(text: string): ScrapedBoosted[] {
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
        const ticker = String(r.ticker).trim().toUpperCase().replace(/\//g, "-").replace(/^\$+/, "");
        const out: ScrapedBoosted = { ticker };
        if (r.rating != null) {
          const n = Number(String(r.rating).replace(/[^0-9.\-]/g, ""));
          if (Number.isFinite(n)) {
            out.rating = Math.max(0, Math.min(5, Math.round(n * 10) / 10));
          }
        }
        const consensus = normalizeConsensus(r.consensus);
        if (consensus) out.consensus = consensus;
        return out;
      });
  } catch {
    return [];
  }
}

const BOOSTED_PROMPT = `You are reading a Boosted.ai watchlist screenshot. It is a TABLE of stocks with a numeric AI rating and a consensus label per row.

Extract every visible row and return ONLY:
  - ticker (string, UPPERCASE, required) — the stock's ticker symbol. Strip any leading "$". Convert slash class notation to dash ("BRK/B" → "BRK-B"). For Canadian listings shown with ".TO" or "-T", PRESERVE the suffix as shown.
  - rating (NUMBER, 0-5, may be decimal) — the BoostedAI numeric rating column. Look for a 0 to 5 scale, e.g. "4.2", "3.7". Strip any suffix.
  - consensus (string) — the discrete consensus recommendation. Map to one of EXACTLY: "strong-buy", "buy", "hold", "sell", "strong-sell". The screenshot may display these as "Strong Buy", "Buy", "Hold", "Neutral", "Sell", "Strong Sell" — output the lowercase-hyphenated form above. "Neutral" maps to "hold".

CRITICAL rules:
  - Extract EVERY ticker row you can see, even if rating or consensus is blank/unreadable.
  - If rating is unreadable or missing, OMIT the rating key (do NOT guess or use 0).
  - If consensus is unreadable or missing, OMIT the consensus key.
  - If BOTH are unreadable but the ticker is visible, still return the row with just { ticker: "..." } — the caller will flag it as "not read."
  - Do not invent rows.

Respond with ONLY a JSON array — no prose, no markdown fences.

Example:
[{"ticker":"AAPL","rating":4.2,"consensus":"buy"},{"ticker":"NVDA","rating":4.8,"consensus":"strong-buy"},{"ticker":"INTC","consensus":"sell"},{"ticker":"BLURRED_ROW"}]

If you genuinely cannot read the screenshot at all, respond with: []`;

/** Server-callable BoostedAI extractor. */
export async function extractBoostedFromAttachments(
  attachments: AttachmentInput[],
  opts: { force?: boolean } = {},
): Promise<{ entries: ScrapedBoosted[]; cached: boolean; hash: string; rawText?: string }> {
  if (attachments.length === 0) return { entries: [], cached: false, hash: "none" };
  const hash = hashAttachments(attachments);
  if (!opts.force) {
    try {
      const redis = await getRedis();
      const raw = await redis.get(BOOSTED_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as CachedScrape<ScrapedBoosted>;
        if (cached.hash === hash) {
          return { entries: cached.entries, cached: true, hash };
        }
      }
    } catch { /* fall through */ }
  }
  const imageBlocks = buildImageBlocks(attachments);
  if (imageBlocks.length === 0) return { entries: [], cached: false, hash };
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    temperature: 0,
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: BOOSTED_PROMPT }, ...imageBlocks] }],
  });
  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[boosted-extract] raw vision output:", text.slice(0, 4000));
  const entries = parseBoostedRows(text);
  try {
    const redis = await getRedis();
    await redis.set(BOOSTED_CACHE_KEY, JSON.stringify({ hash, entries, analyzedAt: new Date().toISOString() } satisfies CachedScrape<ScrapedBoosted>));
  } catch (e) {
    console.error("Failed to cache Boosted scrape:", e);
  }
  return { entries, cached: false, hash, rawText: text };
}
