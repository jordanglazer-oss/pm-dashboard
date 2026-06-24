import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { blobConfigured, putDataUrl } from "@/app/lib/blob-store";

/**
 * GET /api/admin/migrate-attachments-to-blob
 *
 * One-off migration of the Brief/Research screenshot + PDF attachments OUT of
 * Redis (pm:attachment:<id>, multi-MB base64 each) INTO Vercel Blob
 * (attachments/<id>). The manifest (pm:attachments) is keyed by id and needs
 * no change — the [id] route reconstructs the Blob path from the id.
 *
 * Per key: read the dataUrl → upload to Blob → DELETE the Redis key (DEL is
 * OOM-safe; Blob write is independent of Redis memory). Copy-then-delete, so
 * a partial failure never loses a file.
 *
 * SAFETY: DRY RUN by default; &confirm=YES to apply.
 */

export async function GET(req: NextRequest) {
  const confirm = new URL(req.url).searchParams.get("confirm") === "YES";

  if (!blobConfigured()) {
    return NextResponse.json({ error: "BLOB_READ_WRITE_TOKEN not set." }, { status: 500 });
  }

  const redis = await getRedis();
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: "pm:attachment:*", COUNT: 100 })) {
    if (Array.isArray(k)) keys.push(...k);
    else keys.push(k);
  }

  if (keys.length === 0) {
    return NextResponse.json({ mode: confirm ? "APPLIED" : "DRY RUN", migrated: 0, note: "No legacy attachment blobs in Redis." });
  }

  const results: { id: string; bytes: number; ok?: boolean; error?: string }[] = [];
  let migrated = 0;
  let freedBytes = 0;

  for (const key of keys) {
    const id = key.slice("pm:attachment:".length);
    const dataUrl = await redis.get(key);
    if (!dataUrl) { results.push({ id, bytes: 0, error: "empty" }); continue; }
    const bytes = dataUrl.length;
    if (!confirm) { results.push({ id, bytes }); freedBytes += bytes; continue; }
    try {
      await putDataUrl(`attachments/${id}`, dataUrl);
      await redis.del(key);
      migrated += 1;
      freedBytes += bytes;
      results.push({ id, bytes, ok: true });
    } catch (e) {
      results.push({ id, bytes, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    mode: confirm ? "APPLIED" : "DRY RUN — add &confirm=YES to migrate",
    candidates: keys.length,
    migrated: confirm ? migrated : keys.length,
    freedBytes,
    freedMB: Math.round((freedBytes / 1e6) * 100) / 100,
    results,
  });
}
