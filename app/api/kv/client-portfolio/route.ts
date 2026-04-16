import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Persistence for the Client Portfolio Comparison positions on the
 * Client Report page. Stored as a single JSON blob so the user's
 * input survives page refreshes.
 *
 * Shape on disk:
 *   {
 *     positions: [{ id, ticker, name, units, weight }],
 *     cash: 0,
 *     inputMode: "units" | "weight"
 *   }
 */

const KEY = "pm:client-portfolio";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ data: null });
    return NextResponse.json({ data: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (client-portfolio):", e);
    return NextResponse.json({ data: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(body));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (client-portfolio):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
