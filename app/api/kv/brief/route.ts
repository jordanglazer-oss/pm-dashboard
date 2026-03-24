import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:brief";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    return NextResponse.json({ brief: raw ? JSON.parse(raw) : null });
  } catch (e) {
    console.error("Redis read error (brief):", e);
    return NextResponse.json({ brief: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { brief } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(brief));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (brief):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
