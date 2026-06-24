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

import { put, del } from "@vercel/blob";

export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Upload a base64 data URL (`data:<mime>;base64,<...>`) to Blob as a real
 * file with the right content-type, and return its public URL. Throws if the
 * token is missing or the dataUrl is malformed — callers decide whether to
 * swallow.
 *
 * By default the pathname is treated as STABLE: addRandomSuffix=false +
 * allowOverwrite=true, so re-uploading the same logical file (e.g. an analyst
 * report keyed by `<ticker>-<source>`) overwrites the same Blob slot instead
 * of leaving orphaned copies — mirroring how Redis SET on a fixed key behaved.
 * Pass { addRandomSuffix: true } for content that should get a fresh
 * unguessable URL each time (e.g. distinct screenshot attachments).
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
    access: "public",
    contentType,
    addRandomSuffix,
    allowOverwrite: !addRandomSuffix,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return url;
}

/** Fetch a Blob URL back as a base64 data URL (the shape the AI vision /
 *  document blocks and the legacy readers expect). */
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blob fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

/** Best-effort delete of a Blob by URL. Never throws (an orphaned blob is
 *  harmless and cheap; we don't want cleanup to break a delete flow). */
export async function deleteBlob(url: string): Promise<void> {
  try {
    if (!blobConfigured()) return;
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch {
    // ignore
  }
}
