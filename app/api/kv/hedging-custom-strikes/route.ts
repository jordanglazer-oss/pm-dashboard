import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * User-defined custom strike list for the Hedging tab.
 * Stored as a simple array of numbers so the same list follows the user
 * across devices and survives refreshes.
 */

const KEY = "pm:hedging-custom-strikes";

export type HedgingCustomStrikes = {
  strikes: number[];
};

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ strikes: [] });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (hedging-custom-strikes):", e);
    return NextResponse.json({ strikes: [] });
  }
}

/** POST replaces the entire list. Body: { strikes: number[] } */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as HedgingCustomStrikes;
    if (!Array.isArray(body?.strikes)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    // Sanitize: positive finite numbers, de-duped, sorted descending
    const clean = Array.from(
      new Set(
        body.strikes.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0),
      ),
    ).sort((a, b) => b - a);

    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify({ strikes: clean }));
    return NextResponse.json({ ok: true, strikes: clean });
  } catch (e) {
    console.error("Redis write error (hedging-custom-strikes):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
