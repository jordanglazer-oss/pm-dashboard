import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getFactsetEstimatesByTicker, factsetConfigured, type FactsetEstimates } from "@/app/lib/factset";
import { createLogger } from "@/app/lib/logger";

/**
 * POST /api/factset-estimates — batched FactSet FY+1 estimate revisions (+ mean
 * target, analyst count) for an arbitrary ticker universe (the ~240 Pipeline
 * names). Powers the Pipeline "Improving" signal.
 *
 * getFactsetEstimatesByTicker batches ~40 ids/call, so 240 tickers ≈ 6 calls.
 * Result cached in pm:pipeline-estimates (12h freshness) so the Pipeline page
 * doesn't re-spend FactSet on every load. No-op ({}) when the relay is dark.
 *
 * Body: { tickers: string[], refresh?: boolean }
 */

const log = createLogger("PipelineEstimates");
const KEY = "pm:pipeline-estimates";
const STALE_MS = 12 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tickers: string[] = Array.isArray(body?.tickers)
      ? (body.tickers as unknown[]).filter((t): t is string => typeof t === "string" && !!t.trim())
      : [];
    const force = body?.refresh === true;
    if (!factsetConfigured()) return NextResponse.json({ estimates: {}, configured: false });
    if (tickers.length === 0) return NextResponse.json({ estimates: {}, configured: true });

    const redis = await getRedis();
    let cached: { builtAt?: string; estimates?: Record<string, FactsetEstimates> } = {};
    try {
      const raw = await redis.get(KEY);
      if (raw) cached = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const fresh = cached.builtAt && Date.now() - new Date(cached.builtAt).getTime() < STALE_MS;
    if (fresh && !force && cached.estimates) {
      return NextResponse.json({ estimates: cached.estimates, cached: true, configured: true });
    }

    const estimates = await getFactsetEstimatesByTicker(tickers);
    // Cache-only write (regenerable; no user data).
    try {
      await redis.set(KEY, JSON.stringify({ builtAt: new Date().toISOString(), estimates }));
    } catch (e) {
      log.warn("cache write failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ estimates, cached: false, configured: true });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ estimates: {} });
  }
}
