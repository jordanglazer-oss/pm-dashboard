import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { Stock } from "@/app/lib/types";
import type { PimModelData } from "@/app/lib/pim-types";

/**
 * One-shot recovery for the Buy/Sell flow's old Watchlist → Portfolio bug:
 * a buy ticker that was already on the Watchlist had its pim-models entry
 * + position updated correctly, but the Stock.bucket field stayed
 * "Watchlist" so the Dashboard + stock pages still showed it as Watchlist.
 *
 * This route finds every stock whose
 *   bucket === "Watchlist"
 *   AND has a weightInClass > 0 in at least one PIM model group
 * (the exact symptom of the bug) and promotes them to Portfolio with a
 * sensible default weights.portfolio (2% — the canonical individual-stock
 * default). It does NOT touch pim-models or positions — those were
 * already updated correctly by the trade.
 *
 * SAFETY (per CLAUDE.md):
 *   - Requires ?confirm=YES.
 *   - Stashes the pre-image of pm:stocks to pm:pre-promote-stash:<ts>
 *     BEFORE mutating, so any unexpected outcome can be reverted by reading
 *     that key and replaying it via redis.set("pm:stocks", value).
 *   - Returns the list of moved tickers so the user can verify the diff.
 *   - Never touches anything other than pm:stocks. Models, positions,
 *     scores, snapshots — all untouched.
 */

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to promote any Watchlist names that have a non-zero PIM-model position (the symptom of the old Buy/Sell bucket-move bug). pm:stocks is the only key touched; a pre-image is stashed at pm:pre-promote-stash:<ts> for rollback.",
      },
      { status: 400 },
    );
  }
  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    // ── Read current state ─────────────────────────────────────────────
    const stocksRaw = await redis.get("pm:stocks");
    if (!stocksRaw) {
      return NextResponse.json({ ok: false, error: "pm:stocks missing or empty" }, { status: 500 });
    }
    const stocks = JSON.parse(stocksRaw) as Stock[];

    const modelsRaw = await redis.get("pm:pim-models");
    if (!modelsRaw) {
      return NextResponse.json({ ok: false, error: "pm:pim-models missing or empty" }, { status: 500 });
    }
    const models = JSON.parse(modelsRaw) as PimModelData;

    // ── Find Watchlist names with a non-zero position in any group ─────
    // tickerMatch tolerates "-T" vs ".TO" variants — same as StockContext.
    const tickerMatch = (a: string, b: string) =>
      a === b || a.replace(/-T$/, ".TO") === b.replace(/-T$/, ".TO");

    const candidates: string[] = [];
    for (const s of stocks) {
      if (s.bucket !== "Watchlist") continue;
      // Held in ≥1 model group with a real weight? → was bought via the
      // buggy Buy/Sell flow; promote.
      const isInAnyModel = models.groups.some((g) =>
        g.holdings.some(
          (h) => h.weightInClass > 0 && tickerMatch(h.symbol, s.ticker),
        ),
      );
      if (isInAnyModel) candidates.push(s.ticker);
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        ok: true,
        moved: [],
        note: "No Watchlist names have a non-zero PIM-model position. Nothing to promote.",
        elapsedMs: Date.now() - startedAt,
      });
    }

    // ── Stash pre-image BEFORE mutating ─────────────────────────────────
    const stamp = new Date().toISOString();
    const stashKey = `pm:pre-promote-stash:${stamp}`;
    await redis.set(stashKey, stocksRaw);

    // ── Mutate: promote bucket, set a sensible default weights.portfolio ─
    // Default weight 2% mirrors what moveBucket(Watchlist → Portfolio) does
    // in StockContext, which is the canonical individual-stock default.
    // ETFs/funds keep their existing weights.portfolio if non-zero.
    const updatedStocks: Stock[] = stocks.map((s) => {
      if (!candidates.includes(s.ticker)) return s;
      const isFund = s.instrumentType === "etf" || s.instrumentType === "mutual-fund";
      return {
        ...s,
        bucket: "Portfolio" as const,
        weights: {
          ...s.weights,
          portfolio: isFund && s.weights.portfolio > 0 ? s.weights.portfolio : 2,
        },
      };
    });

    await redis.set("pm:stocks", JSON.stringify(updatedStocks));

    return NextResponse.json({
      ok: true,
      moved: candidates,
      stashKey,
      note: `Promoted ${candidates.length} Watchlist name(s) to Portfolio. Pre-image stashed at ${stashKey}. To revert: redis.set("pm:stocks", await redis.get("${stashKey}")).`,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("[promote-watchlist-in-models] failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
