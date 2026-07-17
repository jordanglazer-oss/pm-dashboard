# Gmail → Dashboard webhook (Apps Script)

This script watches `dfwreports123@gmail.com` and forwards email attachments
to the dashboard's `/api/inbox/ingest` endpoint. Every email subject matching
one of the supported prefixes gets routed automatically — the dashboard
handles the rest.

## Subject prefixes

| Prefix | What to send | Lands in |
|---|---|---|
| `Analyst Report: <TICKER>` — firm comes from the **PDF filename**, e.g. `AVGO_RBC.pdf` / `AVGO_JPM.pdf` | PDF (one or several per email) | Per-ticker analyst snapshot, routed to the RBC or JPM slot per filename |
| `SIA …` | **CSV export (preferred)** or screenshot (PNG/JPG/PDF) | Each matched stock's SIA SMAX + score. CSV is auto-detected — same subject either way. |
| `BoostedAI …` *or* `Boosted …` | **Boosted.ai unified-data CSV (preferred)** or watchlist screenshot (PNG/JPG/PDF) | Each matched stock's BoostedAI rating + consensus + score. CSV is auto-detected — same subject either way. |
| `MarketEdge …` *or* `ChartScout …` | ChartScout Likes export (CSV) | Each matched stock's `marketEdge` fields + composite score |
| `Strategist …` | Any analyst/strategist research (PDF or image) | Brief's "Analyst / Strategist Reports" dropbox |
| `Fundstrat Top` / `Fundstrat Bottom` / `Fundstrat SMID Top` / `Fundstrat SMID Bottom` | Screenshot (PNG/JPG/PDF) | Respective Fundstrat list on the Research tab |
| `Fundstrat Large-Cap Core` / `Fundstrat SMID Core` | Screenshot (PNG/JPG/PDF) of the DQM quant screen (Ticker, Company, Sector, Industry, Mkt Cap, 1M/YTD relative perf, P/E, DQM Rank, Momentum Rating, trend columns) | Respective Fundstrat "Core Ideas" list on the Research tab |
| `RBC Canadian` / `RBC US` | Screenshot (PNG/JPG/PDF) | RBC Canadian / US Focus List |
| `RBCCM FEW` | Screenshot (PNG/JPG/PDF) | RBCCM Canadian FEW Portfolio |
| `Seeking Alpha …` *or* `Alpha Picks …` | Screenshot (PNG/JPG/PDF) | Seeking Alpha — Alpha Picks list |

iPhone, Mac, and Windows screenshots all work (iOS Mail auto-converts HEIC to
JPG when emailing). The subject match is case-insensitive.

Examples:
- `SIA — Mar 5`
- `BoostedAI watchlist`
- `MarketEdge weekly`
- `Strategist note from Newton`
- `Fundstrat Top — week of Mar 5`
- `RBC Canadian focus update`
- `Alpha Picks weekly`

## Setup

1. Open <https://script.google.com> while signed in as `dfwreports123@gmail.com`.
2. Create a new project (or open the existing one used for the Analyst Report flow).
3. Replace `Code.gs` with the script below.
4. Set the two script properties (Project Settings → Script properties):
   - `WEBHOOK_URL` = `https://pm-dashboard-7rr9.vercel.app/api/inbox/ingest`
   - `INBOX_SECRET` = the same value as the Vercel `INBOX_SECRET` env var
5. Add ONE time-driven trigger that runs **`processAll`** every 5 minutes — it
   runs both directions (inbound ingest + outbound send) so nothing needs to be
   run by hand. `WEBHOOK_URL` stays pointed at `/api/inbox/ingest`; the script
   derives the `/api/inbox/outbox` URL from it.
   (Equivalent alternative: two separate triggers, one on `processInbox` and one
   on `processOutbox` — but a single `processAll` trigger is simpler.)
6. Authorize the script when prompted.

## Outbound: watchlist coverage requests (two-way loop)

When a name is added to the Watchlist, the dashboard queues an email (drained by
`processOutbox`) to the analyst desk with subject **`Analyst Report: <TICKER>`**
asking for RBC/JPM coverage. Because it's sent from this Gmail, a **reply** with
the report PDFs attached lands right back in this inbox; `processInbox` forwards
it to `/api/inbox/ingest` and the reports file to that ticker — same pipeline as
a manually-sent report email. The subject regex now tolerates a leading `Re:`,
so the reply's `Re: Analyst Report: <TICKER>` subject still routes. Name the
files so the firm is clear, e.g. `AVGO-RBC.pdf` / `AVGO_JPM.pdf`.

