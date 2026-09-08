import { NextRequest, NextResponse } from "next/server";
import { readSuggestedAi, buildSuggestedAi, isSuggestedAiStale } from "@/app/lib/suggested-ai";
import { getRedis } from "@/app/lib/redis";

/**
 * AI-positioned Suggested (app/lib/suggested-ai).
 *   GET  → the cached view (zero spend) + whether it's stale vs the regime.
 *   POST → regenerate (≈ one call per sector group). Manual button; the
 *          nightly job also refreshes when older than 7 days or the regime
 *          label changed.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function regimeLabel(): Promise<string | null> {
  try {
    const raw = await (await getRedis()).get("pm:market-regime");
    const j = raw ? (JSON.parse(raw) as { composite?: { label?: string } }) : null;
    return j?.composite?.label ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const [view, label] = await Promise.all([readSuggestedAi(), regimeLabel()]);
  return NextResponse.json({ view, stale: isSuggestedAiStale(view, label), regimeLabel: label });
}

export async function POST(req: NextRequest) {
  void req;
  try {
    const view = await buildSuggestedAi();
    return NextResponse.json({ view, stale: false });
  } catch (e) {
    console.error("suggested-ai failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
