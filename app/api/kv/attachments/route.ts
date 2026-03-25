import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:attachments";

export type Attachment = {
  id: string;
  label: string;
  section: string; // e.g. "equityFlows", "breadth", etc.
  dataUrl: string; // base64 data URL
  addedAt: string;
};

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    return NextResponse.json({ attachments: raw ? JSON.parse(raw) : [] });
  } catch (e) {
    console.error("Redis read error (attachments):", e);
    return NextResponse.json({ attachments: [] });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { attachments } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(attachments));
    return NextResponse.json({ attachments });
  } catch (e) {
    console.error("Redis write error (attachments):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
