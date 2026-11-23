import { NextRequest, NextResponse } from "next/server";
import { readDevilsAdvocate, runDevilsAdvocate } from "@/app/lib/agents/devils-advocate";

/**
 * GET  /api/agents/devils-advocate[?month=YYYY-MM] — the month's write-ups,
 *      what is still pending and the cost so far. Read-only.
 * POST /api/agents/devils-advocate { month?, force?, tickers? } — write the
 *      case against each held stock not yet done this month (run again to
 *      continue). Writes only pm:agent-run:devils-advocate:<month>:<TICKER>
 *      and, when the month completes, one flag + one email. Never touches
 *      the book, the models or a thesis.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const month = new URL(req.url).searchParams.get("month") ?? undefined;
  try {
    return NextResponse.json(await readDevilsAdvocate(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: unknown; force?: unknown; tickers?: unknown };
  const out = await runDevilsAdvocate({
    month: typeof body.month === "string" ? body.month : undefined,
    force: body.force === true,
    tickers: Array.isArray(body.tickers) ? body.tickers.filter((t): t is string => typeof t === "string").slice(0, 40) : undefined,
    budgetMs: 90_000,
  });
  return NextResponse.json(out, { status: out.ok ? 200 : 502 });
}
