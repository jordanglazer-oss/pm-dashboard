/**
 * Inbox webhook dispatcher. Maps an email's subject prefix to the right
 * handler so the existing Gmail Apps Script can forward FOUR new kinds of
 * emails into the dashboard (in addition to the legacy Analyst Report PDF
 * flow which lives in app/api/inbox/ingest/route.ts):
 *
 *   - "SIA …"            → /api/sia-scrape equivalent, applied to pm:stocks
 *   - "BoostedAI …" or
 *     "Boosted …"        → /api/boosted-ai-scrape equivalent, applied to pm:stocks
 *   - "MarketEdge …" or
 *     "ChartScout …"     → MarketEdge CSV parsed + applied to pm:stocks
 *   - "Strategist …"     → file dropped into the Brief's "Analyst /
 *                          Strategist Reports" attachment dropbox
 *                          (pm:attachments manifest + pm:attachment:<id>)
 *
 * Each handler returns a structured `DispatchResult` the route hands back
 * to the Apps Script and also appends to pm:inbox-log.
 *
 * All shared parsing / matching logic lives in
 *   - app/lib/screenshot-extractors.ts (vision calls + caching)
 *   - app/lib/marketedge-csv.ts        (CSV parser)
 *   - app/lib/stock-patches.ts         (pure helpers that compute
 *                                       StockPatch[] from entries)
 * so the email path follows the EXACT same logic as the manual Inbox UI.
 */

import { getRedis } from "./redis";
import type { Stock, ScoreKey } from "./types";
import { isScoreable } from "./scoring";
import {
  extractSiaFromAttachments,
  extractBoostedFromAttachments,
  type AttachmentInput,
} from "./screenshot-extractors";
import { parseMarketEdgeCsv } from "./marketedge-csv";
import { applySiaEntries, applyBoostedEntries, applyMarketEdgeRows, type StockPatch } from "./stock-patches";

// ── Subject → kind ──────────────────────────────────────────────────

export type InboxKind = "sia" | "boosted" | "marketedge" | "strategist" | "analyst-report" | "unknown";

/** Classify the email's subject. Case-insensitive prefix match. */
export function classifySubject(subject: string): InboxKind {
  const s = subject.trim();
  if (/^analyst report:/i.test(s)) return "analyst-report";
  if (/^sia\b/i.test(s)) return "sia";
  if (/^(boostedai|boosted)\b/i.test(s)) return "boosted";
  if (/^(marketedge|chartscout)\b/i.test(s)) return "marketedge";
  if (/^strategist\b/i.test(s)) return "strategist";
  return "unknown";
}

// ── Shared MIME helpers ────────────────────────────────────────────

const IMAGE_MIME_RE = /^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,/i;
const PDF_MIME_RE = /^data:application\/pdf;base64,/i;
// CSV may arrive as text/csv (Gmail), text/plain, or application/vnd.ms-excel.
const CSV_MIME_RE = /^data:(text\/csv|text\/plain|application\/vnd\.ms-excel);base64,/i;

export function isImageDataUrl(dataUrl: string): boolean { return IMAGE_MIME_RE.test(dataUrl); }
export function isPdfDataUrl(dataUrl: string): boolean { return PDF_MIME_RE.test(dataUrl); }
export function isCsvDataUrl(dataUrl: string): boolean { return CSV_MIME_RE.test(dataUrl); }

/** Decode a base64 data URL to a string. Used for CSVs. */
function decodeBase64Utf8(dataUrl: string): string {
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return "";
  return Buffer.from(m[1], "base64").toString("utf8");
}

// ── Server-side pm:stocks read-modify-write ────────────────────────

/** Apply a StockPatch[] to the pm:stocks blob directly (no React). Returns
 *  the count of stocks actually touched. Read-modify-write so no other
 *  fields are dropped. */
async function applyPatchesToRedis(patches: StockPatch[]): Promise<{ touched: number }> {
  if (patches.length === 0) return { touched: 0 };
  const redis = await getRedis();
  const raw = await redis.get("pm:stocks");
  if (!raw) return { touched: 0 };
  const stocks = JSON.parse(raw) as Stock[];
  let touched = 0;
  const byTicker = new Map<string, Stock>();
  for (const s of stocks) byTicker.set(s.ticker, s);
  for (const p of patches) {
    const s = byTicker.get(p.ticker);
    if (!s) continue;
    // Field merge.
    if (Object.keys(p.fields).length > 0) {
      Object.assign(s, p.fields);
      touched += 1;
    }
    // Score updates.
    if (p.scoreUpdates && p.scoreUpdates.length > 0) {
      const nextScores = { ...s.scores };
      for (const su of p.scoreUpdates) {
        nextScores[su.key as ScoreKey] = su.value;
      }
      s.scores = nextScores;
    }
  }
  await redis.set("pm:stocks", JSON.stringify(stocks));
  return { touched };
}

async function readStocks(): Promise<Stock[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:stocks");
    if (!raw) return [];
    return JSON.parse(raw) as Stock[];
  } catch {
    return [];
  }
}

// ── Strategist attachments — direct write to pm:attachments ────────

type AttachmentManifestEntry = {
  id: string;
  label: string;
  section: string;
  addedAt: string;
};

