import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { pimModelSeed } from "@/app/lib/pim-seed";

const KEY = "pm:pim-models";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      const seed = { groups: pimModelSeed, lastUpdated: new Date().toISOString() };
      await redis.set(KEY, JSON.stringify(seed));
      return NextResponse.json(seed);
    }
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-models):", e);
    return NextResponse.json({ groups: pimModelSeed, lastUpdated: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-models):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
