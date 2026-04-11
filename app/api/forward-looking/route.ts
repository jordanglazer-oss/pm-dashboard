import { NextResponse } from "next/server";
import { fetchForwardLookingData } from "@/app/lib/forward-looking";

// GET /api/forward-looking
// Returns the full forward-looking data bundle (SPX trend, SPY forward P/E,
// yield curve, credit trend, VIX/MOVE deltas) so the UI can display every
// value with a direct source link the user can click to verify.
export async function GET() {
  try {
    const data = await fetchForwardLookingData();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
