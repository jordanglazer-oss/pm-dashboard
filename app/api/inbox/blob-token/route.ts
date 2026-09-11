import { NextRequest, NextResponse } from "next/server";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";

/**
 * POST /api/inbox/blob-token   (Authorization: Bearer $INBOX_SECRET)
 * Body: { pathname: string, contentType?: string }
 *
 * Mints a SHORT-LIVED, PATH-SCOPED Vercel Blob upload token so the Gmail
 * Apps Script can upload a large PDF DIRECTLY to Blob — bypassing the 4.5 MB
 * Vercel function request-body limit that blocks big attachments through
 * /api/inbox/ingest. The token can only write the one `pathname` (must be
 * under inbox-staging/) and expires in 5 minutes, so it's safe to hand to the
 * script. After upload the script calls /api/inbox/ingest with the pathname;
 * the server reads the file back from Blob and processes it normally.
 *
 * Exempted from the cookie middleware (bearer-authenticated) alongside
 * /api/inbox/ingest.
 */

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.INBOX_SECRET || auth !== `Bearer ${process.env.INBOX_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Blob not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const pathname = typeof body?.pathname === "string" ? body.pathname : "";
  // Constrain to a staging prefix so a leaked token can't overwrite live blobs.
  if (!/^inbox-staging\/[A-Za-z0-9._-]+$/.test(pathname)) {
    return NextResponse.json({ error: "pathname must match inbox-staging/<id>" }, { status: 400 });
  }

  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      pathname,
      addRandomSuffix: false,
      allowOverwrite: true,
      validUntil: Date.now() + 5 * 60 * 1000,
    });
    return NextResponse.json({
      clientToken,
      // The Blob API wants the store id as its own header on every write
      // (x-vercel-blob-store-id) — @vercel/blob's requestApi sends it for
      // every auth kind, client tokens included. Parsed the same way the SDK
      // does: "vercel_blob_rw_<storeId>_<secret>".
      storeId: process.env.BLOB_READ_WRITE_TOKEN.split("_")[3] ?? "",
      // The Blob UPLOAD endpoint (not the storage host): a PUT to the API URL
      // with the pathname as a query param, mirroring what @vercel/blob's
      // put() does internally (requestApi(`/?pathname=...`)).
      uploadUrl: `https://vercel.com/api/blob/?pathname=${encodeURIComponent(pathname)}`,
      apiVersion: 12, // Vercel Blob upload API version the script must send.
      // Sent by the uploader as x-vercel-blob-access. MUST stay "private":
      // the ingest route hydrates the staged file with get({ access:
      // "private" }), which cannot read a blob written as public.
      access: "private",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to mint token" }, { status: 500 });
  }
}
