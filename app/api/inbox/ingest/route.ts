import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { extractAnalystReport, type AnalystSource } from "@/app/lib/analyst-extract";
import {
  reportIdFor,
  getReportsForTicker,
  setReportsForTicker,
  getSnapshotForTicker,
  setSnapshotForTicker,
  type AnalystReports,
  type AnalystSnapshots,
  type AnalystEntry,
  type TickerReports,
  type TickerSnapshot,
  type ReportMeta,
} from "@/app/lib/analyst-snapshots";
import { canonicalTicker, tickersEqual } from "@/app/lib/ticker";
import { blobConfigured, putDataUrl, getDataUrl, deleteBlob } from "@/app/lib/blob-store";
import { appendInboxEvent } from "@/app/lib/inbox-log";
import { classifySubject, dispatchInbox } from "@/app/lib/inbox-dispatch";

/**
 * Webhook target for the Gmail Apps Script. The script POSTs one PDF per
 * call, with the email subject + filename so we can route the PDF to the
 * right (ticker, source) slot.
 *
 * Expected request:
 *   POST /api/inbox/ingest
 *   Authorization: Bearer <INBOX_SECRET>
 *   { subject: string, sender?: string, filename?: string, dataUrl: string }
 *
 * Where `dataUrl` is `data:application/pdf;base64,<base64>`.
 *
 * Routing supports three workflows (in order of preference):
 *
 *   1. Filename-driven (preferred — enables batching multiple PDFs per email):
 *      - Subject: "Analyst Report: <TICKER>"  (or anything starting with that —
 *        the subject's source is OPTIONAL when filenames carry it)
 *      - PDFs:    "<TICKER>_JPM.pdf", "<TICKER>_RBC.pdf", "AVGO-RBC.pdf",
 *                 "AVGO_RBC_2026Q3.pdf", "BRK.B_JPM.pdf"
 *      The webhook reads ticker + source from the filename per attachment.
 *      One email → many slots, each routed independently.
 *
 *   2. Subject-driven (legacy, fully supported):
 *      - Subject: "Analyst Report: AVGO RBC"
 *      - PDF:     any name
 *      One PDF per email — the subject alone determines the slot.
 *
 *   3. Hybrid (subject names ticker, filename names source):
 *      - Subject: "Analyst Report: AVGO"
 *      - PDF:     "AVGO_RBC.pdf"
 *      Useful when you want to send a single PDF but find filename routing
 *      easier than typing the full subject.
 *
 * Every call appends an entry to pm:inbox-log so the user can see in the
 * admin panel what was ingested, what was skipped (cache hit), and what
 * failed (parse / extraction / storage error).
 */

// Subject regex — supports BOTH the new short form ("Analyst Report: AVGO")
// and the legacy long form ("Analyst Report: AVGO RBC"). The source group is
// optional; when omitted the source comes from the filename. Subject-derived
// ticker is used as a fallback when the filename doesn't carry one.
const SUBJECT_RE = /^analyst report:\s*([a-z0-9.\-]+)(?:\s+(rbc|jpm)\b)?/i;

// Filename regex — extracts ticker + source from PDFs named like
// "AVGO_JPM.pdf", "AVGO-RBC.pdf", "AVGO_RBC_2026Q3.pdf", "BRK.B_JPM.pdf".
// This enables multi-PDF batching: send one email with several attachments
// (e.g. AVGO_JPM.pdf + AVGO_RBC.pdf) and each gets routed correctly. The
// underscore/hyphen/space separator covers however the user's email client
// formats names.
const FILENAME_RE = /([a-z0-9.\-]+)[_\s\-]+(rbc|jpm)(?:[._\s\-].*)?\.pdf$/i;

type Stock = { ticker: string; price?: number };

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const redis = await getRedis();
  await redis.set(key, JSON.stringify(value));
}

