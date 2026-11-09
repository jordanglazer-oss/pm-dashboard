import { NextRequest, NextResponse } from "next/server";
import { readStanceState, runStanceWatch } from "@/app/lib/agents/stance-watch";

/**
 * GET  /api/agents/stance-watch — the last stance reading + hedge window
 *      (Monitor). Read-only.
 * POST /api/agents/stance-watch { force? } — run the after-close check now.
 *      Writes only pm:agent-state:stance and, on a change, a flag.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({ state: await readStanceState() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { force?: unknown };
  try {
    const out = await runStanceWatch({ force: body.force === true });
    return NextResponse.json(out, { status: out.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
