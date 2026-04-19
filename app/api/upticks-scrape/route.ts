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

async function runVision(atts: AttachmentInput[]): Promise<{ entries: ScrapedUptick[]; rawText: string }> {
  const imageBlocks = buildImageBlocks(atts);
  if (imageBlocks.length === 0) return { entries: [], rawText: "" };

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are reading a Fundstrat "Newton's Upticks" technical screen screenshot. It is a TABLE of stocks. Extract every row.

Columns you should look for (they may be labeled differently or abbreviated):
  - Ticker / Symbol → \`ticker\` (string, uppercase, required)
  - Support → \`support\` (see rules below)
  - Resistance → \`resistance\` (see rules below)
  - Price Added / Entry Price / Price at Add → \`priceWhenAdded\` (NUMBER, strip $ and commas)
  - Date Added / Date → \`dateAdded\` (string, e.g. "4/15/2026")

CRITICAL rules for support and resistance:
  - Cells OFTEN contain MULTIPLE levels (S1/S2/S3 or R1/R2/R3). You MUST capture ALL of them, not just the first.
  - Copy the cell contents VERBATIM as a single string, preserving whatever separator is shown (" / ", ", ", newline, etc.). Example: if the support cell reads "120.50 / 118.00 / 115.75", return "120.50 / 118.00 / 115.75" — NOT just "120.50".
  - Include every number you can see in the cell, even if they're stacked on multiple lines. Join with " / " if no separator is clear.
  - Do NOT split or parse the levels — return the raw string, leave interpretation to the caller.
  - If a cell is truly blank, OMIT that key (do not return null or empty string).

General rules:
  - Extract EVERY ticker row you can see. Do not stop short.
  - The current year is 2026; dates without a year should assume 2026 if ambiguous.

Respond with ONLY a JSON array — no prose, no markdown fences. Example with multi-level cells:
[{"ticker":"NVDA","support":"120.50 / 118.00 / 115.75","resistance":"145.00 / 150.00 / 158.00","priceWhenAdded":132.10,"dateAdded":"4/15/2026"}]

If you genuinely cannot read the screenshot, respond with: []`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  // Surface the raw model output in server logs so you can diagnose parse
  // failures ("why did support come back null for every row?"). Keeps the
  // response body lean for the client while still making the data visible.
  console.log("[upticks-scrape] raw vision output:", text.slice(0, 4000));
  return { entries: parseRows(text), rawText: text };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const attachments: AttachmentInput[] = Array.isArray(body?.attachments) ? body.attachments : [];
    const force = Boolean(body?.force);

    if (attachments.length === 0) {
      return NextResponse.json({ entries: [], cached: false, reason: "no-attachments" });
    }

    const hash = hashAttachments(attachments);

    // Cache hit → zero Anthropic tokens spent. `force: true` bypasses the
    // cache so a user can re-run vision when the previous parse was bad
    // (e.g. support/resistance came back empty because the prompt misread
    // the screenshot format).
    if (!force) {
      const cached = await getCached(hash);
      if (cached) {
        return NextResponse.json({ entries: cached, cached: true, hash });
      }
    }

    const { entries, rawText } = await runVision(attachments);
    await saveCached(hash, entries);
    return NextResponse.json({ entries, cached: false, hash, rawText });
  } catch (e) {
    console.error("upticks-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape upticks screenshot" }, { status: 500 });
  }
}
