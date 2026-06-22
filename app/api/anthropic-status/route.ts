import { NextResponse } from "next/server";
import { getAnthropicStatus, markAnthropicHealthy } from "@/app/lib/anthropic-status";

/**
 * GET  /api/anthropic-status
 *   Read-only. Returns the last-known Anthropic credit health
 *   ({ state, at, detail } or null). The nav polls this to show a red
 *   "credits exhausted" chip. No tokens spent — pure Redis read.
 *
 * POST /api/anthropic-status   (body: { action: "clear" })
 *   Manually clears the exhausted flag — use right after swapping in a new
 *   API key so the chip goes away without waiting for the next Brief to
 *   auto-clear it.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getAnthropicStatus();
  return NextResponse.json({ status });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body?.action === "clear") {
    await markAnthropicHealthy();
    return NextResponse.json({ ok: true, cleared: true });
  }
  return NextResponse.json({ ok: false, error: "Unknown action. Send { action: \"clear\" }." }, { status: 400 });
}
