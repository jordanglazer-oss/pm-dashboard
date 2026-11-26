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
 * EMAIL PAUSE (PM's request, 2026-11-26): every notification email is held
 * except the ones listed in STILL_SENT. Set EMAILS_PAUSED to false to send
 * everything again. A held email is simply not queued — nothing else changes:
 * flags, digests, memos and reports are still written and shown in the app.
 * Being an allow-list, any NEW kind of email is held too until it is added.
 */
export const EMAILS_PAUSED = true;
const STILL_SENT = [
  "intraday-", // intraday price-move alerts — the PM asked to keep these
  "backup-failed-", // safety alarm: the nightly backup did not run
  "backup-stale-", // safety alarm: no backup for over 30 hours
  "provider-", // a request the PM sends by pressing a button, not a notification
];

/** True when this mail is held by the pause (decided by its id prefix). */
export function isMailPaused(id: string): boolean {
  return EMAILS_PAUSED && !STILL_SENT.some((p) => id.startsWith(p));
}

/**
 * Queue a mail. Idempotent by `id`: a second enqueue with an id already
 * pending is a no-op. Returns true if newly queued, false if it was a dupe
 * or is held by the email pause.
 */
export async function enqueueMail(mail: OutboundMail): Promise<boolean> {
  if (isMailPaused(mail.id)) {
    log.info("held by the email pause:", mail.id);
    return false;
  }
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

/** The whole ticker → ISO-queued-at dedupe map (one read, for list views). */
export async function readWatchlistNotifiedMap(): Promise<Record<string, string>> {
  try {
    const raw = await (await getRedis()).get(NOTIFIED_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
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
