import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { readPendingMail, markMailSent } from "@/app/lib/mail-outbox";

/**
 * Outbound-mail drain for the Gmail Apps Script (the "send via inbox Gmail"
 * bridge). Same Bearer <INBOX_SECRET> auth as /api/inbox/ingest.
 *
 *   GET  → { mails: [{ id, to, subject, text }] }  — pending outbound mail
 *   POST { sentIds: string[] } → { cleared }       — drop the ones just sent
 *
 * The Apps Script polls GET on its existing 5-min trigger, sends each via
 * GmailApp.sendEmail (FROM the inbox Gmail, so replies thread back), then
 * POSTs the ids it sent so they're removed from the queue.
 */

const log = createLogger("Outbox");

function authorized(req: NextRequest): boolean {
  const secret = process.env.INBOX_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!process.env.INBOX_SECRET) {
    return NextResponse.json({ error: "Inbox secret not configured" }, { status: 503 });
  }
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const mails = await readPendingMail();
    // The Apps Script only needs the fields it sends with.
    return NextResponse.json({
      mails: mails.map((m) => ({ id: m.id, to: m.to, subject: m.subject, text: m.text })),
    });
  } catch (e) {
    log.error("GET failed:", e);
    return NextResponse.json({ mails: [] });
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.INBOX_SECRET) {
    return NextResponse.json({ error: "Inbox secret not configured" }, { status: 503 });
  }
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { sentIds?: unknown };
    const ids = Array.isArray(body.sentIds) ? body.sentIds.filter((x): x is string => typeof x === "string") : [];
    const cleared = await markMailSent(ids);
    return NextResponse.json({ cleared });
  } catch (e) {
    log.error("POST failed:", e);
    return NextResponse.json({ cleared: 0 }, { status: 400 });
  }
}
