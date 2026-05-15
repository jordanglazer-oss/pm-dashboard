import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Per-image attachment storage. Each screenshot's base64 data URL is stored
 * under its own Redis key (`pm:attachment:<id>`), while the parent
 * `/api/kv/attachments` route holds only a lightweight manifest
 * (id/label/section/addedAt — no dataUrl). This keeps the manifest blob
 * tiny so it never hits Next.js/Upstash per-value size limits, while still
 * allowing the client to fetch individual images on demand.
 *
 * GET    → returns `{ dataUrl }` for a single image, or 404 if missing.
 * PUT    → writes `{ dataUrl }` for this id. Body is a small JSON with just
 *          the base64 payload, so even an 11-image session is 11 separate
 *          ~300KB PUTs instead of a single ~3MB PUT that silently fails.
 * DELETE → removes the per-image key. Manifest cleanup is handled by the
 *          parent route.
 */

function keyFor(id: string): string {
  return `pm:attachment:${id}`;
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
    console.error("Redis read error (attachment/[id]):", e);
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const { dataUrl } = await req.json();
    // Accept both images (data:image/...) and PDFs (data:application/pdf;base64,...).
    // PDF support is required for the Newton Technical Presentation upload on the
    // Brief page — those decks ship as PDF and we pass them through to Anthropic
    // as `document` blocks without re-encoding.
    if (
      typeof dataUrl !== "string" ||
      !(dataUrl.startsWith("data:image/") || dataUrl.startsWith("data:application/pdf;base64,"))
    ) {
      return NextResponse.json({ error: "Invalid dataUrl" }, { status: 400 });
    }
    const redis = await getRedis();
    await redis.set(keyFor(id), dataUrl);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (attachment/[id]):", e);
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
    console.error("Redis delete error (attachment/[id]):", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
