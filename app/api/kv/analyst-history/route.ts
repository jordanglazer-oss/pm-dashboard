import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { ANALYST_HISTORY_KEY, analystTrend, type AnalystHistory } from "@/app/lib/analyst-history";

/**
 * GET /api/kv/analyst-history[?ticker=AAPL] — the sell-side consensus log
 * with each name's trend (30 / 90-day change in mean target and analyst
 * count, target streak). READ-ONLY: there is deliberately no client write
 * path; the nightly FactSet estimates refresh is the only writer. Returns {}
 * on a missing key or a read error — never seeds.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const raw = await (await getRedis()).get(ANALYST_HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const all = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as AnalystHistory;
    const today = new Date().toISOString().slice(0, 10);
    const want = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
    const out: Record<string, { trend: ReturnType<typeof analystTrend>; entries: AnalystHistory[string] }> = {};
    for (const [ticker, entries] of Object.entries(all)) {
      if (want && ticker !== want) continue;
      out[ticker] = { trend: analystTrend(entries, today), entries: Array.isArray(entries) ? entries : [] };
    }
    return NextResponse.json({ tickers: out });
  } catch {
    return NextResponse.json({ tickers: {} });
  }
}
