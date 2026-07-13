import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { canonicalTicker } from "@/app/lib/ticker";
import { enqueueMail, wasWatchlistNotified, markWatchlistNotified } from "@/app/lib/mail-outbox";

/**
 * POST /api/watchlist-notify  { ticker }
 *
 * Fired (fire-and-forget) when a name is added to the Watchlist. Queues ONE
 * email to the analyst desk asking for RBC/JPM coverage on that name. The
 * subject is the report-ingest subject ("Analyst Report: <TICKER>"), so a
 * REPLY with the PDFs attached (named <TICKER>-RBC.pdf / <TICKER>_JPM.pdf)
 * flows back through the Gmail → /api/inbox/ingest pipeline and attaches the
 * reports to that exact ticker. De-duped so a name is only ever emailed once.
 *
 * Sends nothing itself — it enqueues to pm:mail-outbox, which the inbox Gmail
 * Apps Script drains. So it's a no-op-until-configured feature: if the Apps
 * Script outbox poller isn't deployed, the mail simply waits in the queue.
 */

const log = createLogger("WatchlistNotify");

// Where the request-for-coverage email goes. Overridable, defaults to the desk.
const NOTIFY_TO = process.env.WATCHLIST_NOTIFY_TO || "jordan.glazer@rbc.com";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ticker?: unknown };
    const rawTicker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    if (!rawTicker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const ticker = canonicalTicker(rawTicker).toUpperCase();
    if (!ticker) return NextResponse.json({ error: "invalid ticker" }, { status: 400 });

    // Idempotent — only ever email a given name once.
    if (await wasWatchlistNotified(ticker)) {
      return NextResponse.json({ queued: false, reason: "already-notified" });
    }

    const nowIso = new Date().toISOString();
    const subject = `Analyst Report: ${ticker}`;
    const text = [
      `${ticker} was just added to the watchlist.`,
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

    log.info(queued ? "queued coverage request for" : "already queued", ticker);
    return NextResponse.json({ queued });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
