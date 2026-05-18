import { NextResponse } from "next/server";
import { readInboxLog } from "@/app/lib/inbox-log";

/**
 * Read-only feed of recent ingestion events for the admin status page.
 * Returns up to the last 100 events (newest first), as written by the
 * /api/inbox/ingest webhook.
 *
 * `force-dynamic` opts out of Next.js's default route-level caching so
 * every GET re-reads the inbox log from Redis. Without this, Next would
 * serve a stale cached snapshot for up to the cache duration and the
 * Refresh button on the inbox page would appear to do nothing even though
 * the log had new entries.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const events = await readInboxLog();
  const configured = Boolean(process.env.INBOX_SECRET);
  return NextResponse.json({ events, configured });
}