/** Append a strategist attachment to the Brief's dropbox. Mirrors the
 *  manual UI's split storage: lightweight manifest in pm:attachments,
 *  per-file dataUrl in pm:attachment:<id>. */
async function addStrategistAttachment(dataUrl: string, label: string): Promise<{ id: string }> {
  const redis = await getRedis();
  const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 1) per-file payload.
  await redis.set(`pm:attachment:${id}`, dataUrl);
  // 2) manifest append.
  const raw = await redis.get("pm:attachments");
  const existing: AttachmentManifestEntry[] = raw ? JSON.parse(raw) : [];
  const entry: AttachmentManifestEntry = {
    id,
    label: label.slice(0, 200),
    section: "strategistReports",
    addedAt: new Date().toISOString(),
  };
  await redis.set("pm:attachments", JSON.stringify([...existing, entry]));
  return { id };
}

// ── Public dispatch result ─────────────────────────────────────────

export type DispatchResult = {
  ok: boolean;
  kind: InboxKind;
  /** One-line summary for the inbox-log + the route response. */
  message: string;
  /** When ok=true and we touched user data, this carries the bookkeeping. */
  detail?: Record<string, unknown>;
  /** HTTP status the route should return. */
  status?: number;
};

// ── Handlers ───────────────────────────────────────────────────────

async function handleSia(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "sia", status: 400, message: "SIA email expects an image or PDF attachment." };
  }
  const { entries, cached } = await extractSiaFromAttachments([att]);
  const stocks = await readStocks();
  const expected = stocks.filter(isScoreable);
  // Pass full pm:stocks pool so held ETFs/funds in the screenshot drop
  // out of "unmatched" silently (they don't feed relativeStrength).
  const { patches, summary } = applySiaEntries(expected, entries, new Date().toISOString(), stocks);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "sia",
    message: `SIA${cached ? " (cached)" : ""}: ${summary.matched} matched · ${summary.updated} updated${summary.inScreenshotButUnreadable.length ? ` · ${summary.inScreenshotButUnreadable.length} unreadable` : ""}${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}.`,
    detail: { label, cached, summary, touched },
  };
}

async function handleBoosted(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "boosted", status: 400, message: "BoostedAI email expects an image or PDF attachment." };
  }
  const { entries, cached } = await extractBoostedFromAttachments([att]);
  const stocks = await readStocks();
  const expected = stocks.filter(isScoreable);
  const { patches, summary } = applyBoostedEntries(expected, entries, new Date().toISOString(), stocks);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "boosted",
    message: `BoostedAI${cached ? " (cached)" : ""}: ${summary.matched} matched · ${summary.updated} updated${summary.inScreenshotButUnreadable.length ? ` · ${summary.inScreenshotButUnreadable.length} unreadable` : ""}${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}.`,
    detail: { label, cached, summary, touched },
  };
}

async function handleMarketEdge(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (!isCsvDataUrl(att.dataUrl)) {
    return { ok: false, kind: "marketedge", status: 400, message: "MarketEdge email expects a CSV attachment (.csv)." };
  }
  const text = decodeBase64Utf8(att.dataUrl);
  const parsed = parseMarketEdgeCsv(text);
  if (parsed.errors.length > 0) {
    return { ok: false, kind: "marketedge", status: 400, message: `MarketEdge CSV parse error: ${parsed.errors.join("; ")}` };
  }
  const stocks = await readStocks();
  const { patches, summary } = applyMarketEdgeRows(stocks, parsed.rows);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "marketedge",
    message: `MarketEdge CSV: ${summary.matched} matched / ${summary.rowsParsed} rows · ${summary.updated} updated.`,
    detail: { label, summary, touched },
  };
}

async function handleStrategist(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "strategist", status: 400, message: "Strategist email expects a PDF or image attachment." };
  }
  const { id } = await addStrategistAttachment(att.dataUrl, label);
  return {
    ok: true,
    kind: "strategist",
    message: `Strategist report stored in the Brief's Analyst / Strategist Reports dropbox (id=${id}).`,
    detail: { label, id },
  };
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Dispatch one inbound email attachment to the appropriate handler. Returns
 * a DispatchResult the route uses for both the HTTP response and the
 * pm:inbox-log entry. Returns `kind: "analyst-report"` UNHANDLED so the
 * caller falls through to the existing analyst-report routing logic.
 *
 * The route is responsible for auth + body parsing; this function is pure
 * dispatch given (kind, attachment).
 */
export async function dispatchInbox(args: {
  kind: InboxKind;
  subject: string;
  filename?: string;
  dataUrl: string;
}): Promise<DispatchResult | null> {
  const label = args.filename || args.subject;
  const att: AttachmentInput = { id: "inbox", label, dataUrl: args.dataUrl };
  switch (args.kind) {
    case "sia":          return await handleSia(att, label);
    case "boosted":      return await handleBoosted(att, label);
    case "marketedge":   return await handleMarketEdge(att, label);
    case "strategist":   return await handleStrategist(att, label);
    case "analyst-report": return null;  // existing flow handles this
    case "unknown":      return null;    // existing route returns its "couldn't determine source" error
  }
}
