/**
 * Own-history valuation band (audit Finding 13).
 *
 * The historicalValuation rubric demands "compare CURRENT multiples to the
 * company's OWN history" — but nothing in the pipeline supplied historical
 * multiples: the FactSet snapshot carries only current-point valuation, and
 * FG_PE(ANN,-i) cross-sectionally echoes the current P/E (see the note in
 * factset-fundamentals.ts). The category was effectively graded from model
 * memory, an occasional Street Takeaways line, or web_search. This module
 * pulls the TRUE point-in-time band: FG_PE monthly over 5 years via the
 * FactSet time-series batch flow, summarised as min / p25 / median / p75 /
 * max plus the current value's percentile within that history.
 *
 * Cache: pm:factset-valband:{TICKER}, 7-day TTL (the band moves slowly).
 * Failure-open by design: any relay error, timeout, or unexpected payload
 * shape returns null — the rescore proceeds without the block, exactly the
 * status quo — and logs a truncated payload snippet so a shape mismatch is
 * visible in Vercel logs and fixable in one edit.
 */
import { getRedis } from "./redis";
import { timeSeriesBatch } from "./factset";
import { createLogger } from "./logger";

const log = createLogger("ValBand");

export type ValuationBand = {
  formula: string;
  years: number;
  n: number;             // usable monthly points
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  current: number;       // latest point in the series
  percentile: number;    // 0-100: where current sits in the full history
  fetchedAt: string;
};

const CACHE_TTL_SEC = 7 * 24 * 3600;
/** Batch polling budget. The band fetch runs inside the score route's
 *  parallel fetch stage, so this bounds added latency on a cache miss. */
const MAX_WAIT_MS = 15_000;
/** Fewer than 2 years of monthly points → the band is not a "history". */
const MIN_POINTS = 24;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Pull the numeric series out of the batch-result payload. The completed
 *  payload is the cross-sectional shape ({ data: [dataItems] }) where the
 *  formula's dataItem carries one result per iteration date. Tolerant: takes
 *  the first dataItem whose result array holds mostly finite numbers, and
 *  ignores requestId/date items. Returns null (and logs a snippet) when no
 *  such item exists — never throws. */
function extractSeries(result: unknown): number[] | null {
  const data = (result as { data?: Array<{ dataItemName?: string; result?: unknown[] }> })?.data;
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    const name = String(item?.dataItemName ?? "").toLowerCase();
    if (name === "requestid" || name === "date" || name === "dates") continue;
    const arr = Array.isArray(item?.result) ? item.result : null;
    if (!arr || arr.length < 2) continue;
    const nums = arr.filter((v): v is number => typeof v === "number" && isFinite(v));
    // "Mostly numeric" guards against picking a string column (e.g. dates).
    if (nums.length >= Math.max(MIN_POINTS, arr.length * 0.5)) return nums;
  }
  return null;
}

/**
 * The 5y monthly FG_PE band for one FactSet id, cache-first.
 * `ticker` keys the cache; `factsetId` drives the relay query.
 */
export async function getValuationBand(
  ticker: string,
  factsetId: string,
  formula = "FG_PE",
  years = 5,
): Promise<ValuationBand | null> {
  const key = `pm:factset-valband:${ticker.toUpperCase()}`;
  let redis: Awaited<ReturnType<typeof getRedis>> | null = null;
  try {
    redis = await getRedis();
    const cached = await redis.get(key);
    if (cached) {
      const band = JSON.parse(cached) as ValuationBand;
      if (typeof band?.median === "number") return band;
    }
  } catch { /* cache miss path */ }

  try {
    const end = new Date();
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - years);
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const out = await timeSeriesBatch(factsetId, formula, ymd(start), ymd(end), "M", {
      maxWaitMs: MAX_WAIT_MS,
    });
    if (out.status !== "SUCCESS") {
      log.warn(`${ticker}: batch status ${out.status} — no band this run`);
      return null;
    }
    const series = extractSeries(out.result);
    if (!series || series.length < MIN_POINTS) {
      log.warn(
        `${ticker}: unusable series (${series?.length ?? 0} points) — payload snippet: ${JSON.stringify(out.result).slice(0, 400)}`,
      );
      return null;
    }
    // Negative P/E months (loss periods) are excluded from the band — a
    // negative multiple isn't "cheap", it's non-meaningful for this purpose.
    const positive = series.filter((v) => v > 0);
    if (positive.length < MIN_POINTS) {
      log.warn(`${ticker}: only ${positive.length} positive points — band skipped`);
      return null;
    }
    const current = positive[positive.length - 1];
    const sorted = [...positive].sort((a, b) => a - b);
    const below = sorted.filter((v) => v <= current).length;
    const band: ValuationBand = {
      formula,
      years,
      n: positive.length,
      min: sorted[0],
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      max: sorted[sorted.length - 1],
      current,
      percentile: Math.round((below / sorted.length) * 100),
      fetchedAt: new Date().toISOString(),
    };
    try {
      await redis?.set(key, JSON.stringify(band), { EX: CACHE_TTL_SEC });
    } catch { /* cache write is best-effort */ }
    return band;
  } catch (e) {
    log.warn(`${ticker}: band fetch failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Prompt block. Empty string when no band. */
export function formatValuationBandForPrompt(band: ValuationBand | null): string {
  if (!band) return "";
  const f = (v: number) => v.toFixed(1);
  return [
    `=== OWN-HISTORY VALUATION BAND (FactSet time-series, ${band.years}y monthly, point-in-time) ===`,
    `${band.formula}: current ${f(band.current)}x — sits at the ${band.percentile}th percentile of its own ${band.years}-year history (${band.n} monthly points).`,
    `Band: min ${f(band.min)}x | p25 ${f(band.p25)}x | median ${f(band.median)}x | p75 ${f(band.p75)}x | max ${f(band.max)}x. Loss-making months (negative multiple) excluded.`,
    `This block is the PRIMARY evidence for historicalValuation — grade the category from this percentile (low percentile with intact fundamentals → high score; high percentile without acceleration → low score) and cite it as source: "factset" (sourceDetail "FactSet 5y P/E band"). It supersedes model memory of where this name "usually" trades. If the sector playbook names a different primary multiple for this business (P/FFO, P/B, EV/EBITDA), treat this P/E band as a secondary cross-check and say so.`,
  ].join("\n");
}
