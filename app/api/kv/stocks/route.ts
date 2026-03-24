import { kv } from "@vercel/kv";
import { NextRequest, NextResponse } from "next/server";
import { holdingsSeed } from "@/app/lib/defaults";

const KEY = "pm:stocks";

export async function GET() {
  try {
    const data = await kv.get(KEY);
    if (!data) {
      await kv.set(KEY, holdingsSeed);
      return NextResponse.json({ stocks: holdingsSeed });
    }
    return NextResponse.json({ stocks: data });
  } catch (e) {
    // If KV not configured, fall back to seed data
    console.error("KV read error (stocks):", e);
    return NextResponse.json({ stocks: holdingsSeed });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { stocks } = await req.json();
    await kv.set(KEY, stocks);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("KV write error (stocks):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
