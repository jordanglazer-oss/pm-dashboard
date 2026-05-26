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
    // Shape guard: must be an object with a 'portfolios' array.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.error("[pm:pim-positions PUT] Rejected non-object body:", typeof data);
      return NextResponse.json(
        { error: "pm:pim-positions body must be an object with a 'portfolios' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((data as any).portfolios)) {
      console.error("[pm:pim-positions PUT] Rejected body missing 'portfolios' array");
      return NextResponse.json(
        { error: "pm:pim-positions body must include a 'portfolios' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-positions):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
