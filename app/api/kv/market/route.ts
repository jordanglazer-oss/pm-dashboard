import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { defaultMarketData } from "@/app/lib/defaults";

const KEY = "pm:market";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      await redis.set(KEY, JSON.stringify(defaultMarketData));
      return NextResponse.json({ market: defaultMarketData });
    }
    return NextResponse.json({ market: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (market):", e);
    return NextResponse.json({ market: defaultMarketData });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { updates } = await req.json();
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const existing = raw ? JSON.parse(raw) : defaultMarketData;
    const merged = { ...existing, ...updates };
    await redis.set(KEY, JSON.stringify(merged));
    return NextResponse.json({ market: merged });
  } catch (e) {
    console.error("Redis write error (market):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
