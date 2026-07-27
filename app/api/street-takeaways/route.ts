import { NextRequest, NextResponse } from "next/server";
import { loadStreetTakeaways, loadStreetTakeawaysFor } from "@/app/lib/street-takeaways";

/**
 * Read-only accessor for ingested FactSet Street Takeaways.
 *   GET /api/street-takeaways?ticker=IBM  → { entries: [...] } for one name
 *   GET /api/street-takeaways             → { store: { TICKER: [...] } }
 * Cookie-gated like every dashboard route. Never writes.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ticker = new URL(req.url).searchParams.get("ticker");
    if (ticker) {
      return NextResponse.json({ ok: true, ticker, entries: await loadStreetTakeawaysFor(ticker) });
    }
    return NextResponse.json({ ok: true, store: await loadStreetTakeaways() });
  } catch {
    return NextResponse.json({ ok: true, entries: [], store: {} });
  }
}
