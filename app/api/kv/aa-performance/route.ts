import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:aa-performance";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      return NextResponse.json({ aaPerformance: null });
    }
    return NextResponse.json({ aaPerformance: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (aa-performance):", e);
    return NextResponse.json({ aaPerformance: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { aaPerformance } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(aaPerformance));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (aa-performance):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
