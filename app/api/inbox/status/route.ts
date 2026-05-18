import { NextResponse } from "next/server";
import { readInboxLog } from "@/app/lib/inbox-log";

/**
 * Read-only feed of recent ingestion events for the admin status page.
 * Returns up to the last 100 events (newest first), as written by the
 * /api/inbox/ingest webhook.
 */
export async function GET() {
  const events = await readInboxLog();
  const configured = Boolean(process.env.INBOX_SECRET);
  return NextResponse.json({ events, configured });
}
