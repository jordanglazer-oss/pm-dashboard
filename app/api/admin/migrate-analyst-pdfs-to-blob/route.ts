import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { blobConfigured, putDataUrl } from "@/app/lib/blob-store";
import type { AnalystReports } from "@/app/lib/analyst-snapshots";

/**
 * GET /api/admin/migrate-analyst-pdfs-to-blob
 *
 * One-off migration of the analyst-report PDF blobs OUT of Redis (where they
 * are multi-MB each and repeatedly OOM the 250 MB Essentials tier) INTO
 * Vercel Blob. For each pm:analyst-report-pdf:<id>:
 *   1. read the base64 dataUrl,
 *   2. upload it to Blob (analyst-reports/<id>) — Blob is a separate service,
 *      so this works even while Redis is OOM,
 *   3. DELETE the Redis key (DEL is permitted at OOM → frees memory).
 * Then it stamps each manifest entry's pdfUrl and writes the manifest back
 * LAST — by which point the deletes have freed enough memory for the write
 * to succeed.
 *
 * SAFETY: DRY RUN by default; &confirm=YES to apply. The PDFs aren't read by
 * the app today (data lives in pm:analyst-snapshots), so this is non-
 * destructive to functionality; the Blob copy is archival insurance.
 */

export async function GET(req: NextRequest) {
  const confirm = new URL(req.url).searchParams.get("confirm") === "YES";

  if (!blobConfigured()) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN not set — create a Blob store in Vercel first." },
      { status: 500 },
    );
  }

  const redis = await getRedis();

  // Collect every legacy PDF key.
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: "pm:analyst-report-pdf:*", COUNT: 100 })) {
    if (Array.isArray(k)) keys.push(...k);
    else keys.push(k);
  }

  if (keys.length === 0) {
    return NextResponse.json({ mode: confirm ? "APPLIED" : "DRY RUN", migrated: 0, note: "No legacy PDF blobs in Redis — nothing to migrate." });
  }

  const results: { id: string; bytes: number; pdfUrl?: string; error?: string }[] = [];
  const idToUrl = new Map<string, string>();
  let freedBytes = 0;

  for (const key of keys) {
    const id = key.slice("pm:analyst-report-pdf:".length);
    const dataUrl = await redis.get(key);
    if (!dataUrl) { results.push({ id, bytes: 0, error: "empty" }); continue; }
    const bytes = dataUrl.length;
    if (!confirm) {
      results.push({ id, bytes });
      freedBytes += bytes;
      continue;
    }
    try {
      // Blob write first (works at OOM), then DEL Redis (frees memory).
      const pdfUrl = await putDataUrl(`analyst-reports/${id}`, dataUrl);
      await redis.del(key);
      idToUrl.set(id, pdfUrl);
      freedBytes += bytes;
      results.push({ id, bytes, pdfUrl });
    } catch (e) {
      results.push({ id, bytes, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Stamp pdfUrl into the manifest — done LAST so the Redis write lands after
  // the deletes above have freed memory. Best-effort: a failure here leaves
  // the PDFs safely in Blob, just without the manifest pointer.
  let manifestUpdated = 0;
  if (confirm && idToUrl.size > 0) {
    try {
      const raw = await redis.get("pm:analyst-reports");
      if (raw) {
        const reports = JSON.parse(raw) as AnalystReports;
        for (const tr of Object.values(reports)) {
          for (const src of ["rbc", "jpm"] as const) {
            const meta = tr?.[src];
            if (meta && idToUrl.has(meta.id)) { meta.pdfUrl = idToUrl.get(meta.id); manifestUpdated++; }
          }
        }
        await redis.set("pm:analyst-reports", JSON.stringify(reports));
      }
    } catch (e) {
      return NextResponse.json({
        mode: "APPLIED (manifest stamp failed)",
        migrated: idToUrl.size,
        freedBytes,
        freedMB: Math.round((freedBytes / 1e6) * 100) / 100,
        manifestError: e instanceof Error ? e.message : String(e),
        results,
      });
    }
  }

  return NextResponse.json({
    mode: confirm ? "APPLIED" : "DRY RUN — add &confirm=YES to migrate",
    candidates: keys.length,
    migrated: confirm ? idToUrl.size : keys.length,
    manifestUpdated,
    freedBytes,
    freedMB: Math.round((freedBytes / 1e6) * 100) / 100,
    results,
  });
}
