import { NextRequest, NextResponse } from "next/server";
import { fetchLiveHedgingCosts } from "@/app/lib/hedging";

/**
 * Live SPY protective put hedging cost table. Pure read-through endpoint;
 * all fetching / parsing logic lives in @/app/lib/hedging so the morning
 * brief route can share it without HTTP round-trips.
 */

// Re-export types so existing client imports (HedgingDashboard) keep working
export type {
  HedgingQuote,
  HedgingLiveData,
  CustomStrikeRow,
  CustomStrikeQuote,
} from "@/app/lib/hedging";

export async function GET(req: NextRequest) {
  try {
    const extraStrikes = (req.nextUrl.searchParams.get("extraStrikes") || "")
      .split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const data = await fetchLiveHedgingCosts(extraStrikes);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Map known upstream problems to 502, everything else to 500
    const status = /CBOE|parse|expiries/i.test(message) ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
