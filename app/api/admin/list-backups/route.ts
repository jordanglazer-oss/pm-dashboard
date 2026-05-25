/**
 * GET /api/admin/list-backups
 *
 * Lists every pm:backup:* snapshot currently in Redis, with the
 * backedUpAt timestamp, byte size, and key count for each. Used to
 * pick a known-good backup to restore from when something has
 * corrupted live blobs.
 *
 * Read-only.
 */

import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type BackupBlob = {
  backedUpAt?: string;
  keyCount?: number;
  totalBytes?: number;
  data?: Record<string, unknown>;
};

export async function GET() {
  try {
    const redis = await getRedis();
    // Scan for all pm:backup:* keys. Upstash redis client supports
    // .keys() — small list (≤14 entries since the backup cron prunes
    // past 14 days), no pagination needed.
    const keys = (await redis.keys("pm:backup:*")) as string[];
    keys.sort(); // dates sort lexically
    const summaries = await Promise.all(
      keys.map(async (key) => {
        const raw = await redis.get(key);
        if (!raw) return { key, status: "empty" };
        try {
          const parsed = JSON.parse(raw) as BackupBlob;
          // Sanity check the critical blobs we care about so the user
          // can pick a backup that actually has them populated.
          const hasPositions = typeof parsed.data?.["pm:pim-positions"] === "string";
          const hasModels = typeof parsed.data?.["pm:pim-models"] === "string";
          const hasStocks = typeof parsed.data?.["pm:stocks"] === "string";
          return {
            key,
            backedUpAt: parsed.backedUpAt,
            keyCount: parsed.keyCount,
            totalBytes: parsed.totalBytes,
            blobBytes: raw.length,
            hasPimPositions: hasPositions,
            hasPimModels: hasModels,
            hasStocks: hasStocks,
          };
        } catch {
          return { key, status: "parse-failed", blobBytes: raw.length };
        }
      }),
    );
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      backups: summaries,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list backups" },
      { status: 500 },
    );
  }
}
