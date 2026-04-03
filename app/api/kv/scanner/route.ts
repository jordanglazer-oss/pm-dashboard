import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:scanner";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    return NextResponse.json({ scanner: raw ? JSON.parse(raw) : null });
  } catch (e) {
    console.error("Redis read error (scanner):", e);
    return NextResponse.json({ scanner: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { scanner } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(scanner));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (scanner):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