async function persistReportToRedis(args: {
  ticker: string;
  source: AnalystSource;
  dataUrl: string;
  label: string;
  extracted: import("@/app/lib/analyst-snapshots").ExtractedReport;
  hash: string;
  /** Timestamp the extraction was originally computed. On cache hits this
   *  is the cached entry's original date (from pm:analyst-report-extract-cache),
   *  not the retry date — so the manifest reflects when the data was actually
   *  produced, not when it was re-written during a deduped retry. */
  extractedAt: string;
}) {
  const reportId = reportIdFor(args.ticker, args.source);

  // 1) Archive the original PDF to Vercel Blob (NOT Redis — multi-MB PDFs in
  //    Redis are what kept OOMing the 250 MB tier). Best-effort: the useful
  //    data is already in the snapshot, so a Blob hiccup must not fail the
  //    ingest. pdfUrl is an archive pointer; nothing reads it back today.
  let pdfUrl: string | undefined;
  if (blobConfigured()) {
    try {
      pdfUrl = await putDataUrl(`analyst-reports/${reportId}`, args.dataUrl);
    } catch (e) {
      console.error("[Inbox] analyst PDF Blob upload failed (continuing):", e);
    }
  }

  // 2) Update the lightweight manifest.
  const reports = await readJson<AnalystReports>("pm:analyst-reports", {});
  const tickerReports: TickerReports = { ...(getReportsForTicker(reports, args.ticker) ?? {}) };
  const meta: ReportMeta = {
    id: reportId,
    label: args.label,
    uploadedAt: new Date().toISOString(),
    extractedAt: args.extractedAt,
    hash: args.hash,
    extracted: args.extracted,
    pdfUrl,
  };
  tickerReports[args.source] = meta;
  const nextReports = setReportsForTicker(reports, args.ticker, tickerReports);
  await writeJson("pm:analyst-reports", nextReports);

  // 3) Update the snapshot (replaces the analyst entry entirely — PDF-driven,
  //    matches the manual upload semantics).
  const snapshots = await readJson<AnalystSnapshots>("pm:analyst-snapshots", {});
  const currentSnapshot = getSnapshotForTicker(snapshots, args.ticker) ?? {};
  const stocks = await readJson<Stock[]>("pm:stocks", []);
  const priceAtUpload = stocks.find((s) => tickersEqual(s.ticker, args.ticker))?.price;
  const entry: AnalystEntry = {
    rating: args.extracted.rating ?? "not-covered",
    target: args.extracted.target,
    asOf: args.extracted.asOf,
    priceAtReport: priceAtUpload,
    reportId,
    lastUpdated: new Date().toISOString(),
  };
  const nextSnapshot: TickerSnapshot = { ...currentSnapshot, [args.source]: entry };
  const nextSnapshots = setSnapshotForTicker(snapshots, args.ticker, nextSnapshot);
  await writeJson("pm:analyst-snapshots", nextSnapshots);
}

