import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { blobConfigured, putDataUrl, getDataUrl, deleteBlob } from "@/app/lib/blob-store";

/**
 * Per-image attachment storage. Each screenshot's / PDF's base64 data URL is
 * archived in Vercel Blob at `attachments/<id>` (multi-MB base64 in Redis was
 * an OOM source), while the parent `/api/kv/attachments` route holds only a
 * lightweight manifest (id/label/section/addedAt — no dataUrl).
 *
 * GET    → returns `{ dataUrl }` for a single file (Blob first, then any
 *          legacy Redis copy during the migration window), or 404.
 * PUT    → writes `{ dataUrl }` to Blob for this id.
 * DELETE → removes the Blob (and any legacy Redis key). Manifest cleanup is
 *          handled by the parent route.
 */

function legacyKeyFor(id: string): string {
  return `pm:attachment:${id}`;
}
function blobPathFor(id: string): string {
  return `attachments/${id}`;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    // Blob first; fall back to a legacy Redis copy until the migration runs.
    const fromBlob = await getDataUrl(blobPathFor(id));
    if (fromBlob) return NextResponse.json({ dataUrl: fromBlob });
    const redis = await getRedis();
    const raw = await redis.get(legacyKeyFor(id));
    if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ dataUrl: raw });
  } catch (e) {
    console.error("Attachment read error (attachment/[id]):", e);
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
    if (!blobConfigured()) {
      return NextResponse.json({ error: "BLOB_READ_WRITE_TOKEN not set — cannot store attachment." }, { status: 500 });
    }
    await putDataUrl(blobPathFor(id), dataUrl);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Attachment write error (attachment/[id]):", e);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    await deleteBlob(blobPathFor(id)); // best-effort Blob delete
    const redis = await getRedis();
    await redis.del(legacyKeyFor(id)); // clear any legacy copy too
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Attachment delete error (attachment/[id]):", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
