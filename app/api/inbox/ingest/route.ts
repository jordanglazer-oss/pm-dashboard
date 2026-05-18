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
import { appendInboxEvent } from "@/app/lib/inbox-log";

/**
 * Webhook target for the Gmail Apps Script. The script POSTs one PDF per
 * call, with the email subject + sender so we can route the PDF to the
 * right (ticker, source) slot.
 *
 * Expected request:
 *   POST /api/inbox/ingest
 *   Authorization: Bearer <INBOX_SECRET>
 *   { subject: string, sender?: string, filename?: string, dataUrl: string }
 *
 * Where `dataUrl` is `data:application/pdf;base64,<base64>` and `subject`
 * matches the pattern: `Analyst Report: <TICKER> <RBC|JPM>` (case-insensitive,
 * with optional extra text after the source).
 *
 * Every call appends an entry to pm:inbox-log so the user can see in the
 * admin panel what was ingested, what was skipped (cache hit), and what
 * failed (parse / extraction / storage error).
 */

const SUBJECT_RE = /^analyst report:\s*([a-z0-9.\-]+)\s+(rbc|jpm)\b/i;

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
}) {
  const reportId = reportIdFor(args.ticker, args.source);

  // 1) Store PDF dataUrl in its own key (split storage).
  const redis = await getRedis();
  await redis.set(`pm:analyst-report-pdf:${reportId}`, args.dataUrl);

  // 2) Update the lightweight manifest.
  const reports = await readJson<AnalystReports>("pm:analyst-reports", {});
  const tickerReports: TickerReports = { ...(getReportsForTicker(reports, args.ticker) ?? {}) };
  const meta: ReportMeta = {
    id: reportId,
    label: args.label,
    uploadedAt: new Date().toISOString(),
    hash: args.hash,
    extracted: args.extracted,
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
  let body: { subject?: string; sender?: string; filename?: string; dataUrl?: string; ping?: boolean };
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

  const subject = (body.subject ?? "").trim();
  const sender = body.sender;
  const filename = body.filename;
  const dataUrl = body.dataUrl ?? "";

  if (!subject || !dataUrl) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "Missing subject or dataUrl" });
    return NextResponse.json({ error: "Missing subject or dataUrl" }, { status: 400 });
  }
  if (!dataUrl.startsWith("data:application/pdf;base64,")) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "Attachment is not a base64-encoded PDF" });
    return NextResponse.json({ error: "Expected base64 PDF" }, { status: 400 });
  }

  // 15 MB cap, matches the manual upload limit.
  if (dataUrl.length > 20 * 1024 * 1024) {
    await appendInboxEvent({ status: "error", subject, sender, filename, message: "PDF too large (>15 MB raw)" });
    return NextResponse.json({ error: "PDF too large" }, { status: 413 });
  }

  // ── Parse subject ───────────────────────────────────────────────────
  const m = subject.match(SUBJECT_RE);
  if (!m) {
    await appendInboxEvent({
      status: "error",
      subject,
      sender,
      filename,
      message: `Subject doesn't match "Analyst Report: <TICKER> <RBC|JPM>" — got: "${subject}"`,
    });
    return NextResponse.json({ error: "Subject does not match expected format" }, { status: 400 });
  }
  const rawTicker = m[1].toUpperCase();
  const ticker = canonicalTicker(rawTicker);
  const source = m[2].toLowerCase() as AnalystSource;

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
