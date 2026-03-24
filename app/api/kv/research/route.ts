import { kv } from "@vercel/kv";
import { NextRequest, NextResponse } from "next/server";
import { defaultResearch } from "@/app/lib/defaults";

const KEY = "pm:research";

export async function GET() {
  try {
    const data = await kv.get(KEY);
    if (!data) {
      await kv.set(KEY, defaultResearch);
      return NextResponse.json({ research: defaultResearch });
    }
    return NextResponse.json({ research: data });
  } catch (e) {
    console.error("KV read error (research):", e);
    return NextResponse.json({ research: defaultResearch });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { research } = await req.json();
    await kv.set(KEY, research);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("KV write error (research):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
