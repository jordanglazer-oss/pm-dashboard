/**
 * Thin wrapper over Vercel Blob for the large binaries that used to live in
 * Redis (analyst-report PDFs, Brief/Research screenshot attachments). Redis
 * on the 250 MB Essentials tier kept OOMing because these multi-MB files
 * accumulated there; Blob is purpose-built file storage (cheap, effectively
 * unlimited), so Redis is left holding only small structured data + the Blob
 * URL references.
 *
 * Requires the BLOB_READ_WRITE_TOKEN env var (auto-added when a Blob store
 * is created in the Vercel dashboard). `blobConfigured()` lets callers
 * degrade gracefully when it's absent (e.g. local dev with no token).
 */

import { put, del, get } from "@vercel/blob";

export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Upload a base64 data URL (`data:<mime>;base64,<...>`) to Blob as a real
 * file with the right content-type, and return its URL. Throws if the token
 * is missing or the dataUrl is malformed — callers decide whether to swallow.
 *
 * Uses PRIVATE access (the store is configured private — authenticated reads
 * only, which suits sensitive analyst research / screenshots). Server-side
 * code reads these back with `get(pathname, { access: 'private' })`.
 *
 * By default the pathname is treated as STABLE: addRandomSuffix=false +
 * allowOverwrite=true, so re-uploading the same logical file (e.g. an analyst
 * report keyed by `<ticker>-<source>`) overwrites the same Blob slot instead
 * of leaving orphaned copies — mirroring how Redis SET on a fixed key behaved.
 * Pass { addRandomSuffix: true } for content that should get a fresh URL each
 * time (e.g. distinct screenshot attachments).
 */
export async function putDataUrl(
  pathname: string,
  dataUrl: string,
  opts?: { addRandomSuffix?: boolean },
): Promise<string> {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) {
    throw new Error("putDataUrl: not a data URL");
  }
  const header = dataUrl.slice(5, comma); // e.g. "application/pdf;base64"
  const contentType = header.split(";")[0] || "application/octet-stream";
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const addRandomSuffix = opts?.addRandomSuffix ?? false;
  const { url } = await put(pathname, bytes, {
    access: "private",
    contentType,
    addRandomSuffix,
    allowOverwrite: !addRandomSuffix,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return url;
}

/**
 * Read a private Blob back as a base64 data URL (the shape the AI vision /
 * document blocks and the legacy attachment readers expect). Returns null if
 * the blob doesn't exist — callers fall back to the legacy Redis copy during
 * the migration window. `ref` may be a pathname (e.g. "attachments/<id>") or
 * a full Blob URL.
 */
export async function getDataUrl(ref: string): Promise<string | null> {
  if (!blobConfigured()) return null;
  try {
    const res = await get(ref, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    const buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    const contentType = res.blob.contentType || "application/octet-stream";
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Best-effort delete of a Blob by pathname OR URL. Never throws (an orphaned
 *  blob is harmless and cheap; we don't want cleanup to break a delete flow). */
export async function deleteBlob(pathnameOrUrl: string): Promise<void> {
  try {
    if (!blobConfigured()) return;
    await del(pathnameOrUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch {
    // ignore
  }
}
