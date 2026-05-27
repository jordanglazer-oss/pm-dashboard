import { NextResponse } from "next/server";
import { fetchForwardLookingData } from "@/app/lib/forward-looking";
import { getRedis } from "@/app/lib/redis";

// GET /api/forward-looking
// Returns the full forward-looking data bundle (SPX trend, SPY forward P/E,
// yield curve, credit trend, VIX/MOVE deltas) so the UI can display every
// value with a direct source link the user can click to verify.
//
// Reads `marketData.breadthOverride` from pm:market in Redis so the breadth
// tiles use the PM's manually-entered % above 200/50 DMA values for today.
// When no entry exists for today, breadth tiles render as "Not entered
// today" rather than running the (no-longer-reliable) Finviz/Yahoo scrape.
export async function GET() {
  try {
    // Read the saved marketData blob to pick up today's manual breadth entry.
    // pm:market shape: { updates: MarketData } per the /api/kv/market PUT.
    let manualBreadth: { date?: string; above200?: number; above50?: number } | undefined;
    try {
      const redis = await getRedis();
      const raw = await redis.get("pm:market");
      if (raw) {
        const parsed = JSON.parse(raw) as {
          updates?: { breadthOverride?: { date?: string; above200?: number; above50?: number } };
        };
        manualBreadth = parsed?.updates?.breadthOverride;
      }
    } catch (e) {
      console.warn("[/api/forward-looking] pm:market read failed; continuing without manual breadth:", e);
    }

    const data = await fetchForwardLookingData(manualBreadth);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
