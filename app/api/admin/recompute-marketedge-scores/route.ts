import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { mapPowerRatingToMarketEdge } from "@/app/lib/external-scoring";

/**
 * GET /api/admin/recompute-marketedge-scores
 *
 * Re-derives every holding's stored `scores.marketEdge` from its stored
 * MarketEdge Power Rating using the CURRENT mapPowerRatingToMarketEdge
 * thresholds. Needed after a mapping change (e.g. the +60 Long realignment),
 * because the weekly CSV importer only recomputes a score when the Power
 * Rating VALUE changes — so a threshold change alone never reaches the
 * already-stored scores.
 *
 * SAFETY:
 *  - DRY RUN by default; &confirm=YES to write.
 *  - Stashes pm:stocks to pm:stocks.pre-marketedge-recompute-<ts> first.
 *  - Read-modify-write: only scores.marketEdge changes, and only on stocks
 *    that already have a powerRating AND whose mapped score actually differs.
 *    Power Rating values, all other scores, and all other fields untouched.
 */

type Stock = {
  ticker: string;
  marketEdge?: { powerRating?: number };
  scores?: Record<string, number>;
};

export async function GET(req: NextRequest) {
  const confirm = new URL(req.url).searchParams.get("confirm") === "YES";
  const redis = await getRedis();

  const raw = await redis.get("pm:stocks");
  if (!raw) return NextResponse.json({ error: "pm:stocks missing/unreadable." }, { status: 500 });

  const stocks = JSON.parse(raw) as Stock[];
  const changes: { ticker: string; powerRating: number; from: number | null; to: number }[] = [];

  for (const s of stocks) {
    const pr = s.marketEdge?.powerRating;
    if (typeof pr !== "number") continue;
    const mapped = mapPowerRatingToMarketEdge(pr);
    if (mapped == null) continue;
    const current = s.scores?.marketEdge;
    if (current === mapped) continue;
    changes.push({ ticker: s.ticker, powerRating: pr, from: current ?? null, to: mapped });
    if (confirm) {
      s.scores = { ...(s.scores ?? {}), marketEdge: mapped };
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (confirm && changes.length > 0) {
    await redis.set(`pm:stocks.pre-marketedge-recompute-${ts}`, raw);
    await redis.set("pm:stocks", JSON.stringify(stocks));
  }

  return NextResponse.json({
    mode: confirm ? "APPLIED" : "DRY RUN — add &confirm=YES to apply",
    changed: changes.length,
    changes,
    stashed: confirm && changes.length > 0 ? `pm:stocks.pre-marketedge-recompute-${ts}` : undefined,
    note: changes.length === 0 ? "No holdings needed a change — every marketEdge score already matches the current mapping." : undefined,
  });
}
