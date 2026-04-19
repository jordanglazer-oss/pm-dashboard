import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";

/**
 * Upticks screenshot → structured rows.
 *
 * Mirrors the JPM-flows caching pattern in app/api/morning-brief/route.ts:
 *   1. Client POSTs the current uptick screenshot(s) (data-URL attachments).
 *   2. We fingerprint the images (MD5 over the tail of each dataUrl).
 *   3. If the fingerprint matches the cached one → return cached entries
 *      WITHOUT calling Anthropic. Refreshes are free.
 *   4. If the fingerprint differs → run vision, parse rows, cache, return.
 *
 * The route never writes to `pm:research` directly — the client merges the
 * returned entries into `state.newtonUpticks` and persists via the existing
 * /api/kv/research PUT path. This keeps the scrape side-effect-free on
 * user data.
 */

const CACHE_KEY = "pm:upticks-scrape-cache";
const client = new Anthropic();

type AttachmentInput = { id: string; label: string; dataUrl: string };

export type ScrapedUptick = {
  ticker: string;
  support?: string;
  resistance?: string;
  priceWhenAdded?: number;
  dateAdded?: string;
};

type CachedScrape = {
  hash: string;
  entries: ScrapedUptick[];
  analyzedAt: string;
};

function hashAttachments(atts: AttachmentInput[]): string {
  if (!atts || atts.length === 0) return "none";
  const ids = atts.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

async function getCached(hash: string): Promise<ScrapedUptick[] | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedScrape;
    return cached.hash === hash ? cached.entries : null;
  } catch {
    return null;
  }
}

async function saveCached(hash: string, entries: ScrapedUptick[]) {
  try {
    const redis = await getRedis();
    const payload: CachedScrape = {
      hash,
      entries,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("Failed to cache upticks scrape:", e);
  }
}

function buildImageBlocks(atts: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const att of atts) {
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

/** Extract the first valid JSON array from a model response. */
function parseRows(text: string): ScrapedUptick[] {
  // Strip code fences if present.
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const slice = cleaned.slice(start, end + 1);
  try {
    const arr = JSON.parse(slice);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === "object" && typeof r.ticker === "string" && r.ticker.trim())
      .map((r) => {
        const out: ScrapedUptick = { ticker: String(r.ticker).trim().toUpperCase() };
        if (r.support != null) out.support = String(r.support);
        if (r.resistance != null) out.resistance = String(r.resistance);
        if (r.priceWhenAdded != null) {
          const n = Number(String(r.priceWhenAdded).replace(/[$,]/g, ""));
          if (Number.isFinite(n)) out.priceWhenAdded = n;
        }
        if (r.dateAdded != null) out.dateAdded = String(r.dateAdded);
        return out;
      });
  } catch {
    return [];
  }
}

async function runVision(atts: AttachmentInput[]): Promise<ScrapedUptick[]> {
  const imageBlocks = buildImageBlocks(atts);
  if (imageBlocks.length === 0) return [];

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are reading a Fundstrat "Newton's Upticks" technical screen screenshot. Extract every stock row into a JSON array.

For each row, return an object with these fields (omit any that aren't visible):
  - ticker: the stock ticker symbol (required, uppercase)
  - support: the support level as shown (keep units/formatting, e.g. "$120" or "120.50")
  - resistance: the resistance level as shown
  - priceWhenAdded: the price at the time the ticker was added, as a NUMBER (strip $ and commas). Some screenshots call this "Price Added" or "Entry Price".
  - dateAdded: the date added in M/D/YYYY format if visible

Respond with ONLY a valid JSON array. No commentary, no markdown fences, no prose. Example:
[{"ticker":"NVDA","support":"120.50","resistance":"145.00","priceWhenAdded":132.10,"dateAdded":"4/15/2026"}]

If no rows are visible, respond with: []`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  return parseRows(text);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const attachments: AttachmentInput[] = Array.isArray(body?.attachments) ? body.attachments : [];

    if (attachments.length === 0) {
      return NextResponse.json({ entries: [], cached: false, reason: "no-attachments" });
    }

    const hash = hashAttachments(attachments);

    // Cache hit → zero Anthropic tokens spent. This is the whole point of
    // the append-only cache: the Refresh button is free unless the image
    // actually changed.
    const cached = await getCached(hash);
    if (cached) {
      return NextResponse.json({ entries: cached, cached: true, hash });
    }

    const entries = await runVision(attachments);
    await saveCached(hash, entries);
    return NextResponse.json({ entries, cached: false, hash });
  } catch (e) {
    console.error("upticks-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape upticks screenshot" }, { status: 500 });
  }
}
