import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:chart-analysis";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    return NextResponse.json({ chartAnalyses: raw ? JSON.parse(raw) : {} });
  } catch (e) {
    console.error("Redis read error (chart-analysis):", e);
    return NextResponse.json({ chartAnalyses: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { chartAnalyses } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(chartAnalyses));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (chart-analysis):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
