import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";

/**
 * SIA (SIACharts) watchlist screenshot → structured rows.
 *
 * Mirrors the upticks-scrape pattern:
 *   1. Client POSTs current SIA watchlist screenshot(s) (data-URL attachments).
 *   2. We fingerprint the images (MD5 over the tail of each dataUrl).
 *   3. Cache hit on `pm:sia-scrape-cache` → return cached entries with $0 spend.
 *   4. Otherwise run vision, parse rows, cache, return.
 *
 * Output is just { ticker, smax }[]. The client merges results into
 * pm:stocks per-ticker via /api/kv/stocks; the scrape side is read-only with
 * respect to stock data.
 */

const CACHE_KEY = "pm:sia-scrape-cache";
const client = new Anthropic();

type AttachmentInput = { id: string; label: string; dataUrl: string };

export type ScrapedSia = {
  ticker: string;
  smax?: number; // 0..10 integer
};

type CachedScrape = {
  hash: string;
  entries: ScrapedSia[];
  analyzedAt: string;
};

function hashAttachments(atts: AttachmentInput[]): string {
  if (!atts || atts.length === 0) return "none";
  const ids = atts.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

async function getCached(hash: string): Promise<ScrapedSia[] | null> {
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

async function saveCached(hash: string, entries: ScrapedSia[]) {
  try {
    const redis = await getRedis();
    const payload: CachedScrape = {
      hash,
      entries,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("Failed to cache SIA scrape:", e);
  }
}

function buildImageBlocks(atts: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
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

function parseRows(text: string): ScrapedSia[] {
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

async function runVision(atts: AttachmentInput[]): Promise<{ entries: ScrapedSia[]; rawText: string }> {
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
          {
            type: "text",
            text: `You are reading a SIACharts watchlist screenshot. It is a TABLE of stocks with a SIA SMAX score for each.

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

If you genuinely cannot read the screenshot at all, respond with: []`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[sia-scrape] raw vision output:", text.slice(0, 4000));
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
    console.error("sia-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape SIA screenshot" }, { status: 500 });
  }
}
