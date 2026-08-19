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
 * STATUS (2026-08-19): DELIBERATELY STOPPED PARTWAY — not abandoned or broken.
 * Jordan opted to upgrade the library going FORWARD (every new upload already
 * carries the new fields) rather than pay to re-extract the whole ~118-slot
 * archive, on the reasoning that reports older than ~90 days are demoted to
 * background context by the scoring prompt anyway and their "dated catalysts"
 * have usually already passed. The batches that did run are stored and valid.
 * This endpoint is left in place, inert (dry-run unless &confirm=YES), because
 * it is the right tool if the extraction schema is widened again. Hit it with
 * no params any time to see how many slots still predate the current schema.
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
 *   - &limit=N caps how many reports are processed in one call (default 8,
 *     max 24); the loop ALSO stops early on a wall-clock budget so the route
 *     never dies mid-write. Re-run the returned `continueAt` until
 *     `remaining` is 0 — the work list re-derives each call, so a timed-out
 *     or abandoned run simply picks up where it left off.
 *
 * CONCURRENCY / WRITE SAFETY: extractions run CONCURRENTLY (pure reads +
 * Anthropic), but every successful result is applied in ONE read-modify-write
 * at the end of the call. Writing per-report while extracting in parallel
 * would have two workers read the same pm:analyst-reports blob and the later
 * write would clobber the earlier one's field — the exact closure/race
 * data-loss pattern this repo has been bitten by before.
 */
export const maxDuration = 60;

/** How many PDFs to extract at once. Anthropic handles this comfortably and
 *  it's what makes a 60s window fit ~8 reports instead of ~2. */
const CONCURRENCY = 4;
/** Stop starting new work past this mark, leaving headroom for the final
 *  read-modify-write inside maxDuration. */
const TIME_BUDGET_MS = 40_000;
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "YES";
  const limit = Math.max(1, Math.min(24, parseInt(url.searchParams.get("limit") || "8", 10) || 8));

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
  const applied: Array<{ ticker: string; source: "rbc" | "jpm" | "morningstar"; result: ExtractedReport }> = [];
  const startedAt = Date.now();
  let stoppedEarly = false;

  // Extract concurrently in chunks; NO Redis writes inside the loop.
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      stoppedEarly = true;
      break;
    }
    const chunk = batch.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (w) => {
        try {
          const dataUrl = await getDataUrl(`analyst-reports/${w.id}`);
          if (!dataUrl) {
            results.push({ ticker: w.ticker, source: w.source, status: "pdf-missing-in-blob" });
            return;
          }
          const { result } = await extractAnalystReport({
            ticker: w.ticker,
            source: w.source,
            dataUrl,
            force: true,
          });
          applied.push({ ticker: w.ticker, source: w.source, result });
          const newFields = [
            result.catalysts?.length ? `catalysts(${result.catalysts.length})` : null,
            result.valuationBasis ? "valuationBasis" : null,
            result.scenarios ? "scenarios" : null,
          ].filter((x): x is string => !!x);
          results.push({ ticker: w.ticker, source: w.source, status: "reextracted", newFields });
          log.info(`${w.ticker}/${w.source} re-extracted; new fields: ${newFields.join(", ") || "none present in PDF"}`);
        } catch (e) {
          results.push({
            ticker: w.ticker,
            source: w.source,
            status: `error: ${e instanceof Error ? e.message : String(e)}`,
          });
          log.error(`${w.ticker}/${w.source} failed:`, e);
        }
      }),
    );
  }

  // ── ONE read-modify-write for the whole batch ────────────────────────
  // Re-read first: another upload could have landed while we were extracting.
  // Only the extracted slots are touched; every other ticker/source and every
  // unknown field on the manifest passes through untouched.
  let written = 0;
  if (applied.length > 0) {
    const latestRaw = await redis.get("pm:analyst-reports");
    const latest = latestRaw ? (JSON.parse(latestRaw) as AnalystReports) : {};
    const now = new Date().toISOString();
    for (const a of applied) {
      const slot = latest[a.ticker]?.[a.source];
      if (!slot) {
        // Slot vanished mid-run (deleted/renamed) — skip rather than recreate.
        const row = results.find((r) => r.ticker === a.ticker && r.source === a.source);
        if (row) row.status = "slot-gone-skipped";
        continue;
      }
      slot.extracted = a.result;
      slot.extractedAt = now;
      written++;
    }
    await redis.set("pm:analyst-reports", JSON.stringify(latest));
  }

  const attempted = results.length;
  const remaining = work.length - attempted;
  return NextResponse.json({
    ok: true,
    stash: stashKey,
    attempted,
    written,
    remaining,
    stoppedEarly,
    elapsedMs: Date.now() - startedAt,
    results,
    ...(remaining > 0
      ? { continueAt: `${url.origin}${url.pathname}?confirm=YES&limit=${limit}` }
      : { done: "All archived reports re-extracted." }),
  });
}
