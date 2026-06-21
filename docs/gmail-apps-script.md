# Gmail → Dashboard webhook (Apps Script)

This script watches `dfwreports123@gmail.com` and forwards email attachments
to the dashboard's `/api/inbox/ingest` endpoint. Every email subject matching
one of the supported prefixes gets routed automatically — the dashboard
handles the rest.

## Subject prefixes

| Prefix | What to send | Lands in |
|---|---|---|
| `Analyst Report: <TICKER>` (with `JPM` or `RBC` in subject or filename) | PDF | Per-ticker analyst snapshot (existing flow, unchanged) |
| `SIA …` | **CSV export (preferred)** or screenshot (PNG/JPG/PDF) | Each matched stock's SIA SMAX + score. CSV is auto-detected — same subject either way. |
| `BoostedAI …` *or* `Boosted …` | **Boosted.ai unified-data CSV (preferred)** or watchlist screenshot (PNG/JPG/PDF) | Each matched stock's BoostedAI rating + consensus + score. CSV is auto-detected — same subject either way. |
| `MarketEdge …` *or* `ChartScout …` | ChartScout Likes export (CSV) | Each matched stock's `marketEdge` fields + composite score |
| `Strategist …` | Any analyst/strategist research (PDF or image) | Brief's "Analyst / Strategist Reports" dropbox |
| `Fundstrat Top` / `Fundstrat Bottom` / `Fundstrat SMID Top` / `Fundstrat SMID Bottom` | Screenshot (PNG/JPG/PDF) | Respective Fundstrat list on the Research tab |
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
5. Add a time-driven trigger that runs `processInbox` every 5 minutes.
6. Authorize the script when prompted.

## Script

```javascript
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
  const SUBJECT_RE = /^(Analyst Report:|Fundstrat SMID Top|Fundstrat SMID Bottom|Fundstrat Top|Fundstrat Bottom|RBC Canadian|RBC US|RBCCM FEW|Seeking Alpha|Alpha Picks|SIA\b|BoostedAI\b|Boosted\b|MarketEdge\b|ChartScout\b|Strategist\b)/i;
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
```

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
