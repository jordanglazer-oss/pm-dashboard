import { NextRequest, NextResponse } from "next/server";
import { readManagerState, runManagerWatch } from "@/app/lib/agents/manager-watch";

/**
 * GET  /api/agents/manager-watch — the last quarterly fund review (Monitor).
 *      Read-only.
 * POST /api/agents/manager-watch { force? } — review the Thematic funds now.
 *      Writes only pm:agent-state:manager-watch and a flag per fund that
 *      trips a rule. Never touches the book or the models.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({ state: await readManagerState() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { force?: unknown };
  try {
    const out = await runManagerWatch({ force: body.force === true });
    return NextResponse.json(out, { status: out.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
