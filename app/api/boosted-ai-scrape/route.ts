import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";

/**
 * Boosted.ai watchlist screenshot → structured rows.
 *
 * Same hash-gated cache pattern as upticks-scrape / sia-scrape. Output is
 * { ticker, rating?, consensus? }[] — rating is the 0-5 numeric BoostedAI
 * score; consensus is the discrete Strong Buy / Buy / Hold / Sell / Strong
 * Sell label. Either may be missing if the row was unreadable; the client
 * treats missing fields as "not read" and warns.
 */

const CACHE_KEY = "pm:boosted-ai-scrape-cache";
const client = new Anthropic();

type AttachmentInput = { id: string; label: string; dataUrl: string };

export type BoostedAiConsensus =
  | "strong-buy"
  | "buy"
  | "hold"
  | "sell"
  | "strong-sell";

export type ScrapedBoosted = {
  ticker: string;
  rating?: number; // 0..5, can be decimal
  consensus?: BoostedAiConsensus;
};

type CachedScrape = {
  hash: string;
  entries: ScrapedBoosted[];
  analyzedAt: string;
};

function hashAttachments(atts: AttachmentInput[]): string {
  if (!atts || atts.length === 0) return "none";
  const ids = atts.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

async function getCached(hash: string): Promise<ScrapedBoosted[] | null> {
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

async function saveCached(hash: string, entries: ScrapedBoosted[]) {
  try {
    const redis = await getRedis();
    const payload: CachedScrape = {
      hash,
      entries,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("Failed to cache BoostedAI scrape:", e);
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

function parseRows(text: string): ScrapedBoosted[] {
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

async function runVision(atts: AttachmentInput[]): Promise<{ entries: ScrapedBoosted[]; rawText: string }> {
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
            text: `You are reading a Boosted.ai watchlist screenshot. It is a TABLE of stocks with a numeric AI rating and a consensus label per row.

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

If you genuinely cannot read the screenshot at all, respond with: []`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[boosted-ai-scrape] raw vision output:", text.slice(0, 4000));
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
    console.error("boosted-ai-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape BoostedAI screenshot" }, { status: 500 });
  }
}
