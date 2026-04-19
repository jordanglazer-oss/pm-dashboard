import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { defaultResearch } from "@/app/lib/defaults";

const KEY = "pm:research";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Per CLAUDE.md: NEVER seed Redis on read. If a stale client later PUTs
    // its in-memory defaults, the seed would overwrite whatever was there.
    // Return defaults in-memory only; the first user PUT creates the key.
    if (!raw) return NextResponse.json({ research: defaultResearch });
    return NextResponse.json({ research: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (research):", e);
    return NextResponse.json({ research: defaultResearch });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { research } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(research));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (research):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
