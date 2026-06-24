import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { blobConfigured, putDataUrl } from "@/app/lib/blob-store";

/**
 * Per-report PDF storage. The original PDF is archived to Vercel Blob (PUT
 * returns its public URL, which the caller stores as ReportMeta.pdfUrl).
 * Multi-MB PDFs used to live in Redis at pm:analyst-report-pdf:<id> and
 * repeatedly OOM'd the 250 MB tier. GET still reads any legacy Redis blob
 * for backward compat until the one-time migration clears them.
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
    if (!blobConfigured()) {
      // No Blob store wired up (e.g. local dev). Don't fall back to Redis —
      // that's the OOM source we're eliminating. The extracted data is still
      // saved by the caller; only the archival PDF copy is skipped.
      return NextResponse.json({ ok: true, pdfUrl: null, note: "Blob not configured — PDF archive skipped." });
    }
    const pdfUrl = await putDataUrl(`analyst-reports/${id}`, dataUrl);
    return NextResponse.json({ ok: true, pdfUrl });
  } catch (e) {
    console.error("Analyst PDF Blob write error (analyst-report-pdf/[id]):", e);
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