Recipient defaults to `jordan.glazer@rbc.com` (override with the Vercel env var
`WATCHLIST_NOTIFY_TO`). Alert digests go to `ALERT_EMAIL_TO` when set.

## Script

```javascript
/**
 * Convenience wrapper — run BOTH directions on one trigger. Point a single
 * 5-minute time-driven trigger at `processAll` and you get automatic inbound
 * (incoming reports/CSVs → dashboard) AND outbound (queued emails sent from
 * this Gmail) without running anything by hand. Each half is independent, so a
 * failure in one still lets the other run.
 */
function processAll() {
  try { processInbox(); } catch (e) { Logger.log("processInbox EX " + e); }
  try { processOutbox(); } catch (e) { Logger.log("processOutbox EX " + e); }
  try { pingIntradayMonitor(); } catch (e) { Logger.log("pingIntradayMonitor EX " + e); }
  try { pingAutoRescore(); } catch (e) { Logger.log("pingAutoRescore EX " + e); }
  try { pingFactorUniverse(); } catch (e) { Logger.log("pingFactorUniverse EX " + e); }
}

/**
 * Factor-universe build pacer. Pings every run; the endpoint self-gates (only
 * builds when never-built / stale >6.5d / Sunday) and processes one 40s
 * resumable chunk per ping, so a full ~560-name weekly rebuild completes
 * across a handful of pings and costs nothing the rest of the week.
 */
function pingFactorUniverse() {
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty("WEBHOOK_URL"); // .../api/inbox/ingest
  const secret = props.getProperty("INBOX_SECRET");
  if (!base || !secret) return;
  const url = base.replace(/\/api\/inbox\/ingest\/?$/, "/api/cron/factor-universe");
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + secret },
    muteHttpExceptions: true,
  });
  Logger.log("factor-universe " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
}

/**
 * Event-driven auto-rescore pacer. Pings on EVERY 5-minute run — the endpoint
 * itself gates to the 19:00–23:00 ET window, processes at most ONE rescore per
 * ping, and enforces a 5/day cap. The only live trigger is analyst-reports
 * INGESTED → full rescore (the revision-swing partial trigger is currently
 * disabled dashboard-side). Also sends the earnings-day report-request email.
 * Outside the window or with nothing queued it returns instantly.
 */
function pingAutoRescore() {
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty("WEBHOOK_URL"); // .../api/inbox/ingest
  const secret = props.getProperty("INBOX_SECRET");
  if (!base || !secret) return;
  const url = base.replace(/\/api\/inbox\/ingest\/?$/, "/api/cron/auto-rescore");
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + secret },
    muteHttpExceptions: true,
  });
  Logger.log("auto-rescore " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
}

/**
 * Intraday monitor ping — the 5-minute trigger doubles as a free hourly cron.
 * Only actually calls the dashboard in the first ~5 minutes of each hour (so
 * ~once/hour); the endpoint itself gates to US market hours and returns fast
 * otherwise. Trips (200-DMA breaks, big drops, VIX spikes) are emailed via the
 * same outbox this script already drains.
 */
function pingIntradayMonitor() {
  if (new Date().getMinutes() >= 5) return; // hourly gate on the 5-min trigger
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty("WEBHOOK_URL"); // .../api/inbox/ingest
  const secret = props.getProperty("INBOX_SECRET");
  if (!base || !secret) return;
  const url = base.replace(/\/api\/inbox\/ingest\/?$/, "/api/cron/intraday-monitor");
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + secret },
    muteHttpExceptions: true,
  });
  Logger.log("intraday-monitor " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
}

/**
 * Gmail → pm-dashboard webhook.
 *
 * Each call processes new threads in the inbox whose subject matches one
 * of the supported prefixes (Analyst Report / SIA / BoostedAI / Boosted /
 * MarketEdge / ChartScout / Strategist). Every attachment is POSTed to
 * /api/inbox/ingest as { subject, sender, filename, dataUrl }. After a
 * successful POST the thread is labeled "Dashboard-Processed" so the next
 * run skips it.
 */

function processInbox() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty("WEBHOOK_URL");
  const secret = props.getProperty("INBOX_SECRET");
  if (!url || !secret) {
    Logger.log("WEBHOOK_URL or INBOX_SECRET not set in script properties.");
    return;
  }

  // Order matters: more-specific prefixes first ("Fundstrat SMID Top"
  // before "Fundstrat Top") so regex alternation matches correctly.
  const SUBJECT_RE = /^(?:(?:re|fwd?|fw):\s*)*(Analyst Report:|Fundstrat Large-Cap Core|Fundstrat SMID Core|Fundstrat SMID Top|Fundstrat SMID Bottom|Fundstrat Top|Fundstrat Bottom|RBC Canadian|RBC US|RBCCM FEW|Seeking Alpha|Alpha Picks|SIA\b|BoostedAI\b|Boosted\b|MarketEdge\b|ChartScout\b|Strategist\b)/i;
  const PROCESSED_LABEL_NAME = "Dashboard-Processed";

  let label = GmailApp.getUserLabelByName(PROCESSED_LABEL_NAME);
  if (!label) label = GmailApp.createLabel(PROCESSED_LABEL_NAME);

  // -label:Dashboard-Processed → skip what we've already sent.
  const threads = GmailApp.search(`in:inbox -label:${PROCESSED_LABEL_NAME} newer_than:14d`);
  for (const thread of threads) {
    const messages = thread.getMessages();
    let anySuccess = false;
    for (const msg of messages) {
      const subject = (msg.getSubject() || "").trim();
      if (!SUBJECT_RE.test(subject)) continue;
      const sender = msg.getFrom();
      // includeInlineImages: true picks up pasted/embedded screenshots
      // (Outlook generates these as image001.png inline parts), which is
      // a common way people email screenshots. The route's MIME validation
      // rejects anything that doesn't match the kind, so inline logos in
      // analyst-report email signatures fail harmlessly with a logged
      // 400 — they don't corrupt anything.
      const attachments = msg.getAttachments({ includeInlineImages: true, includeAttachments: true });
      for (const att of attachments) {
        try {
          const dataUrl = "data:" + att.getContentType() + ";base64," + Utilities.base64Encode(att.getBytes());
          const payload = {
            subject,
            sender,
            filename: att.getName(),
            dataUrl,
          };
          const response = UrlFetchApp.fetch(url, {
            method: "post",
            contentType: "application/json",
            headers: { Authorization: "Bearer " + secret },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true,
          });
          const code = response.getResponseCode();
          if (code >= 200 && code < 300) {
            anySuccess = true;
            Logger.log("OK " + code + " " + subject + " :: " + att.getName());
          } else {
            Logger.log("ERR " + code + " " + subject + " :: " + att.getName() + " :: " + response.getContentText().slice(0, 300));
          }
        } catch (e) {
          Logger.log("EX " + subject + " :: " + att.getName() + " :: " + e);
        }
      }
    }
    if (anySuccess) {
      thread.addLabel(label);
    }
  }
}

/**
 * Outbound drain — sends mail the dashboard queued (watchlist coverage
 * requests, alert digests) FROM this Gmail, so replies thread back into this
 * inbox and processInbox() forwards them to the ingest webhook. Add this to
 * the same 5-minute trigger as processInbox (or its own).
 */
function processOutbox() {
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty("WEBHOOK_URL");     // .../api/inbox/ingest
  const secret = props.getProperty("INBOX_SECRET");
  if (!base || !secret) { Logger.log("WEBHOOK_URL or INBOX_SECRET not set."); return; }
  // The outbox lives next to ingest: swap the trailing path segment.
  const outboxUrl = base.replace(/\/ingest\/?$/, "/outbox");

  const res = UrlFetchApp.fetch(outboxUrl, {
    method: "get",
    headers: { Authorization: "Bearer " + secret },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) { Logger.log("outbox GET " + res.getResponseCode()); return; }
  const mails = (JSON.parse(res.getContentText()).mails) || [];
  if (!mails.length) return;

  const sentIds = [];
  for (const m of mails) {
    try {
      GmailApp.sendEmail(m.to, m.subject, m.text);
      sentIds.push(m.id);
      Logger.log("SENT " + m.subject + " -> " + m.to);
    } catch (e) {
      Logger.log("SEND EX " + m.subject + " :: " + e);
    }
  }
  if (sentIds.length) {
    UrlFetchApp.fetch(outboxUrl, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + secret },
      payload: JSON.stringify({ sentIds: sentIds }),
      muteHttpExceptions: true,
    });
  }
}

/** Health-check the webhook without sending data — call from the IDE during setup. */
function testWebhook() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty("WEBHOOK_URL");
  const secret = props.getProperty("INBOX_SECRET");
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + secret },
    payload: JSON.stringify({ ping: true }),
    muteHttpExceptions: true,
  });
  Logger.log(response.getResponseCode() + " " + response.getContentText());
}

/** One-off re-import. Re-forwards every matching attachment from the last
 *  `days` days of the inbox, EVEN IF the thread was already labeled
 *  Dashboard-Processed. Use after a dashboard-side fix when you need the
 *  last few CSVs re-applied. Does NOT touch labels and is safe to run more
 *  than once (the dashboard's CSV imports are idempotent — same value in =
 *  same value out). Self-contained: defines its own subject regex so it
 *  works no matter where SUBJECT_RE lives. */
function reprocessRecent() {
  var DAYS = 3; // widen if your CSVs are older than this
  var SUBJECT_RE = /^(?:(?:re|fwd?|fw):\s*)*(Analyst Report:|Fundstrat Large-Cap Core|Fundstrat SMID Core|Fundstrat SMID Top|Fundstrat SMID Bottom|Fundstrat Top|Fundstrat Bottom|RBC Canadian|RBC US|RBCCM FEW|Seeking Alpha|Alpha Picks|SIA\b|BoostedAI\b|Boosted\b|MarketEdge\b|ChartScout\b|Strategist\b)/i;
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("WEBHOOK_URL");
  var secret = props.getProperty("INBOX_SECRET");
  if (!url || !secret) { Logger.log("WEBHOOK_URL or INBOX_SECRET missing."); return; }
  var threads = GmailApp.search("in:inbox newer_than:" + DAYS + "d");
  Logger.log("reprocessRecent: scanning " + threads.length + " threads from the last " + DAYS + " days.");
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var subject = (msg.getSubject() || "").trim();
      if (!SUBJECT_RE.test(subject)) continue;
      var sender = msg.getFrom();
      var attachments = msg.getAttachments({ includeInlineImages: true, includeAttachments: true });
      for (var a = 0; a < attachments.length; a++) {
        var att = attachments[a];
        try {
          var dataUrl = "data:" + att.getContentType() + ";base64," + Utilities.base64Encode(att.getBytes());
          var response = UrlFetchApp.fetch(url, {
            method: "post",
            contentType: "application/json",
            headers: { Authorization: "Bearer " + secret },
            payload: JSON.stringify({ subject: subject, sender: sender, filename: att.getName(), dataUrl: dataUrl }),
            muteHttpExceptions: true,
          });
          Logger.log("  " + response.getResponseCode() + " " + subject + " :: " + att.getName());
        } catch (e) {
          Logger.log("  EX " + subject + " :: " + att.getName() + " :: " + e);
        }
      }
    }
  }
  Logger.log("reprocessRecent done.");
}
```

