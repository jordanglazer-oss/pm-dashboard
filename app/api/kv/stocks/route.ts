import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:stocks";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      // No data yet — return empty array, never seed
      return NextResponse.json({ stocks: [] });
    }
    return NextResponse.json({ stocks: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (stocks):", e);
    // On error, return empty — never seed data that could overwrite real data
    return NextResponse.json({ stocks: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { stocks } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(stocks));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (stocks):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
