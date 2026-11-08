import { NextRequest, NextResponse } from "next/server";
import { listCompareRuns, runEarningsCompareForTicker } from "@/app/lib/agents/earnings-compare";
import { loadAllPreviews } from "@/app/lib/earnings-previews";

/**
 * GET  /api/agents/earnings-compare — recent comparison runs (both models
 *      side by side during the comparison period) + which names have a
 *      preview on file. Read-only.
 * POST /api/agents/earnings-compare { ticker } — compare the newest results
 *      recap on file for one ticker now (Monitor's "Compare now"). Spends on
 *      the agents key through the gateway (budget-checked); writes only a run
 *      record and, if notable, a flag. Never touches the book.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const [runs, previews] = await Promise.all([listCompareRuns(40), loadAllPreviews()]);
  const previewTickers = Object.entries(previews)
    .filter(([, list]) => list.length > 0)
    .map(([tk, list]) => ({ ticker: tk, latest: list[0].date, event: list[0].event ?? null }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
  return NextResponse.json({ runs, previewTickers });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ticker?: unknown };
  const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  const out = await runEarningsCompareForTicker(ticker);
  return NextResponse.json(out, { status: out.ok ? 200 : 422 });
}
