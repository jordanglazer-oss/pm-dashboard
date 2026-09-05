import { createLogger } from "./logger";
import { canonicalTicker } from "./ticker";
import { enqueueMail, wasWatchlistNotified, markWatchlistNotified } from "./mail-outbox";

/**
 * Queue ONE "request RBC/JPM coverage" email for a ticker to the analyst desk.
 *
 * Shared by /api/watchlist-notify (Watchlist adds) and the Suggested Watchlist
 * refresh (names newly entering the Suggested stage), so both paths dedupe
 * against the same pm:watchlist-notified map — a name is emailed once, ever,
 * whichever stage asked first.
 *
 * Sends nothing itself: it enqueues to pm:mail-outbox, which the inbox Gmail
 * Apps Script drains (processOutbox). Until that poller is deployed the mail
 * simply waits in the queue. The subject is the report-ingest subject
 * ("Analyst Report: <TICKER>") so a REPLY with the PDFs attached files them
 * to that ticker automatically.
 */

const log = createLogger("CoverageRequest");

// Where the request-for-coverage email goes. Overridable, defaults to the desk.
const NOTIFY_TO = process.env.WATCHLIST_NOTIFY_TO || "jordan.glazer@rbc.com";

export type CoverageReason = "watchlist" | "suggested";

export async function requestCoverage(
  rawTicker: string,
  reason: CoverageReason = "watchlist",
): Promise<{ queued: boolean; reason: "queued" | "already-notified" | "already-queued" | "invalid" }> {
  const ticker = canonicalTicker(rawTicker).toUpperCase();
  if (!ticker) return { queued: false, reason: "invalid" };

  // Idempotent — only ever email a given name once.
  if (await wasWatchlistNotified(ticker)) return { queued: false, reason: "already-notified" };

  const nowIso = new Date().toISOString();
  const subject = `Analyst Report: ${ticker}`;
  const intro =
    reason === "suggested"
      ? `${ticker} just entered the Suggested Watchlist (on 2+ research lists).`
      : `${ticker} was just added to the watchlist.`;
  const text = [
    intro,
    ``,
    `Reply to THIS email with the RBC and/or JPM analyst report PDF(s) attached and`,
    `they'll be filed to ${ticker} automatically. Name each file so the source is clear:`,
    ``,
    `    ${ticker}-RBC.pdf     (RBC coverage)`,
    `    ${ticker}-JPM.pdf     (JPM coverage)`,
    ``,
    `You can attach both in one reply. The dashboard reads the ticker from this`,
    `subject line and the firm from each filename, so keep the "Analyst Report: ${ticker}"`,
    `subject intact (a normal "Re:" reply is fine).`,
  ].join("\n");

  const queued = await enqueueMail({ id: `wl-${ticker}`, to: NOTIFY_TO, subject, text, queuedAt: nowIso });
  await markWatchlistNotified(ticker, nowIso);
  log.info(queued ? `queued coverage request (${reason}) for` : "already queued", ticker);
  return { queued, reason: queued ? "queued" : "already-queued" };
}
