/**
 * Nightly Redis backups now live in Vercel Blob, not Redis.
 *
 * WHY: backups stored as pm:backup:* inside Redis (a) died with Redis if it
 * was ever wiped/corrupted — so they weren't a real safety net — and (b)
 * competed with live data for the 250 MB tier, so a full Redis blocked the
 * backup write (the recurring OOM). In Blob they're durable off-Redis,
 * can't OOM the live data, and retention can be long (Blob is cheap).
 *
 * Layout: one JSON file per snapshot at `backups/<sanitized-iso>.json`, the
 * SAME { backedUpAt, keyCount, totalBytes, data:{key→value} } shape the
 * Redis backups used — so the restore logic is unchanged apart from where it
 * reads from. Age/retention use Blob's own `uploadedAt`, not the filename.
 */

import { put, list, del, get } from "@vercel/blob";
import { blobConfigured } from "./blob-store";

const PREFIX = "backups/";
const tok = () => process.env.BLOB_READ_WRITE_TOKEN;

export type BackupSnapshot = {
  backedUpAt: string;
  keyCount: number;
  totalBytes: number;
  data: Record<string, string>;
};

export type BackupInfo = {
  pathname: string;
  url: string;
  sizeBytes: number;
  uploadedAt: string; // ISO
};

/** Write a snapshot to Blob. `ts` is a filesystem-safe stamp (no :/.). */
export async function writeBackupBlob(snapshot: BackupSnapshot, ts: string): Promise<BackupInfo> {
  const json = JSON.stringify(snapshot);
  const pathname = `${PREFIX}${ts}.json`;
  const res = await put(pathname, json, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    token: tok(),
  });
  return { pathname: res.pathname, url: res.url, sizeBytes: Buffer.byteLength(json), uploadedAt: new Date().toISOString() };
}

/** List every backup in Blob, newest first. Paginates defensively. */
export async function listBackupBlobs(): Promise<BackupInfo[]> {
  if (!blobConfigured()) return [];
  const out: BackupInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ prefix: PREFIX, cursor, token: tok() });
    for (const b of res.blobs) {
      out.push({
        pathname: b.pathname,
        url: b.url,
        sizeBytes: b.size,
        uploadedAt: b.uploadedAt instanceof Date ? b.uploadedAt.toISOString() : String(b.uploadedAt),
      });
    }
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
  return out;
}

/** Read + parse a backup's full content from Blob. */
export async function readBackupBlob(pathname: string): Promise<BackupSnapshot> {
  const res = await get(pathname, { access: "private", token: tok() });
  if (!res || res.statusCode !== 200) throw new Error(`Backup not found: ${pathname}`);
  const text = await new Response(res.stream).text();
  return JSON.parse(text) as BackupSnapshot;
}

/** Delete backups older than `retentionDays` (by Blob uploadedAt). Returns
 *  the pathnames deleted. */
export async function pruneBackupBlobs(retentionDays: number): Promise<string[]> {
  const all = await listBackupBlobs();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const stale = all.filter((b) => Date.parse(b.uploadedAt) < cutoff);
  for (const b of stale) {
    try { await del(b.url, { token: tok() }); } catch { /* best-effort */ }
  }
  return stale.map((b) => b.pathname);
}
