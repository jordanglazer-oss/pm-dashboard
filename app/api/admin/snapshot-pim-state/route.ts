/**
 * GET /api/admin/snapshot-pim-state
 *
 * READ-ONLY emergency diagnostic. Dumps the COMPLETE current contents
 * of the three blobs that govern Positioning view rendering:
 *
 *   - pm:pim-models       (target holdings per group, per asset class)
 *   - pm:pim-positions    (actual units + cost basis per group + profile)
 *   - pm:stocks           (Portfolio / Watchlist roster)
 *
 * Output is large by design — saving the response to a local JSON
 * file gives the user a frozen reference snapshot of the live state.
 *
 * NO WRITES. NO MUTATIONS. NO DELETIONS. Safe to call any number of
 * times without affecting anything.
 *
 * Used as the first step of any recovery: lock in "current state"
 * before designing a fix, so even if the fix goes wrong we always
 * have the pre-fix data in hand.
 */

import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

export async function GET() {
  try {
    const redis = await getRedis();
    const [pimRaw, posRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:stocks"),
    ]);

    // Return raw + parsed for each blob so the user has both verbatim
    // strings (for restoration / hashing) and structured data (for
    // human inspection).
    const safeParse = (raw: string | null) => {
      if (raw == null) return { present: false };
      try {
        return { present: true, bytes: raw.length, parsed: JSON.parse(raw) };
      } catch (e) {
        return { present: true, bytes: raw.length, parseError: e instanceof Error ? e.message : String(e), raw };
      }
    };

    return NextResponse.json({
      snapshotAt: new Date().toISOString(),
      pimModels: safeParse(pimRaw),
      pimPositions: safeParse(posRaw),
      stocks: safeParse(stocksRaw),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to snapshot pim state" },
      { status: 500 },
    );
  }
}
