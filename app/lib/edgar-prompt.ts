/**
 * Format an issuer's normalized EDGAR XBRL snapshot as a text block for
 * the score prompt. Returns null for non-US tickers (Canadian -T/.TO,
 * OTC, ADRs without filings) so the caller can fall back to Yahoo
 * cleanly.
 *
 * Includes per-metric STALE markers when the most recent observation
 * is more than 18 months old. The score prompt is instructed to skip
 * stale fields rather than anchor on them — handles edge cases like
 * Apple's interestExpense (genuinely not tagged discretely post-FY24).
 *
 * Output is dense human-readable text designed for Claude consumption,
 * not for API consumers — line lengths and number formatting are
 * tuned for the model rather than for parseability.
 */

import { getCikForTicker, getCompanyFacts } from "./edgar";
import { classifyIssuer } from "./edgar-industry";
import { buildScoringSnapshot } from "./edgar-concepts";

const STALE_THRESHOLD_DAYS = 540; // 18 months

function isStale(endDate: string): boolean {
  const ageDays = (Date.now() - new Date(endDate).getTime()) / 86400000;
  return ageDays > STALE_THRESHOLD_DAYS;
}

function fmtUSD(val: number): string {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3)  return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString()}`;
}

function fmtShares(val: number): string {
  if (Math.abs(val) >= 1e9) return `${(val / 1e9).toFixed(3)}B shares`;
  if (Math.abs(val) >= 1e6) return `${(val / 1e6).toFixed(1)}M shares`;
  return `${val.toLocaleString()} shares`;
}

function fmtValue(val: number, unit: string): string {
  if (unit === "USD/shares") return `$${val.toFixed(2)}/sh`;
  if (unit === "shares") return fmtShares(val);
  return fmtUSD(val);
}

/**
 * Returns a multi-line text block describing the issuer's recent
 * fundamentals, or null if the ticker isn't in SEC EDGAR (non-US,
 * delisted, OTC). Safe to call in parallel with Yahoo fetches —
 * caches mean repeat calls within 24h are essentially free.
 */
export async function formatEdgarSnapshotForPrompt(ticker: string): Promise<string | null> {
  try {
    const cikInfo = await getCikForTicker(ticker);
    if (!cikInfo) return null;
    const facts = await getCompanyFacts(ticker);
    if (!facts) return null;
    const classification = await classifyIssuer(cikInfo.paddedCik);
    const snapshot = buildScoringSnapshot(facts, classification.industry);

    const lines: string[] = [];
    lines.push(`=== SEC EDGAR XBRL FINANCIALS (as-reported, audited) ===`);
    lines.push(`Issuer: ${facts.entityName} (CIK ${cikInfo.paddedCik})`);
    lines.push(`Industry classification: ${classification.industry}` +
      (classification.sic ? ` (SIC ${classification.sic} — ${classification.sicDescription})` : ""));
    lines.push(``);
    lines.push(`These figures come directly from the company's 10-K and 10-Q filings,`);
    lines.push(`normalized through the freshness-aware concept registry. PREFER these`);
    lines.push(`numbers over Yahoo Finance for fundamental metrics (revenue, EPS, debt,`);
    lines.push(`cash, OCF, equity, etc.) — EDGAR is the as-reported audited source.`);
    lines.push(`Yahoo data is still useful for current price, beta, market cap, and`);
    lines.push(`sentiment-style metrics that EDGAR doesn't carry.`);
    lines.push(``);
    lines.push(`Format: each metric shows the concept tag used, latest filing, and`);
    lines.push(`up to 5 annual prints. Fields marked [STALE] have not been reported`);
    lines.push(`in over 18 months — DO NOT use these as a current snapshot; either`);
    lines.push(`omit the analysis for that metric or note the issuer no longer reports it.`);
    lines.push(``);

    let staleCount = 0;
    let freshCount = 0;
    for (const [metric, info] of Object.entries(snapshot)) {
      if (!info.latest) continue;
      const stale = isStale(info.latest.end);
      if (stale) staleCount++; else freshCount++;
      const staleMarker = stale ? ` [STALE — last filed ${info.latest.end}]` : "";

      lines.push(`${metric}${staleMarker}`);
      lines.push(`  concept: ${info.conceptUsed}`);
      lines.push(`  latest (${info.latest.end}, ${info.latest.form}): ${fmtValue(info.latest.val, info.unit)}`);

      if (info.annual.length >= 2) {
        const recent = info.annual.slice(0, 5);
        const seriesStr = recent
          .map((f) => `${f.end.slice(0, 4)}=${fmtValue(f.val, info.unit)}`)
          .join("  ");
        lines.push(`  annual: ${seriesStr}`);

        if (recent.length >= 2 && recent[1].val !== 0) {
          const yoy = ((recent[0].val - recent[1].val) / Math.abs(recent[1].val)) * 100;
          lines.push(`  YoY: ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%`);
        }

        if (recent.length >= 5 && recent[4].val !== 0) {
          // 4-year CAGR (5 prints span 4 periods)
          const cagr = (Math.pow(recent[0].val / recent[4].val, 1 / 4) - 1) * 100;
          if (isFinite(cagr)) {
            lines.push(`  4Y CAGR: ${cagr >= 0 ? "+" : ""}${cagr.toFixed(1)}%`);
          }
        }
      }
      lines.push(``);
    }

    lines.push(`Coverage summary: ${freshCount} fresh metrics, ${staleCount} stale.`);
    return lines.join("\n");
  } catch (err) {
    console.error(`[EDGAR] snapshot failed for ${ticker}:`, err);
    return null;
  }
}
