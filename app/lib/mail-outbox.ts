import { getRedis } from "./redis";
import { createLogger } from "./logger";

/**
 * Outbound-email outbox — the "send via the inbox Gmail" bridge.
 *
 * The app can't send mail directly (no SMTP creds in the app), but the Gmail
 * Apps Script already polls the app every 5 min with a Bearer secret. So
 * outbound mail is QUEUED here and the same Apps Script drains it via
 * GET/POST /api/inbox/outbox, sending each one with GmailApp.sendEmail — i.e.
 * FROM the inbox Gmail, so a reply threads straight back into that inbox and
 * the existing forward-to-ingest flow feeds it to the right ticker.
 *
 * Keys (both NEW, small, operational — safe to nuke; worst case a queued
 * notification is lost or a name is re-emailed once):
 *   pm:mail-outbox        — array of pending OutboundMail (drained on send)
 *   pm:watchlist-notified — { [ticker]: iso } dedupe so a name emails ONCE
 */

const log = createLogger("MailOutbox");

const OUTBOX_KEY = "pm:mail-outbox";
const NOTIFIED_KEY = "pm:watchlist-notified";
const MAX_QUEUE = 200; // backstop so a stuck drain can't grow unbounded

export type OutboundMail = {
  id: string; // caller-chosen → idempotent enqueue (e.g. "wl-AVGO", "digest-2026-07-12")
  to: string;
  subject: string;
  text: string;
  queuedAt: string;
};

function parseList(raw: string | null): OutboundMail[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as OutboundMail[]) : [];
  } catch {
    return [];
  }
}

/**
 * Queue a mail. Idempotent by `id`: a second enqueue with an id already
 * pending is a no-op. Returns true if newly queued, false if it was a dupe.
 */
export async function enqueueMail(mail: OutboundMail): Promise<boolean> {
  const redis = await getRedis();
  const list = parseList(await redis.get(OUTBOX_KEY));
  if (list.some((m) => m.id === mail.id)) return false;
  const next = [...list, mail].slice(-MAX_QUEUE);
  await redis.set(OUTBOX_KEY, JSON.stringify(next));
  return true;
}

export async function readPendingMail(): Promise<OutboundMail[]> {
  const redis = await getRedis();
  return parseList(await redis.get(OUTBOX_KEY));
}

/** Remove the given ids from the outbox (called after the Apps Script sends). */
export async function markMailSent(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const redis = await getRedis();
  const list = parseList(await redis.get(OUTBOX_KEY));
  const drop = new Set(ids);
  const next = list.filter((m) => !drop.has(m.id));
  await redis.set(OUTBOX_KEY, JSON.stringify(next));
  return list.length - next.length;
}

/** True once we've queued a watchlist email for this ticker (dedupe). */
export async function wasWatchlistNotified(ticker: string): Promise<boolean> {
  const redis = await getRedis();
  try {
    const raw = await redis.get(NOTIFIED_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return !!map[ticker.toUpperCase()];
  } catch {
    return false;
  }
}

/** Mark a ticker as notified (read-modify-write, preserves other entries). */
export async function markWatchlistNotified(ticker: string, iso: string): Promise<void> {
  const redis = await getRedis();
  let map: Record<string, string> = {};
  try {
    const raw = await redis.get(NOTIFIED_KEY);
    if (raw) map = JSON.parse(raw) as Record<string, string>;
  } catch {
    map = {};
  }
  map[ticker.toUpperCase()] = iso;
  await redis.set(NOTIFIED_KEY, JSON.stringify(map));
  log.info("watchlist-notified", ticker);
}
