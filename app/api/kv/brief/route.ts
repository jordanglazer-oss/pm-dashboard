import { kv } from "@vercel/kv";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:brief";

export async function GET() {
  try {
    const data = await kv.get(KEY);
    return NextResponse.json({ brief: data || null });
  } catch (e) {
    console.error("KV read error (brief):", e);
    return NextResponse.json({ brief: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { brief } = await req.json();
    await kv.set(KEY, brief);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("KV write error (brief):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
