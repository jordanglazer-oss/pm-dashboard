/**
 * GET /api/admin/list-backups
 *
 * Lists every backup snapshot in Vercel Blob, newest first, with size +
 * uploaded time. Pass ?inspect=YES to also download each snapshot and report
 * its keyCount and whether the critical blobs (pm:stocks / pm:pim-models /
 * pm:pim-positions) are populated — useful when picking a known-good backup
 * to restore from. Without inspect it's metadata-only (fast, no downloads).
 *
 * Read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { listBackupBlobs, readBackupBlob } from "@/app/lib/backup-store";

export async function GET(req: NextRequest) {
  const inspect = req.nextUrl.searchParams.get("inspect") === "YES";
  try {
    const backups = await listBackupBlobs(); // newest first

    const summaries = await Promise.all(
      backups.map(async (b) => {
        const base = {
          pathname: b.pathname,
          url: b.url,
          sizeBytes: b.sizeBytes,
          uploadedAt: b.uploadedAt,
        };
        if (!inspect) return base;
        try {
          const snap = await readBackupBlob(b.pathname);
          return {
            ...base,
            backedUpAt: snap.backedUpAt,
            keyCount: snap.keyCount,
            totalBytes: snap.totalBytes,
            hasStocks: typeof snap.data?.["pm:stocks"] === "string",
            hasPimModels: typeof snap.data?.["pm:pim-models"] === "string",
            hasPimPositions: typeof snap.data?.["pm:pim-positions"] === "string",
          };
        } catch {
          return { ...base, status: "read-failed" };
        }
      }),
    );

    return NextResponse.json({ generatedAt: new Date().toISOString(), count: summaries.length, backups: summaries });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list backups" },
      { status: 500 },
    );
  }
}
