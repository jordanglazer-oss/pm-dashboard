import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  AnalystSnapshots,
  AnalystReports,
  TickerSnapshot,
  AnalystEntry,
} from "@/app/lib/analyst-snapshots";
import { computeAnalystConsensus, buildConsensusExplanation } from "@/app/lib/analyst-snapshots";
import type { Stock } from "@/app/lib/types";

const SNAPSHOTS_KEY = "pm:analyst-snapshots";
const REPORTS_KEY = "pm:analyst-reports";
const STOCKS_KEY = "pm:stocks";

/**
 * POST /api/admin/backfill-analyst-fx
 *
 * One-shot migration: for every analyst snapshot entry that has a `target`
 * but no `targetCurrency`, look up the extracted `targetCurrency` from
 * pm:analyst-reports and convert the target using the report-date FX rate.
 *
 * Zero Anthropic token cost — uses already-extracted report metadata + Yahoo
 * FX rates only.
 *
 * Query params:
 *   ?dry=1  — preview what would change without writing to Redis
 *
 * Safety:
 *   - Only touches entries that have target but no targetCurrency
 *   - Skips entries where the report extraction also lacks targetCurrency
 *   - Skips entries where the target currency matches the stock currency
 *   - Preserves all other fields
 */
export async function POST(request: NextRequest) {
  const dry = request.nextUrl.searchParams.get("dry") === "1";

  try {
    const redis = await getRedis();
    const [snapshotsRaw, reportsRaw, stocksRaw] = await Promise.all([
      redis.get(SNAPSHOTS_KEY),
      redis.get(REPORTS_KEY),
      redis.get(STOCKS_KEY),
    ]);

    const snapshots: AnalystSnapshots = snapshotsRaw
      ? (typeof snapshotsRaw === "string" ? JSON.parse(snapshotsRaw) : snapshotsRaw) as AnalystSnapshots
      : {};
    const reports: AnalystReports = reportsRaw
      ? (typeof reportsRaw === "string" ? JSON.parse(reportsRaw) : reportsRaw) as AnalystReports
      : {};
    const stocks: Stock[] = stocksRaw
      ? (typeof stocksRaw === "string" ? JSON.parse(stocksRaw) : stocksRaw) as Stock[]
      : [];

    // Build ticker → stock currency map
    const stockCurrencyMap: Record<string, string> = {};
    for (const s of stocks) {
      const key = s.ticker.toUpperCase();
      // Prefer stored Yahoo currency, fall back to heuristic
      if (s.currency) {
        stockCurrencyMap[key] = s.currency;
      } else if (s.ticker.endsWith("-T") || s.ticker.endsWith(".TO")) {
        stockCurrencyMap[key] = "CAD";
      } else if (s.ticker.endsWith(".U")) {
        stockCurrencyMap[key] = "USD";
      } else {
        stockCurrencyMap[key] = "USD";
      }
    }

    const results: Array<{
      ticker: string;
      source: "rbc" | "jpm";
      oldTarget: number;
      newTarget: number;
      fromCurrency: string;
      toCurrency: string;
      fxRate: number;
      fxDate: string;
      reportDate: string | undefined;
    }> = [];
    const skipped: Array<{ ticker: string; source: string; reason: string }> = [];

    // Iterate all snapshot entries
    for (const [ticker, snap] of Object.entries(snapshots)) {
      for (const source of ["rbc", "jpm"] as const) {
        const entry = snap[source];
        if (!entry?.target) continue;
        if (entry.targetCurrency || entry.targetOriginal) {
          // Already has currency info — skip
          continue;
        }

        // Look up the extracted targetCurrency from the report manifest
        const reportForTicker = reports[ticker];
        const reportMeta = reportForTicker?.[source];
        const extractedCurrency = reportMeta?.extracted?.targetCurrency?.toUpperCase();

        if (!extractedCurrency) {
          skipped.push({ ticker, source, reason: "No targetCurrency in extracted report data" });
          continue;
        }

        // Determine stock's trading currency
        const stockCcy = stockCurrencyMap[ticker.toUpperCase()] ?? "USD";

        if (extractedCurrency === stockCcy) {
          // Same currency — no conversion needed, but mark it so the
          // "Fix ccy" dropdown doesn't show
          if (!dry) {
            snapshots[ticker] = {
              ...snap,
              [source]: {
                ...entry,
                // Set targetOriginal = target and targetCurrency to signal
                // "this has been checked" without actually changing the value
                targetCurrency: extractedCurrency,
                lastUpdated: new Date().toISOString(),
              } as AnalystEntry,
            };
          }
          skipped.push({ ticker, source, reason: `Same currency (${extractedCurrency} = ${stockCcy}), marked` });
          continue;
        }

        // Fetch historical FX rate for the report date
        const reportDate = entry.asOf;
        const fxPair = `${extractedCurrency}${stockCcy}`;
        const dateParam = reportDate ? `&date=${reportDate}` : "";

        try {
          // Use the app's own fx-rate endpoint
          const baseUrl = request.nextUrl.origin;
          const fxRes = await fetch(`${baseUrl}/api/fx-rate?pair=${fxPair}${dateParam}`);
          if (!fxRes.ok) {
            skipped.push({ ticker, source, reason: `FX fetch failed: ${fxRes.status} for ${fxPair}` });
            continue;
          }
          const fxData = await fxRes.json();
          const rate = fxData.rate;
          if (typeof rate !== "number" || rate <= 0) {
            skipped.push({ ticker, source, reason: `Invalid FX rate for ${fxPair}: ${rate}` });
            continue;
          }

          const originalTarget = entry.target;
          const convertedTarget = Math.round(originalTarget * rate * 100) / 100;

          results.push({
            ticker,
            source,
            oldTarget: originalTarget,
            newTarget: convertedTarget,
            fromCurrency: extractedCurrency,
            toCurrency: stockCcy,
            fxRate: rate,
            fxDate: fxData.date,
            reportDate,
          });

          if (!dry) {
            snapshots[ticker] = {
              ...snapshots[ticker],
              [source]: {
                ...entry,
                target: convertedTarget,
                targetOriginal: originalTarget,
                targetCurrency: extractedCurrency,
                fxRate: rate,
                lastUpdated: new Date().toISOString(),
              } as AnalystEntry,
            };
          }
        } catch (e) {
          skipped.push({
            ticker,
            source,
            reason: `FX error: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }

    // Also recompute analystConsensus scores for affected tickers
    const affectedTickers = new Set(results.map((r) => r.ticker));
    const scoreUpdates: Array<{ ticker: string; oldScore: number; newScore: number }> = [];

    if (!dry && affectedTickers.size > 0) {
      // Write updated snapshots
      await redis.set(SNAPSHOTS_KEY, JSON.stringify(snapshots));

      // Update scores on the stock objects
      const updatedStocks = stocks.map((s) => {
        const key = s.ticker.toUpperCase();
        if (!affectedTickers.has(key) && !affectedTickers.has(s.ticker)) return s;
        const snap: TickerSnapshot | undefined = snapshots[key] ?? snapshots[s.ticker];
        if (!snap) return s;
        const oldScore = s.scores?.analystConsensus ?? 0;
        const consensus = computeAnalystConsensus(snap, s.price);
        const explanation = buildConsensusExplanation(consensus);
        scoreUpdates.push({ ticker: s.ticker, oldScore, newScore: consensus.score });
        return {
          ...s,
          scores: { ...s.scores, analystConsensus: consensus.score },
          explanations: { ...s.explanations, analystConsensus: explanation },
        };
      });
      await redis.set(STOCKS_KEY, JSON.stringify(updatedStocks));
    }

    return NextResponse.json({
      dry,
      converted: results,
      skipped,
      scoreUpdates: dry ? [] : scoreUpdates,
      summary: `${results.length} targets converted, ${skipped.length} skipped`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
