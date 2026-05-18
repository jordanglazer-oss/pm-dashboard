import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Per-report PDF storage. Each uploaded analyst PDF is stored under
 * pm:analyst-report-pdf:<id> as a base64 dataUrl, separate from the
 * manifest. Mirrors the pm:attachment:<id> pattern so a single ticker
 * accumulating multiple historical reports never bloats the manifest.
 */

function keyFor(id: string): string {
  return `pm:analyst-report-pdf:${id}`;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const redis = await getRedis();
    const raw = await redis.get(keyFor(id));
    if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ dataUrl: raw });
  } catch (e) {
    console.error("Redis read error (analyst-report-pdf/[id]):", e);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const { dataUrl } = await req.json();
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:application/pdf;base64,")) {
      return NextResponse.json({ error: "Invalid dataUrl — must be a base64 PDF" }, { status: 400 });
    }
    const redis = await getRedis();
    await redis.set(keyFor(id), dataUrl);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (analyst-report-pdf/[id]):", e);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const redis = await getRedis();
    await redis.del(keyFor(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis delete error (analyst-report-pdf/[id]):", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
