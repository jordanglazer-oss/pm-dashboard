import { kv } from "@vercel/kv";
import { NextRequest, NextResponse } from "next/server";
import { defaultMarketData } from "@/app/lib/defaults";

const KEY = "pm:market";

export async function GET() {
  try {
    const data = await kv.get(KEY);
    if (!data) {
      await kv.set(KEY, defaultMarketData);
      return NextResponse.json({ market: defaultMarketData });
    }
    return NextResponse.json({ market: data });
  } catch (e) {
    console.error("KV read error (market):", e);
    return NextResponse.json({ market: defaultMarketData });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { updates } = await req.json();
    const existing = (await kv.get(KEY)) || defaultMarketData;
    const merged = { ...existing, ...updates };
    await kv.set(KEY, merged);
    return NextResponse.json({ market: merged });
  } catch (e) {
    console.error("KV write error (market):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
