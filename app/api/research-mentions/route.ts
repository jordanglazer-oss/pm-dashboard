/**
 * POST /api/research-mentions
 *
 * Tally researchMentions for a list of tickers. Returns the deterministic
 * score (0-3) and the per-source mentions list for each. Used by the
 * client to keep the researchMentions score live without forcing a
 * full Anthropic-driven rescore.
 *
 * Two trigger points on the client:
 *   - StockContext bootstrap: refresh every Portfolio + Watchlist ticker
 *     after the initial KV hydration completes, so the category reflects
 *     today's research caches the moment the dashboard mounts.
 *   - Research page post-scrape: after /api/upticks-scrape or
 *     /api/research-scrape lands, re-tally the affected tickers so the
 *     category jumps to its new value without waiting for the next
 *     weekly rescore.
 *
 * Body: { tickers: string[] }
 * Returns: { results: { [ticker]: { score, rawDelta, mentions, confidence } } }
 *
 * Read-only — no Redis writes. Pure projection over the existing
 * pm:upticks-scrape-cache / pm:research-scrape-cache:* blobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { tallyResearchMentions, type ResearchMentionsResult } from "@/app/lib/research-mentions";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Research-mentions");

const MAX_TICKERS_PER_REQUEST = 250;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw = body?.tickers;
    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: "tickers array required" }, { status: 400 });
    }
    // Dedupe + uppercase + cap to keep the parallel fan-out bounded.
    // 250 covers any realistic Portfolio + Watchlist combined.
    const tickers = Array.from(
      new Set(
        raw
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim().toUpperCase()),
      ),
    ).slice(0, MAX_TICKERS_PER_REQUEST);

    if (tickers.length === 0) {
      return NextResponse.json({ results: {} });
    }

    // Tally is pure-Redis-read; safe to parallelize. Each call reads the
    // same 8 cache blobs, so we benefit from any in-process caching
    // Upstash applies for repeated identical GETs in the same request.
    const tallies = await Promise.all(
      tickers.map(async (t) => ({ t, result: await tallyResearchMentions(t) })),
    );

    const results: Record<string, ResearchMentionsResult> = {};
    for (const { t, result } of tallies) {
      results[t] = result;
    }
    return NextResponse.json({ results });
  } catch (e) {
    log.error("batch tally failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to tally research mentions" },
      { status: 500 },
    );
  }
}
