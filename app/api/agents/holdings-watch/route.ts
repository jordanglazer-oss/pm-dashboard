import { NextRequest, NextResponse } from "next/server";
import { listHoldingsDays, listHoldingsEvents, runHoldingsWatch } from "@/app/lib/agents/holdings-watch";

/**
 * GET  /api/agents/holdings-watch — recent run summaries + events (Monitor).
 *      Read-only.
 * POST /api/agents/holdings-watch { force? } — run today's after-close pass
 *      now (Monitor's "Run now"). Names already looked at today are skipped
 *      unless force. Spends on the agents key through the gateway; writes
 *      only its own run records and flags. Never touches the book.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const [days, events] = await Promise.all([listHoldingsDays(10), listHoldingsEvents(80)]);
  return NextResponse.json({ days, events });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { force?: unknown };
  const out = await runHoldingsWatch({ force: body.force === true });
  return NextResponse.json(out, { status: out.ok ? 200 : 502 });
}
