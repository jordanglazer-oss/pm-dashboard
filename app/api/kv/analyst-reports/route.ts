import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getReportsForTicker, getSnapshotForTicker, setReportsForTicker, type AnalystReports, type AnalystSnapshots, type TickerReports } from "@/app/lib/analyst-snapshots";
import { isReportMeta, recordReportHistory, REPORT_SOURCES, type ReportSource, type ReportToRecord } from "@/app/lib/analyst-report-history";
import { tickersEqual } from "@/app/lib/ticker";
import type { Stock } from "@/app/lib/types";

/**
 * Analyst-report manifest storage. Mirrors the pm:attachments split:
 *   - pm:analyst-reports                       → this route (lightweight manifest)
 *   - pm:analyst-report-pdf:<id>               → /[id] route (base64 PDF dataUrl)
 *
 * The manifest holds per-(ticker, source) entries with the extracted JSON
 * from Anthropic + metadata. The PDF dataUrl lives outside the manifest so
 * the manifest blob stays small and unaffected by per-value size limits.
 *
 * Shape:
 *   { [TICKER]: { rbc?: ReportMeta; jpm?: ReportMeta } }
 *
 * Each ReportMeta is:
 *   { id, label, uploadedAt, hash, extracted: { rating?, target?, asOf?, thesis?, risks?, sectorView?, keyMetrics? } }
 */

const KEY = "pm:analyst-reports";

// Force-dynamic ensures the Inbox tab's "All Ingested Reports" table sees
// fresh data on every Refresh click — without this, Next's default route
// caching could serve a stale snapshot that doesn't include just-ingested
// reports.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ reports: {} });
    return NextResponse.json({ reports: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (analyst-reports):", e);
    return NextResponse.json({ reports: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { reports } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(reports));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (analyst-reports):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

/**
 * PATCH changes ONE ticker, source by source, by read-merge-write:
 *   { ticker, set?: { [source]: value }, remove?: string[] }
 * Everything else in the blob — other tickers, and this ticker's other
 * sources — is left exactly as stored. The browser uses this for every edit,
 * so a tab left open can no longer roll back what the nightly estimates
 * refresh or the email ingest wrote since it loaded.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { ticker?: unknown; set?: unknown; remove?: unknown };
    const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    const set = body.set && typeof body.set === "object" && !Array.isArray(body.set) ? (body.set as Record<string, unknown>) : {};
    const remove = Array.isArray(body.remove) ? body.remove.filter((x): x is string => typeof x === "string") : [];
    if (!ticker || (Object.keys(set).length === 0 && remove.length === 0)) {
      return NextResponse.json({ error: "ticker plus set or remove required" }, { status: 400 });
    }
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // An unreadable blob throws here and nothing is written.
    const blob = (raw ? JSON.parse(raw) : {}) as AnalystReports;
    const current = { ...(getReportsForTicker(blob, ticker) ?? {}) } as Record<string, unknown>;
    const before = { ...current };
    for (const [source, value] of Object.entries(set)) current[source] = value;
    for (const source of remove) delete current[source];
    const next = setReportsForTicker(blob, ticker, Object.keys(current).length ? (current as TickerReports) : undefined);
    await redis.set(KEY, JSON.stringify(next));
    await recordHistoryForPatch(redis, ticker, before, set);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis patch error (analyst-reports):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

/**
 * Write-aside after a PATCH that set a new report (a manual upload): append
 * the replaced report and the new one to pm:analyst-report-history:<TICKER>.
 * Reads pm:stocks / pm:analyst-snapshots READ-ONLY for the price at the
 * report. Never throws; never changes what the PATCH saved. A removal adds
 * nothing and deletes nothing from the history.
 */
async function recordHistoryForPatch(
  redis: Awaited<ReturnType<typeof getRedis>>,
  ticker: string,
  before: Record<string, unknown>,
  set: Record<string, unknown>,
): Promise<void> {
  try {
    const changed = Object.entries(set).filter(
      ([source, value]) =>
        REPORT_SOURCES.includes(source as ReportSource) &&
        isReportMeta(value) &&
        !(isReportMeta(before[source]) && (before[source] as { hash: string }).hash === value.hash),
    );
    if (changed.length === 0) return;
    const [stocksRaw, snapsRaw] = await Promise.all([redis.get("pm:stocks"), redis.get("pm:analyst-snapshots")]);
    let price: number | undefined;
    let snap: ReturnType<typeof getSnapshotForTicker>;
    try {
      const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as Stock[];
      const p = Array.isArray(stocks) ? stocks.find((s) => tickersEqual(s.ticker, ticker))?.price : undefined;
      price = typeof p === "number" && Number.isFinite(p) ? p : undefined;
    } catch {
      price = undefined;
    }
    try {
      snap = getSnapshotForTicker((snapsRaw ? JSON.parse(snapsRaw) : {}) as AnalystSnapshots, ticker);
    } catch {
      snap = undefined;
    }
    const toRecord: ReportToRecord[] = [];
    for (const [source, value] of changed) {
      const src = source as ReportSource;
      const prev = before[source];
      if (isReportMeta(prev)) {
        const e = src === "morningstar" ? undefined : snap?.[src];
        const prevPrice = e && e.asOf && e.asOf === prev.extracted.asOf ? e.priceAtReport : undefined;
        toRecord.push({ source: src, meta: prev, priceAtReport: prevPrice });
      }
      if (isReportMeta(value)) toRecord.push({ source: src, meta: value, priceAtReport: price });
    }
    await recordReportHistory(redis, ticker, toRecord);
  } catch (e) {
    console.error("[Report-history] patch write-aside failed (ignored):", e);
  }
}
