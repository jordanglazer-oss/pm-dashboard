import { NextRequest, NextResponse } from "next/server";
import { extractBoostedFromAttachments, type AttachmentInput } from "@/app/lib/screenshot-extractors";

/**
 * Boosted.ai watchlist screenshot → structured rows.
 *
 * Thin route — vision call + caching live in `app/lib/screenshot-extractors.ts`
 * so the inbox-email webhook can reuse them. Returns
 * `{ ticker, rating?, consensus? }[]`. Hash-gated cache key
 * `pm:boosted-ai-scrape-cache`.
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const attachments: AttachmentInput[] = Array.isArray(body?.attachments) ? body.attachments : [];
    const force = Boolean(body?.force);

    if (attachments.length === 0) {
      return NextResponse.json({ entries: [], cached: false, reason: "no-attachments" });
    }

    const { entries, cached, hash, rawText } = await extractBoostedFromAttachments(attachments, { force });
    return NextResponse.json({ entries, cached, hash, rawText });
  } catch (e) {
    console.error("boosted-ai-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape BoostedAI screenshot" }, { status: 500 });
  }
}
