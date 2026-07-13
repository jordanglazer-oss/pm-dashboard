import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { enqueueMail } from "@/app/lib/mail-outbox";

/**
 * POST /api/provider-request  { provider, symbols }
 *
 * Fired (fire-and-forget) when the PM exports the watchlist for an external
 * provider (BoostedAI CSV download, SIA copy, MarketEdge copy). Queues an email
 * FROM the inbox Gmail (via the outbox → processOutbox) TO the PM's inbox, with
 * that provider's ingest subject prefix. The PM then just REPLIES to it with the
 * provider's data attached — no need to draft a fresh email — and the reply
 * threads back to the Gmail where processInbox forwards it to /api/inbox/ingest
 * and applies the data. Sends nothing itself; no-op-until the outbox poller runs.
 */

const log = createLogger("ProviderRequest");

// Where the reply-shell email goes (the PM replies from here). Overridable.
const REQUEST_TO = process.env.PROVIDER_REQUEST_TO || "jordan.glazer@icloud.com";

// Subject prefixes MUST match the inbox pipeline's classifiers (processInbox
// regex + /api/inbox/ingest classifySubject) so the reply routes to the right
// handler. `attach` describes exactly what to reply with.
const PROVIDERS: Record<string, { subject: string; attach: string }> = {
  boostedai: { subject: "BoostedAI watchlist", attach: "your Boosted.ai unified-data CSV (or a watchlist screenshot)" },
  sia: { subject: "SIA", attach: "your SIA CSV export (or a SIA watchlist screenshot)" },
  marketedge: { subject: "MarketEdge", attach: "your ChartScout “Likes” CSV export" },
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { provider?: unknown; symbols?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.toLowerCase() : "";
    const cfg = PROVIDERS[provider];
    if (!cfg) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

    const symbols = Array.isArray(body.symbols)
      ? body.symbols.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim())
      : [];

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const subject = `${cfg.subject} — ${date}`;
    const text = [
      `Reply to THIS email with ${cfg.attach} attached and it'll import to the dashboard automatically — no need to draft a new email, and keep the subject as-is (a normal "Re:" is fine).`,
      ``,
      symbols.length
        ? `${symbols.length} name${symbols.length === 1 ? "" : "s"} exported:\n${symbols.join(", ")}`
        : `(No watchlist names were in the export.)`,
    ].join("\n");

    // Minute-grained id: dedupes an accidental double-click, but a genuine
    // re-export later gets its own fresh reply-shell.
    const stamp = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    const queued = await enqueueMail({ id: `provider-${provider}-${stamp}`, to: REQUEST_TO, subject, text, queuedAt: now.toISOString() });

    log.info(queued ? "queued request for" : "already queued", provider, `(${symbols.length} symbols)`);
    return NextResponse.json({ queued });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
