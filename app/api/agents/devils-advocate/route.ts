import { NextRequest, NextResponse } from "next/server";
import { readDevilsAdvocate, readDevilsAdvocateAdhoc, runDevilsAdvocate, runDevilsAdvocateAdhoc } from "@/app/lib/agents/devils-advocate";

/**
 * GET  /api/agents/devils-advocate[?month=YYYY-MM] — the month's write-ups,
 *      what is still pending and the cost so far. Read-only.
 * POST /api/agents/devils-advocate { month?, force?, tickers? } — write the
 *      case against each held stock not yet done this month (run again to
 *      continue). Writes only pm:agent-run:devils-advocate:<month>:<TICKER>
 *      and, when the month completes, one flag + one email. Never touches
 *      the book, the models or a thesis.
 *
 * On demand, for ONE book name we do not hold (a pre-buy read):
 * GET  ?ticker=AAPL — the latest on-demand write-up for that name ({ record: null } when none). Read-only.
 * POST { ticker, adhoc: true } — write it (regenerate replaces; the previous
 *      few are kept in `history`). Writes only
 *      pm:agent-run:devils-advocate-adhoc:<TICKER>.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300; // a round of four calls can start at up to 90s and must be allowed to finish

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const month = q.get("month") ?? undefined;
  try {
    const ticker = q.get("ticker");
    if (ticker) return NextResponse.json({ ticker: ticker.toUpperCase(), record: await readDevilsAdvocateAdhoc(ticker) });
    return NextResponse.json(await readDevilsAdvocate(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: unknown; force?: unknown; tickers?: unknown; ticker?: unknown; adhoc?: unknown };
  if (body.adhoc === true) {
    if (typeof body.ticker !== "string" || !body.ticker.trim()) return NextResponse.json({ ok: false, error: "ticker is required" }, { status: 400 });
    const r = await runDevilsAdvocateAdhoc(body.ticker);
    return NextResponse.json(r, { status: r.ok ? 200 : r.error?.includes("not in the") || r.error?.includes("is a holding") || r.error === "not a ticker" ? 400 : 502 });
  }
  const out = await runDevilsAdvocate({
    month: typeof body.month === "string" ? body.month : undefined,
    force: body.force === true,
    tickers: Array.isArray(body.tickers) ? body.tickers.filter((t): t is string => typeof t === "string").slice(0, 40) : undefined,
    budgetMs: 90_000,
  });
  return NextResponse.json(out, { status: out.ok ? 200 : 502 });
}
