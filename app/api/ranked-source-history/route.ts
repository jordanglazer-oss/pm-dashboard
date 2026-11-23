import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { history as priceHistory } from "@/app/lib/holding-history";
import { RANKED_HISTORY_KEY, etDay, recordRankedHistory, type RankedHistory } from "@/app/lib/ranked-source-history";

/**
 * GET /api/ranked-source-history[?perf=1]
 *
 * The ranked-source first-appearance log (pm:ranked-source-history) for the
 * Ranked research table. There is NO client write path: the log is written
 * only by the write-aside that follows a pm:research save.
 *
 * One exception, once: when no log exists yet, this GET records the BASELINE
 * from the lists as they stand (every entry marked `baseline`), so tracking
 * starts the day the page is first opened rather than at the next list save.
 * It never touches an existing log.
 *
 * `?perf=1` adds, for each name currently at the top (3+ lists): the price
 * the day it got there and the price now (Yahoo adjusted closes, native
 * currency) — fetched on demand, nothing stored. Returns an empty log on a
 * missing key or a read error.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("Ranked-history");
const MAX_PERF = 60;

type Perf = { since: string; baseline: boolean; priceThen: number | null; priceNow: number | null; pct: number | null };

async function perfFor(ticker: string, since: string): Promise<Omit<Perf, "since" | "baseline">> {
  const s = await priceHistory(ticker, since);
  // First close on or after the day it reached the top; latest close now.
  const i = s.dates.findIndex((d) => d >= since);
  const then = i >= 0 ? s.adj[i] : null;
  const now = s.adj.length ? s.adj[s.adj.length - 1] : null;
  const pct = then && now && then > 0 ? parseFloat(((now / then - 1) * 100).toFixed(2)) : null;
  return { priceThen: then, priceNow: now, pct };
}

export async function GET(req: NextRequest) {
  const empty: RankedHistory = { startedAt: etDay(), tickers: {} };
  try {
    const redis = await getRedis();
    let raw = await redis.get(RANKED_HISTORY_KEY);
    if (!raw) {
      const researchRaw = await redis.get("pm:research");
      if (researchRaw) {
        await recordRankedHistory(redis, JSON.parse(researchRaw));
        raw = await redis.get(RANKED_HISTORY_KEY);
      }
    }
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const history = (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as RankedHistory).tickers === "object" ? parsed : empty) as RankedHistory;

    let perf: Record<string, Perf> | undefined;
    if (new URL(req.url).searchParams.get("perf") === "1") {
      perf = {};
      const tops = Object.entries(history.tickers)
        .map(([key, t]) => ({ key, ticker: t.ticker, span: t.top?.length && !t.top[t.top.length - 1].to ? t.top[t.top.length - 1] : null }))
        .filter((x): x is { key: string; ticker: string; span: NonNullable<typeof x.span> } => !!x.span)
        .slice(0, MAX_PERF);
      for (let i = 0; i < tops.length; i += 8) {
        await Promise.all(
          tops.slice(i, i + 8).map(async (t) => {
            try {
              perf![t.key] = { since: t.span.from, baseline: !!t.span.baseline, ...(await perfFor(t.ticker, t.span.from)) };
            } catch {
              perf![t.key] = { since: t.span.from, baseline: !!t.span.baseline, priceThen: null, priceNow: null, pct: null };
            }
          }),
        );
      }
    }
    return NextResponse.json({ history, today: etDay(), ...(perf ? { perf } : {}) });
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({ history: empty, today: etDay() });
  }
}
