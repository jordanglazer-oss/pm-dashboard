import { NextResponse } from "next/server";
import { listMemos, writeSundayMemo } from "@/app/lib/agents/sunday-memo";

/**
 * GET  /api/agents/sunday-memo — the memo archive (Monitor). Read-only.
 * POST /api/agents/sunday-memo — write this week's memo now (no email; the
 *      Sunday cron emails). Writes only pm:agent-memo:<today>.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({ memos: await listMemos(12) });
}

export async function POST() {
  const out = await writeSundayMemo({ email: false });
  return NextResponse.json(out, { status: out.ok ? 200 : 502 });
}
