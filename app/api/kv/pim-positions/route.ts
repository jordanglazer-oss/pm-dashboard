import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:pim-positions";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ portfolios: [] });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-positions):", e);
    return NextResponse.json({ portfolios: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-positions):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
