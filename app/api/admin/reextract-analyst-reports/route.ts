import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { blobConfigured, getDataUrl } from "@/app/lib/blob-store";
import { extractAnalystReport } from "@/app/lib/analyst-extract";
import type { AnalystReports, ExtractedReport } from "@/app/lib/analyst-snapshots";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Reextract-reports");

/**
 * GET /api/admin/reextract-analyst-reports
 *
 * One-shot backfill for audit Finding 14: the PDF extraction schema was
 * widened (dated catalysts, valuation basis, scenario targets), and every
 * archived report PDF in Blob (analyst-reports/<id>) can be re-extracted so
 * the EXISTING library carries the new fields — not just future uploads.
 *
 * For each pm:analyst-reports entry that has a pdfUrl and is missing any of
 * the new fields: read the PDF back from Blob, re-run extractAnalystReport
 * with force (one Anthropic call per report — bounded, one-time spend), and
 * MERGE the fresh extraction over the stored one (read-modify-write; rating/
 * target/asOf that feed analystConsensus are preserved from the fresh
 * extraction of the SAME PDF, so nothing regresses).
 *
 * SAFETY (per the repo's admin-endpoint rules):
 *   - DRY RUN by default: lists what would be re-extracted, spends nothing.
 *   - &confirm=YES to apply.
 *   - Before the first write, the prior pm:analyst-reports blob is stashed at
 *     pm:analyst-reports.pre-reextract-<ts> (the standard rollback pattern).
 *   - Returns a per-report diff summary (which new fields landed).
 *   - &limit=N caps how many reports are processed in one call (default 10)
 *     so the route stays under maxDuration; re-run until `remaining` is 0.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "YES";
  const limit = Math.max(1, Math.min(25, parseInt(url.searchParams.get("limit") || "10", 10) || 10));

  if (!blobConfigured()) {
    return NextResponse.json({ error: "BLOB_READ_WRITE_TOKEN not set." }, { status: 500 });
  }

  const redis = await getRedis();
  const raw = await redis.get("pm:analyst-reports");
  if (!raw) return NextResponse.json({ ok: true, message: "pm:analyst-reports is empty — nothing to do." });
  const reports = JSON.parse(raw) as AnalystReports;

  const hasNewFields = (r: ExtractedReport | undefined) =>
    !!r && (r.catalysts !== undefined || r.valuationBasis !== undefined || r.scenarios !== undefined);

  // Work list: every (ticker, source) slot with an archived PDF whose stored
  // extraction predates the widened schema.
  const work: Array<{ ticker: string; source: "rbc" | "jpm" | "morningstar"; id: string }> = [];
  for (const [ticker, slots] of Object.entries(reports)) {
    for (const source of ["rbc", "jpm", "morningstar"] as const) {
      const meta = slots[source];
      if (!meta?.pdfUrl) continue;
      if (hasNewFields(meta.extracted)) continue; // already upgraded
      work.push({ ticker, source, id: meta.id });
    }
  }

  if (!confirm) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      pending: work.length,
      wouldReextract: work.map((w) => `${w.ticker}/${w.source}`),
      estimatedAnthropicCalls: work.length,
      apply: `${url.origin}${url.pathname}?confirm=YES&limit=${limit}`,
    });
  }

  // Stash the prior blob once per run (rollback story).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stashKey = `pm:analyst-reports.pre-reextract-${stamp}`;
  await redis.set(stashKey, raw, { EX: 14 * 24 * 3600 });

  const batch = work.slice(0, limit);
  const results: Array<{ ticker: string; source: string; status: string; newFields?: string[] }> = [];

  for (const w of batch) {
    try {
      const dataUrl = await getDataUrl(`analyst-reports/${w.id}`);
      if (!dataUrl) {
        results.push({ ticker: w.ticker, source: w.source, status: "pdf-missing-in-blob" });
        continue;
      }
      const { result } = await extractAnalystReport({
        ticker: w.ticker,
        source: w.source,
        dataUrl,
        force: true,
      });
      // Read-modify-write against the LATEST blob each iteration (another
      // upload could land mid-run); merge the fresh extraction over the slot.
      const latestRaw = await redis.get("pm:analyst-reports");
      const latest = latestRaw ? (JSON.parse(latestRaw) as AnalystReports) : {};
      const slot = latest[w.ticker]?.[w.source];
      if (!slot) {
        results.push({ ticker: w.ticker, source: w.source, status: "slot-gone-skipped" });
        continue;
      }
      slot.extracted = result;
      slot.extractedAt = new Date().toISOString();
      await redis.set("pm:analyst-reports", JSON.stringify(latest));
      const newFields = [
        result.catalysts?.length ? `catalysts(${result.catalysts.length})` : null,
        result.valuationBasis ? "valuationBasis" : null,
        result.scenarios ? "scenarios" : null,
      ].filter((x): x is string => !!x);
      results.push({ ticker: w.ticker, source: w.source, status: "reextracted", newFields });
      log.info(`${w.ticker}/${w.source} re-extracted; new fields: ${newFields.join(", ") || "none found in PDF"}`);
    } catch (e) {
      results.push({ ticker: w.ticker, source: w.source, status: `error: ${e instanceof Error ? e.message : String(e)}` });
      log.error(`${w.ticker}/${w.source} failed:`, e);
    }
  }

  return NextResponse.json({
    ok: true,
    stash: stashKey,
    processed: results.length,
    remaining: work.length - batch.length,
    results,
    ...(work.length - batch.length > 0
      ? { continueAt: `${url.origin}${url.pathname}?confirm=YES&limit=${limit}` }
      : {}),
  });
}
