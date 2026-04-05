import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:ui-prefs";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      return NextResponse.json({ uiPrefs: {} });
    }
    return NextResponse.json({ uiPrefs: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (ui-prefs):", e);
    return NextResponse.json({ uiPrefs: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { uiPrefs } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(uiPrefs));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (ui-prefs):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
