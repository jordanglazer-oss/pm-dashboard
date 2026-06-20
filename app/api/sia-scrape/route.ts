import { NextRequest, NextResponse } from "next/server";
import { extractSiaFromAttachments, type AttachmentInput } from "@/app/lib/screenshot-extractors";

/**
 * SIA (SIACharts) watchlist screenshot → structured rows.
 *
 * Thin route — vision call + caching live in `app/lib/screenshot-extractors.ts`
 * so the inbox-email webhook can reuse them. Returns `{ ticker, smax }[]`.
 * Hash-gated; cache key `pm:sia-scrape-cache`. Re-uploading an unchanged
 * screenshot returns the cached entries with $0 Anthropic spend.
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const attachments: AttachmentInput[] = Array.isArray(body?.attachments) ? body.attachments : [];
    const force = Boolean(body?.force);

    if (attachments.length === 0) {
      return NextResponse.json({ entries: [], cached: false, reason: "no-attachments" });
    }

    const { entries, cached, hash, rawText } = await extractSiaFromAttachments(attachments, { force });
    return NextResponse.json({ entries, cached, hash, rawText });
  } catch (e) {
    console.error("sia-scrape error:", e);
    return NextResponse.json({ error: "Failed to scrape SIA screenshot" }, { status: 500 });
  }
}
