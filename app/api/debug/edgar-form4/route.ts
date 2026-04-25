import { NextResponse } from "next/server";
import { getInsiderActivity } from "@/app/lib/edgar-form4";

/**
 * GET /api/debug/edgar-form4?ticker=AAPL
 *
 * Stage 3 sanity-check: returns the raw insider-activity summary that
 * gets injected into the score prompt. Use this to verify Form 4 data
 * is being parsed correctly before relying on the AI scores.
 *
 * Look for:
 *   - transactionCount > 0 (or 0 for issuers with no recent activity)
 *   - buyCount + sellCount adds up
 *   - Real insider names in topBuys / topSells (not "Unknown")
 *   - relationship populated (Officer/Director/10% Owner)
 *   - Reasonable totalValue numbers (shares × price)
 *   - For Canadian tickers: returns null cleanly (not in EDGAR)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json(
        { error: "ticker query param required (e.g. ?ticker=AAPL)" },
        { status: 400 }
      );
    }

    const summary = await getInsiderActivity(ticker);
    if (!summary) {
      return NextResponse.json({
        ticker,
        note: `${ticker} not found in SEC EDGAR (likely Canadian / non-US listing). Insider activity unavailable; the score prompt will skip this section for non-US tickers.`,
      });
    }

    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
