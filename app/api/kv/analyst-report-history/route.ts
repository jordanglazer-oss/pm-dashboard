import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { parseTickerHistory, reportHistoryKey } from "@/app/lib/analyst-report-history";

/**
 * GET /api/kv/analyst-report-history?ticker=AAPL — every RBC / JPM /
 * Morningstar report on file for one name, oldest first per bank.
 * READ-ONLY: there is deliberately no client write path (the email ingest and
 * the manifest PATCH write it as a write-aside). Returns {} on a missing key
 * or a read error — never seeds.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ticker = new URL(req.url).searchParams.get("ticker")?.trim();
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  try {
    const history = parseTickerHistory(await (await getRedis()).get(reportHistoryKey(ticker)));
    return NextResponse.json({ history: history ?? {} });
  } catch {
    return NextResponse.json({ history: {} });
  }
}