## Re-importing the last few emails (`reprocessRecent`)

The normal `processInbox` skips any thread it has already labeled
`Dashboard-Processed`, so it will not re-send a CSV you emailed earlier. When
a dashboard-side fix means those CSVs need to be re-applied, run
`reprocessRecent()` from the Apps Script editor (Run ▸ reprocessRecent). It
re-forwards every matching attachment from the last few days regardless of
the label, without removing any labels.

**Do it without losing the import:** the dashboard loads your holdings once
when a tab opens, so an already-open tab can overwrite a fresh import with
its older copy. Before re-importing, **close every open dashboard tab**, run
`reprocessRecent()`, confirm the Inbox → Activity log shows the re-imports,
then open a **fresh** dashboard tab.

## Verifying it works

1. Send yourself an email with subject `SIA test` and a SIA watchlist screenshot attached.
2. Within 5 minutes (the trigger cadence), the dashboard's **Inbox tab → Activity log** should show a "success" row for that email.
3. Open one of the matched stocks → SIA SMAX should be updated, score recomputed, the per-stock chip cleared.

If something doesn't land, the Apps Script Logs (View → Executions) show the exact HTTP code and response from the webhook, and the dashboard's Inbox activity log shows the error message.

## Troubleshooting

- **401 Unauthorized** — `INBOX_SECRET` in the script doesn't match Vercel's env var. Update one to match the other.
- **400 "SIA email expects an image or PDF attachment"** — the email had a non-image attachment (e.g., a `.doc`). Skip it or convert to a screenshot.
- **400 "MarketEdge email expects a CSV attachment"** — the email had a screenshot instead of a CSV export. Re-export from MarketEdge as CSV.
- **A run only processes a few names** — Apps Script free-tier triggers are limited to ~6 min per run. Forward emails in smaller batches if you accumulate many in one day.
