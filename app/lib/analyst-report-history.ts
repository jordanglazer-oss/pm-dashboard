import type { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { canonicalTicker } from "@/app/lib/ticker";
import type { AnalystRating, ExtractedReport, ReportMeta } from "@/app/lib/analyst-snapshots";

/**
 * pm:analyst-report-history:<TICKER> — APPEND-ONLY record of every bank
 * report (RBC / JPM / Morningstar) received for a name (Nov 2026).
 *
 * Exists because pm:analyst-reports and pm:analyst-snapshots hold ONE slot
 * per bank per ticker: a new report replaces the old rating, target, thesis
 * and risks, so "RBC cut to Sector Perform and took the target from 180 to
 * 150" could not be seen afterwards. (The FactSet street consensus has its own
 * log in pm:analyst-history.)
 *
 * One key per ticker, so two reports for different names arriving at once
 * (the inbox posts emails in parallel) can never overwrite each other.
 *
 * Storage: every entry keeps the compact facts (date, rating, target and
 * currency, price at the report, valuation basis, scenarios, Morningstar
 * ratings) — a few hundred bytes. The bulky text (thesis, risks, catalysts,
 * metrics, segments, KPIs) is kept only on the newest FULL_DETAIL_KEEP
 * reports per bank; older entries keep the compact facts only. At most
 * MAX_PER_SOURCE entries per bank.
 *
 * Writers (write-asides — never change what the manifest/snapshot saves,
 * never throw): the email ingest (`persistReportToRedis`), the browser's
 * manual upload (`PATCH /api/kv/analyst-reports`) and the one-off backfill
 * (`/api/admin/backfill-analyst-report-history`). Each records the report
 * being REPLACED as well as the new one, so the first replacement after this
 * shipped still keeps the old report. Duplicates (same PDF, or the same
 * date + rating + target re-sent) are skipped. Removing a report from the
 * stock page does NOT remove its history. Monitoring only — never feeds a
 * score. BACKED UP.
 */

const log = createLogger("Report-history");

export const REPORT_HISTORY_PREFIX = "pm:analyst-report-history:";
export const FULL_DETAIL_KEEP = 6;
export const MAX_PER_SOURCE = 40;

export type ReportSource = "rbc" | "jpm" | "morningstar";
export const REPORT_SOURCES: readonly ReportSource[] = ["rbc", "jpm", "morningstar"];

export type ReportDetail = Pick<
  ExtractedReport,
  "thesis" | "risks" | "sectorView" | "keyMetrics" | "catalysts" | "segments" | "industryKpis"
>;

export type ReportHistoryEntry = {
  /** SHA-256 of the PDF (dedupe key). */
  hash: string;
  /** Report date as extracted (YYYY-MM-DD), when stated. */
  asOf?: string;
  /** When the extraction was produced / the report was received. */
  extractedAt?: string;
  /** When this entry was written to the history. */
  recordedAt: string;
  label?: string;
  rating?: AnalystRating;
  /** Target as printed in the report, in `targetCurrency`. */
  target?: number;
  targetCurrency?: string;
  /** Share price when the report was received (from pm:stocks). */
  priceAtReport?: number;
  valuationBasis?: string;
  scenarios?: { bull?: number; base?: number; bear?: number };
  stars?: number;
  fairValue?: number;
  moat?: ExtractedReport["moat"];
  moatTrend?: ExtractedReport["moatTrend"];
  capitalAllocation?: ExtractedReport["capitalAllocation"];
  uncertainty?: ExtractedReport["uncertainty"];
  /** Full text — only on the newest FULL_DETAIL_KEEP entries per bank. */
  detail?: ReportDetail;
};

export type TickerReportHistory = Partial<Record<ReportSource, ReportHistoryEntry[]>>;

export function reportHistoryKey(ticker: string): string {
  return `${REPORT_HISTORY_PREFIX}${canonicalTicker(ticker)}`;
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** True when `x` looks like a stored ReportMeta (has a hash + extracted). */
export function isReportMeta(x: unknown): x is ReportMeta {
  if (!x || typeof x !== "object") return false;
  const m = x as Partial<ReportMeta>;
  return typeof m.hash === "string" && m.hash.length > 0 && !!m.extracted && typeof m.extracted === "object";
}

/** Build a history entry from a manifest entry. Pure. */
export function entryFromReport(meta: ReportMeta, recordedAt: string, priceAtReport?: number): ReportHistoryEntry {
  const x = meta.extracted ?? {};
  const e: ReportHistoryEntry = { hash: meta.hash, recordedAt };
  if (x.asOf) e.asOf = x.asOf;
  const at = meta.extractedAt ?? meta.uploadedAt;
  if (at) e.extractedAt = at;
  if (meta.label) e.label = meta.label;
  if (x.rating) e.rating = x.rating;
  if (isNum(x.target)) e.target = x.target;
  if (x.targetCurrency) e.targetCurrency = x.targetCurrency;
  if (isNum(priceAtReport)) e.priceAtReport = priceAtReport;
  if (x.valuationBasis) e.valuationBasis = x.valuationBasis;
  if (x.scenarios && (isNum(x.scenarios.bull) || isNum(x.scenarios.base) || isNum(x.scenarios.bear))) e.scenarios = { ...x.scenarios };
  if (isNum(x.stars)) e.stars = x.stars;
  if (isNum(x.fairValue)) e.fairValue = x.fairValue;
  if (x.moat) e.moat = x.moat;
  if (x.moatTrend) e.moatTrend = x.moatTrend;
  if (x.capitalAllocation) e.capitalAllocation = x.capitalAllocation;
  if (x.uncertainty) e.uncertainty = x.uncertainty;
  const detail: ReportDetail = {};
  if (x.thesis?.length) detail.thesis = x.thesis;
  if (x.risks?.length) detail.risks = x.risks;
  if (x.sectorView) detail.sectorView = x.sectorView;
  if (x.keyMetrics?.length) detail.keyMetrics = x.keyMetrics;
  if (x.catalysts?.length) detail.catalysts = x.catalysts;
  if (x.segments?.length) detail.segments = x.segments;
  if (x.industryKpis?.length) detail.industryKpis = x.industryKpis;
  if (Object.keys(detail).length) e.detail = detail;
  return e;
}

/** Sort key: report date first, then when it was extracted / recorded. */
function sortKey(e: ReportHistoryEntry): string {
  return `${e.asOf ?? (e.extractedAt ?? e.recordedAt).slice(0, 10)}|${e.extractedAt ?? e.recordedAt}`;
}

function sameReport(a: ReportHistoryEntry, b: ReportHistoryEntry): boolean {
  if (a.hash === b.hash) return true;
  // A re-sent copy of the same report (different file bytes, same content).
  return (
    !!a.asOf &&
    a.asOf === b.asOf &&
    a.rating === b.rating &&
    a.target === b.target &&
    a.stars === b.stars &&
    a.fairValue === b.fairValue
  );
}

/**
 * Add `entry` to one bank's list. Pure. Returns the same array reference
 * (and added=false) when it is a duplicate. Keeps oldest → newest order,
 * strips text from all but the newest FULL_DETAIL_KEEP, caps the list.
 * Existing entries are otherwise never changed.
 */
export function mergeReportEntry(
  list: ReportHistoryEntry[] | undefined,
  entry: ReportHistoryEntry,
): { list: ReportHistoryEntry[]; added: boolean } {
  const cur = Array.isArray(list) ? list : [];
  if (cur.some((e) => sameReport(e, entry))) return { list: cur, added: false };
  const next = [...cur, entry].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const capped = next.length > MAX_PER_SOURCE ? next.slice(next.length - MAX_PER_SOURCE) : next;
  const cut = capped.length - FULL_DETAIL_KEEP;
  const out = capped.map((e, i) => {
    if (i >= cut || !e.detail) return e;
    const rest = { ...e };
    delete rest.detail;
    return rest;
  });
  return { list: out, added: true };
}

export type ReportToRecord = { source: ReportSource; meta: ReportMeta; priceAtReport?: number };

/** Merge several reports into a ticker's history. Pure. */
export function mergeReports(
  history: TickerReportHistory,
  reports: ReportToRecord[],
  recordedAt: string,
): { history: TickerReportHistory; added: number } {
  let out: TickerReportHistory = history;
  let added = 0;
  for (const r of reports) {
    if (!REPORT_SOURCES.includes(r.source) || !isReportMeta(r.meta)) continue;
    const res = mergeReportEntry(out[r.source], entryFromReport(r.meta, recordedAt, r.priceAtReport));
    if (res.added) {
      out = { ...out, [r.source]: res.list };
      added++;
    }
  }
  return { history: out, added };
}

export function parseTickerHistory(raw: string | null): TickerReportHistory | null {
  if (!raw) return {};
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    return p as TickerReportHistory;
  } catch {
    return null;
  }
}

type Redis = Awaited<ReturnType<typeof getRedis>>;

/**
 * Write-aside: record reports for ONE ticker. Never throws; a corrupt stored
 * value is left alone (nothing written). Returns how many entries were added.
 */
export async function recordReportHistory(redis: Redis, ticker: string, reports: ReportToRecord[]): Promise<number> {
  try {
    if (!ticker || reports.length === 0) return 0;
    const key = reportHistoryKey(ticker);
    const current = parseTickerHistory(await redis.get(key));
    if (current === null) {
      log.warn("unreadable history, left alone:", key);
      return 0;
    }
    const { history, added } = mergeReports(current, reports, new Date().toISOString());
    if (added > 0) await redis.set(key, JSON.stringify(history));
    return added;
  } catch (e) {
    log.error("record failed (ignored):", e);
    return 0;
  }
}

// ── Reading: what changed between consecutive reports ───────────────────

export type ReportChange = {
  rating?: { from?: AnalystRating; to?: AnalystRating };
  /** % change in target — only when both targets share a currency. */
  targetPct?: number;
  stars?: { from?: number; to?: number };
  fairValuePct?: number;
  moat?: { from?: string; to?: string };
  valuationBasisChanged?: boolean;
};

const pct = (from?: number, to?: number) =>
  isNum(from) && isNum(to) && from !== 0 ? Math.round(((to - from) / from) * 1000) / 10 : undefined;

/** Change from `prev` to `next` (both from the same bank). Pure. */
export function changeBetween(prev: ReportHistoryEntry, next: ReportHistoryEntry): ReportChange {
  const c: ReportChange = {};
  if (prev.rating !== next.rating && (prev.rating || next.rating)) c.rating = { from: prev.rating, to: next.rating };
  if ((prev.targetCurrency ?? "") === (next.targetCurrency ?? "")) {
    const t = pct(prev.target, next.target);
    if (t !== undefined && t !== 0) c.targetPct = t;
  }
  if (prev.stars !== next.stars && (isNum(prev.stars) || isNum(next.stars))) c.stars = { from: prev.stars, to: next.stars };
  const fv = pct(prev.fairValue, next.fairValue);
  if (fv !== undefined && fv !== 0) c.fairValuePct = fv;
  if (prev.moat !== next.moat && (prev.moat || next.moat)) c.moat = { from: prev.moat, to: next.moat };
  if (prev.valuationBasis && next.valuationBasis && prev.valuationBasis.trim() !== next.valuationBasis.trim()) c.valuationBasisChanged = true;
  return c;
}