export async function POST(request: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────
  const secret = process.env.INBOX_SECRET;
  if (!secret) {
    await appendInboxEvent({ status: "error", message: "INBOX_SECRET env var is not configured" });
    return NextResponse.json({ error: "Inbox secret not configured" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body ──────────────────────────────────────────────────────
  let body: { subject?: string; sender?: string; filename?: string; dataUrl?: string; blobPathname?: string; ping?: boolean };
  try {
    body = await request.json();
  } catch {
    await appendInboxEvent({ status: "error", message: "Request body was not valid JSON" });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Ping mode — confirms the webhook is reachable and the bearer secret
  // matches, without burning an Anthropic call on dummy PDF data. Used by
  // the Apps Script's `testWebhook` function during setup. Skipped from
  // the inbox-log so health checks don't clutter the audit trail.
  if (body.ping === true) {
    return NextResponse.json({ ok: true, ping: true, message: "Webhook reachable and authorized." });
  }

  // Strip any leading reply/forward prefixes ("Re:", "Fwd:", "Fw:", possibly
  // stacked) so a REPLY to an auto-sent "Analyst Report: TICKER" email — which
  // arrives as "Re: Analyst Report: TICKER" — still routes to the report
  // handler and matches SUBJECT_RE. Enables the watchlist reply-to-feed flow
  // and fixes ordinary replies to any report email.
  const rawSubject = (body.subject ?? "").trim();
  const subject = rawSubject.replace(/^(?:\s*(?:re|fwd?|fw)\s*:\s*)+/i, "").trim();
  const sender = body.sender;
  const filename = body.filename;
  let dataUrl = body.dataUrl ?? "";

  // Large-attachment path: the Apps Script uploaded the file straight to Blob
  // (bypassing the 4.5 MB function limit) and sent only its staging pathname.
  // Hydrate the content here, then delete the staging copy — the dataUrl
  // string now holds it, and the handlers re-store it at its final Blob path.
  const stagingPath = typeof body.blobPathname === "string" && /^inbox-staging\/[A-Za-z0-9._-]+$/.test(body.blobPathname) ? body.blobPathname : "";
  if (!dataUrl && stagingPath) {
    const hydrated = await getDataUrl(stagingPath);
    if (hydrated) dataUrl = hydrated;
    await deleteBlob(stagingPath); // best-effort cleanup
  }

  if (!subject || !dataUrl) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "Missing subject or dataUrl/blob" });
    return NextResponse.json({ error: "Missing subject or dataUrl/blobPathname" }, { status: 400 });
  }

  // ── New-kinds dispatcher ───────────────────────────────────────────
  // SIA / BoostedAI / MarketEdge / Strategist subjects route through the
  // shared dispatcher (app/lib/inbox-dispatch.ts), which reuses the same
  // parsing + matching code as the manual Inbox UI. The classic
  // "Analyst Report: <TICKER>" flow falls through to the legacy path
  // below (PDF-only, ticker/source routing).
  const kind = classifySubject(subject);
  // Anything other than the legacy "analyst-report" and the catch-all
  // "unknown" routes through the dispatcher. Research kinds arrive as
  // an object `{ kind: "research", source }`; per-stock/strategist
  // kinds are plain strings.
  const isDispatched = kind !== "analyst-report" && kind !== "unknown";
  if (isDispatched) {
    const kindLabel = typeof kind === "object" ? `research:${kind.source}` : kind;
    try {
      const result = await dispatchInbox({ kind, subject, filename, dataUrl });
      if (!result) {
        await appendInboxEvent({ status: "error", subject, sender, filename, message: `Dispatcher returned no result for kind=${kindLabel}` });
        return NextResponse.json({ error: "Internal dispatch error" }, { status: 500 });
      }
      await appendInboxEvent({
        status: result.ok ? "success" : "error",
        subject,
        sender,
        filename,
        size: dataUrl.length,
        message: result.message,
      });
      return NextResponse.json(
        { ok: result.ok, kind: result.kind, message: result.message, detail: result.detail ?? {} },
        { status: result.ok ? 200 : (result.status ?? 400) },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendInboxEvent({ status: "error", subject, sender, filename, message: `${kindLabel} handler threw: ${msg}` });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // Legacy Analyst Report PDF flow — unchanged below.
  if (!dataUrl.startsWith("data:application/pdf;base64,")) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "Attachment is not a base64-encoded PDF" });
    return NextResponse.json({ error: "Expected base64 PDF" }, { status: 400 });
  }

  // 15 MB cap, matches the manual upload limit.
  if (dataUrl.length > 20 * 1024 * 1024) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "PDF too large (>15 MB raw)" });
    return NextResponse.json({ error: "PDF too large" }, { status: 413 });
  }

  // ── Route the PDF to a (ticker, source) slot ───────────────────────
  // Preferred routing: filename carries both ticker and source
  // (e.g. "AVGO_JPM.pdf"). This is what enables multi-PDF batching —
  // attach several PDFs to one email and each gets routed independently.
  // Fallback: subject carries them ("Analyst Report: AVGO RBC", legacy).
  // Hybrid: subject carries ticker ("Analyst Report: AVGO"), filename
  // carries source ("AVGO_RBC.pdf"). All three modes are accepted.
  const fnMatch = filename ? filename.match(FILENAME_RE) : null;
  const subjMatch = subject.match(SUBJECT_RE);

  let rawTicker: string | null = null;
  let source: AnalystSource | null = null;

  if (fnMatch) {
    rawTicker = fnMatch[1].toUpperCase();
    source = fnMatch[2].toLowerCase() as AnalystSource;
  } else if (subjMatch && subjMatch[2]) {
    // Legacy full-subject form: "Analyst Report: AVGO RBC"
    rawTicker = subjMatch[1].toUpperCase();
    source = subjMatch[2].toLowerCase() as AnalystSource;
  }
  // If filename gave us source but no ticker (unusual — filename regex
  // requires both), or vice versa, prefer the subject's ticker as a
  // tie-breaker since subject ALWAYS carries one in any supported workflow.
  if (!rawTicker && subjMatch) rawTicker = subjMatch[1].toUpperCase();

  if (!rawTicker || !source) {
    const reason = !source
      ? `Couldn't determine source (RBC/JPM). Name the PDF "<TICKER>_RBC.pdf" or "<TICKER>_JPM.pdf", or use legacy subject "Analyst Report: <TICKER> <RBC|JPM>". Got subject="${subject}", filename="${filename ?? "(none)"}"`
      : `Couldn't determine ticker. Subject should start with "Analyst Report: <TICKER>", or PDF should be named "<TICKER>_<RBC|JPM>.pdf". Got subject="${subject}", filename="${filename ?? "(none)"}"`;
    await appendInboxEvent({ status: "error", subject, sender, filename, message: reason });
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  const ticker = canonicalTicker(rawTicker);

  // ── Extract ─────────────────────────────────────────────────────────
  let extractRes;
  try {
    extractRes = await extractAnalystReport({ ticker, source, dataUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Extraction failed";
    await appendInboxEvent({ status: "error", subject, sender, ticker, source, filename, size: dataUrl.length, message: `Anthropic extraction failed: ${msg}` });
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ── Persist ─────────────────────────────────────────────────────────
  try {
    await persistReportToRedis({
      ticker,
      source,
      dataUrl,
      label: filename || `${source.toUpperCase()} ${ticker}`,
      extracted: extractRes.result,
      hash: extractRes.hash,
      extractedAt: extractRes.extractedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Storage failed";
    await appendInboxEvent({ status: "error", subject, sender, ticker, source, filename, size: dataUrl.length, hash: extractRes.hash, message: `Persist failed: ${msg}` });
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await appendInboxEvent({
    status: "success",
    subject,
    sender,
    ticker,
    source,
    filename,
    size: dataUrl.length,
    hash: extractRes.hash,
    cached: extractRes.cached,
    message: extractRes.cached
      ? `Cached extraction reused (no Anthropic spend) and stored under ${source.toUpperCase()} for ${ticker}.`
      : `Extracted ${source.toUpperCase()} report for ${ticker} (rating=${extractRes.result.rating ?? "—"}, target=${extractRes.result.target ?? "—"}).`,
  });

  return NextResponse.json({
    ok: true,
    ticker,
    source,
    cached: extractRes.cached,
    extracted: extractRes.result,
  });
}
