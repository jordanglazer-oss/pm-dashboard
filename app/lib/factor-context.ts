import { crossSectional, factsetConfigured, relayRetry, type FactsetValue } from "./factset";
import { resolveFactsetId } from "./factset-symbols";
import { readUniverse, deriveMetrics, RAW_FORMULAS, LOWER_IS_BETTER, type FactorMetric } from "./factor-universe";
import { computeFactorScore, FACTOR_GROUPS } from "./factors";

/**
 * Sector-relative factor context for the SCORING PROMPT (the "#4 injection",
 * 2026-07-18). Computes the stock's sign-normalized z-scores vs its full GICS
 * sector distribution (~60–500 names from pm:factor-universe) and formats them
 * as a plain-text block the scoring model reads when grading the fundamental /
 * valuation categories.
 *
 * Deliberately CONTEXT, not a score: category definitions, scales, and maxes
 * are unchanged — this only sharpens the information behind the same grades.
 * Best-effort by design: any failure (no universe yet, unresolvable ticker,
 * FactSet hiccup) returns null and the rescore proceeds exactly as before.
 *
 * NOTE for Phase C validation: from 2026-07-18 onward, rescored 41-pt values
 * are partially informed by the quant lens (this block), so the two lenses are
 * no longer fully independent. The factor-history dates let the IC analysis
 * segment pre/post this epoch.
 */

const METRIC_LABEL: Record<FactorMetric, string> = {
  fcfMargin: "FCF margin",
  operMgn: "Operating margin",
  operMgnTrend: "Operating-margin trend (y/y)",
  roe: "ROE",
  accruals: "Accruals (NI−OCF)/assets",
  debtEbitda: "Debt / EBITDA",
  intCoverage: "Interest coverage",
  revGrowth: "Revenue growth (y/y)",
  epsGrowth: "EPS growth (y/y)",
  pe: "P/E",
  pbk: "P/B",
  psales: "P/S",
  evEbitda: "EV/EBITDA",
  fcfYield: "FCF yield",
  mom12_1: "12M−1M price momentum",
  mom6_1: "6M−1M price momentum",
};

const GROUP_LABEL: Record<string, string> = {
  quality: "QUALITY",
  growth: "GROWTH",
  valuation: "VALUATION",
  momentum: "MOMENTUM",
};

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

/** Build the prompt block, or null when unavailable (never throws). */
export async function factorContextBlock(ticker: string): Promise<string | null> {
  try {
    if (!factsetConfigured()) return null;
    const universe = await readUniverse();
    if (!universe) return null;
    const resolved = resolveFactsetId(ticker.trim().toUpperCase());
    if (resolved.source !== "factset") return null;

    const data = await relayRetry(() =>
      crossSectional([resolved.id], Object.values(RAW_FORMULAS) as unknown as string[]),
    );
    const row = data[resolved.id];
    if (!row) return null;

    const raw: Record<string, number | string> = {};
    for (const [key, formula] of Object.entries(RAW_FORMULAS)) {
      const v: FactsetValue | undefined = row[formula];
      if (key === "sector") {
        if (typeof v === "string" && v) raw.sector = v;
      } else if (typeof v === "number" && isFinite(v)) {
        raw[key] = v;
      }
    }
    const sector = typeof raw.sector === "string" ? raw.sector : "";
    if (!sector) return null;
    const metrics = deriveMetrics(raw as never);
    const score = computeFactorScore(metrics, sector, universe);
    if (!score) return null;

    const peerCount = universe.sectors[sector]?.n ?? 0;
    const lines: string[] = [];
    lines.push(`=== SECTOR-RELATIVE FACTOR CONTEXT (FactSet, computed) ===`);
    lines.push(
      `${ticker.toUpperCase()} vs ${peerCount} ${sector} peers (S&P 500 + TSX 60 universe). ` +
        `Each line: metric value, then its z-score vs the sector distribution. ` +
        `ALL z-scores are SIGN-NORMALIZED: positive ALWAYS = favorable vs peers (for lower-is-better ` +
        `metrics like P/E or Debt/EBITDA the sign is already flipped). |z| > 1 is a meaningful gap; |z| > 2 is extreme.`,
    );
    for (const [group, keys] of Object.entries(FACTOR_GROUPS)) {
      const rows: string[] = [];
      for (const k of keys) {
        const z = score.perMetric[k];
        const v = metrics[k];
        if (z == null || v == null) continue;
        const dir = z > 0.25 ? "favorable" : z < -0.25 ? "unfavorable" : "in line";
        const flipped = LOWER_IS_BETTER.has(k) ? " (lower-is-better, sign flipped)" : "";
        rows.push(`  ${METRIC_LABEL[k]}: ${fmt(v)} | z ${z > 0 ? "+" : ""}${z.toFixed(2)} → ${dir} vs sector${flipped}`);
      }
      if (rows.length) {
        const g = score.groups[group];
        lines.push(`${GROUP_LABEL[group] ?? group}${g != null ? ` (group mean z ${g > 0 ? "+" : ""}${g.toFixed(2)})` : ""}:`);
        lines.push(...rows);
      }
    }
    lines.push(
      `Composite: ${score.percentile}th percentile within ${sector} (sector-relative fundamentals + momentum profile).`,
    );
    lines.push(
      `USAGE: these are computed cross-sectional facts — treat them as TIER-1 supporting evidence for the ` +
        `relativeValuation, historicalValuation, growth, leverageCoverage, and cashFlowQuality categories, ` +
        `alongside (not replacing) the named-peer comparisons and absolute financials above. They answer the ` +
        `question the named peers can't: where this company sits in the FULL sector distribution. Cite them with ` +
        `source: "factset" and sourceDetail: "sector z-score vs ${peerCount} ${sector} peers". Category scales and ` +
        `definitions are UNCHANGED — this block only sharpens the evidence behind the same grades.`,
    );
    return lines.join("\n");
  } catch (e) {
    console.warn(`[FactorContext] block failed for ${ticker}:`, e instanceof Error ? e.message : e);
    return null;
  }
}
