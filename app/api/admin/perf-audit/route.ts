import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimModelGroup, PimProfileType, PimPerformanceData, AppendixData } from "@/app/lib/pim-types";

const PIM_KEY = "pm:pim-models";
const PERF_KEY = "pm:pim-performance";
const APPENDIX_KEY = "pm:appendix-daily-values";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/**
 * GET /api/admin/perf-audit?profile=allEquity&from=2026-01-01
 *
 * Per-holding YTD audit for a given PIM profile. Surfaces exactly where
 * the dashboard's stored cumulative return differs from what the actual
 * holdings did over the period — pinpoints which holdings have stale or
 * missing price data, which contribute disproportionately to the gap,
 * etc.
 *
 * For each equity / FI / alt holding in the PIM group's profile:
 *   - actualReturnPct over the window (price now vs price at `from`)
 *   - source: yahoo (for stocks / ETFs / .U / -T) or barchart (FUNDSERV)
 *     or "—" if no price data available
 *   - weightInPortfolio = weightInClass × profile asset-class allocation
 *   - contributionPct = actualReturnPct × weightInPortfolio
 *
 * Aggregate:
 *   - sumContributions: expected portfolio return if every holding's
 *     individual return is weighted by its model weight. This is the
 *     "what the chart SHOULD show" number.
 *   - storedPortfolioReturn: what pm:pim-performance / pm:appendix
 *     actually shows for the same window.
 *   - gap: stored − expected. Negative gap = dashboard under-tracking
 *     (likely culprit: missing/stale fund NAVs).
 *
 * Defaults: profile=allEquity, from=2026-01-01.
 */

type AuditRow = {
  symbol: string;
  name?: string;
  assetClass: string;
  currency: string;
  weightInClass: number;
  weightInPortfolio: number;
  source: "yahoo" | "barchart" | "—";
  priceAtStart: number | null;
  priceNow: number | null;
  actualReturnPct: number | null;
  contributionPct: number | null;
  flags: string[];
};

function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

async function fetchYahooPriceAtAndNow(
  ticker: string,
  fromDate: string,
): Promise<{ priceAtStart: number | null; priceNow: number | null }> {
  try {
    const yahooSymbol = toYahoo(ticker);
    const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return { priceAtStart: null, priceNow: null };
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return { priceAtStart: null, priceNow: null };
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const valid = closes.filter((c): c is number => c != null && c > 0);
    if (valid.length < 2) return { priceAtStart: null, priceNow: null };
    // Use the live regularMarketPrice if available for "now"; else last close.
    const liveNow = result.meta?.regularMarketPrice ?? null;
    return {
      priceAtStart: valid[0],
      priceNow: (liveNow != null && liveNow > 0) ? liveNow : valid[valid.length - 1],
    };
  } catch {
    return { priceAtStart: null, priceNow: null };
  }
}

async function fetchBarchartPriceAtAndNow(
  ticker: string,
  fromDate: string,
): Promise<{ priceAtStart: number | null; priceNow: number | null }> {
  // Barchart gives us up to 500 records of history; pull a wide window
  // so we definitely have coverage from `from` through today.
  try {
    const symbol = `${ticker}.CF`;
    const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(symbol)}&data=daily&maxrecords=500&volume=contract&order=asc&dividends=false&backadjust=false`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": UA,
        Referer: "https://www.theglobeandmail.com/",
      },
    });
    if (!res.ok) return { priceAtStart: null, priceNow: null };
    const text = await res.text();
    const rows: Array<{ date: string; close: number }> = [];
    for (const line of text.trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length < 6) continue;
      const close = parseFloat(parts[5]);
      if (!isFinite(close)) continue;
      const rawDate = parts[1]?.trim();
      if (!rawDate) continue;
      let iso: string;
      if (rawDate.includes("/")) {
        const dp = rawDate.split("/");
        if (dp.length !== 3) continue;
        iso = `${dp[2]}-${dp[0].padStart(2, "0")}-${dp[1].padStart(2, "0")}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        iso = rawDate;
      } else continue;
      rows.push({ date: iso, close });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length === 0) return { priceAtStart: null, priceNow: null };
    // First close on/after fromDate; last close overall.
    const startRow = rows.find((r) => r.date >= fromDate);
    return {
      priceAtStart: startRow ? startRow.close : null,
      priceNow: rows[rows.length - 1].close,
    };
  } catch {
    return { priceAtStart: null, priceNow: null };
  }
}

function getAssetAlloc(profileWeights: { fixedIncome: number; equity: number; alternatives: number }, assetClass: string): number {
  if (assetClass === "fixedIncome") return profileWeights.fixedIncome;
  if (assetClass === "equity") return profileWeights.equity;
  if (assetClass === "alternative") return profileWeights.alternatives;
  return 0;
}

function computeStoredReturn(
  perf: PimPerformanceData | null,
  appendix: AppendixData | null,
  groupId: string,
  profile: PimProfileType,
  fromDate: string,
): { fromPerf: number | null; fromAppendix: number | null; fromChainedAppendix: number | null } {
  const perfModel = perf?.models.find((m) => m.groupId === groupId && m.profile === profile);
  const ledger = appendix?.ledgers.find((l) => l.profile === profile);

  // Period return from perfBlob (stored value): last/baseline − 1
  const computeFromValues = (entries: Array<{ date: string; value: number }> | undefined) => {
    if (!entries || entries.length === 0) return null;
    let baseline: number | null = null;
    for (const e of entries) {
      if (e.date >= fromDate) { baseline = e.value; break; }
    }
    if (baseline == null || baseline <= 0) return null;
    const last = entries[entries.length - 1].value;
    return (last / baseline - 1) * 100;
  };

  // Period return by chaining dailyReturn fields — independent check
  // that bypasses the stored cumulative.
  const computeFromChain = (entries: Array<{ date: string; dailyReturn: number }> | undefined) => {
    if (!entries || entries.length === 0) return null;
    let mult = 1;
    let started = false;
    for (const e of entries) {
      if (e.date < fromDate) continue;
      if (!started) { started = true; continue; } // skip baseline day's "return"
      mult *= 1 + (e.dailyReturn ?? 0) / 100;
    }
    return started ? (mult - 1) * 100 : null;
  };

  return {
    fromPerf: computeFromValues(perfModel?.history),
    fromAppendix: computeFromValues(ledger?.entries),
    fromChainedAppendix: computeFromChain(ledger?.entries),
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const profile = ((url.searchParams.get("profile") || "allEquity") as PimProfileType);
    const fromDate = url.searchParams.get("from") || "2026-01-01";
    const groupId = url.searchParams.get("group") || "pim";

    const redis = await getRedis();
    const [pimRaw, perfRaw, appendixRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(PERF_KEY),
      redis.get(APPENDIX_KEY),
    ]);

    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models not found" }, { status: 404 });
    const pimData = JSON.parse(pimRaw) as { groups: PimModelGroup[] };
    const group = pimData.groups.find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: `group ${groupId} not found` }, { status: 404 });

    const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
    const profileWeights = profile === "alpha"
      ? ALPHA_WEIGHTS
      : group.profiles[profile];
    if (!profileWeights) {
      return NextResponse.json({ error: `profile ${profile} not configured for ${groupId}` }, { status: 404 });
    }

    const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
    const appendix = appendixRaw ? (JSON.parse(appendixRaw) as AppendixData) : null;

    // Fetch live prices + period-start prices for every holding in
    // parallel batches. FUNDSERV codes go to Barchart; everything else
    // to Yahoo. The split is the most likely source of staleness.
    const holdings = group.holdings;
    const batchSize = 10;
    const rows: AuditRow[] = [];
    for (let i = 0; i < holdings.length; i += batchSize) {
      const batch = holdings.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (h) => {
        const alloc = getAssetAlloc(profileWeights, h.assetClass);
        const weightInPortfolio = h.weightInClass * alloc;
        const source: "yahoo" | "barchart" | "—" = isFundservCode(h.symbol)
          ? "barchart"
          : "yahoo";
        const { priceAtStart, priceNow } = source === "barchart"
          ? await fetchBarchartPriceAtAndNow(h.symbol, fromDate)
          : await fetchYahooPriceAtAndNow(h.symbol, fromDate);
        const actualReturnPct = (priceAtStart != null && priceNow != null && priceAtStart > 0)
          ? ((priceNow - priceAtStart) / priceAtStart) * 100
          : null;
        const contributionPct = actualReturnPct != null
          ? actualReturnPct * weightInPortfolio
          : null;
        const flags: string[] = [];
        if (priceAtStart == null) flags.push(`no price on/after ${fromDate}`);
        if (priceNow == null) flags.push("no current price");
        if (weightInPortfolio === 0) flags.push("zero portfolio weight (profile alloc excludes this class)");
        return {
          symbol: h.symbol,
          name: h.name,
          assetClass: h.assetClass,
          currency: h.currency,
          weightInClass: parseFloat((h.weightInClass * 100).toFixed(4)),
          weightInPortfolio: parseFloat((weightInPortfolio * 100).toFixed(4)),
          source,
          priceAtStart: priceAtStart != null ? parseFloat(priceAtStart.toFixed(4)) : null,
          priceNow: priceNow != null ? parseFloat(priceNow.toFixed(4)) : null,
          actualReturnPct: actualReturnPct != null ? parseFloat(actualReturnPct.toFixed(2)) : null,
          contributionPct: contributionPct != null ? parseFloat(contributionPct.toFixed(4)) : null,
          flags,
        } as AuditRow;
      }));
      rows.push(...results);
    }

    // Aggregate: sum the contributions (in % of portfolio).
    // contributionPct already incorporates the asset-class allocation;
    // summing across all holdings gives the expected portfolio return.
    const sumContrib = rows.reduce((s, r) => s + (r.contributionPct ?? 0), 0);
    const missingWeight = rows
      .filter((r) => r.contributionPct == null && r.weightInPortfolio > 0)
      .reduce((s, r) => s + r.weightInPortfolio, 0);

    const stored = computeStoredReturn(perf, appendix, groupId, profile, fromDate);

    // Per-holding gap explainer: which holdings contribute most to a
    // potential mis-tracking. Surface the top 5 by absolute contribution.
    const topContributors = [...rows]
      .filter((r) => r.contributionPct != null)
      .sort((a, b) => Math.abs((b.contributionPct ?? 0)) - Math.abs((a.contributionPct ?? 0)))
      .slice(0, 10)
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        source: r.source,
        weightInPortfolio: r.weightInPortfolio,
        actualReturnPct: r.actualReturnPct,
        contributionPct: r.contributionPct,
      }));

    return NextResponse.json({
      group: groupId,
      profile,
      fromDate,
      asOf: new Date().toISOString(),
      summary: {
        expectedPortfolioReturnPct: parseFloat(sumContrib.toFixed(2)),
        storedPerfBlobReturnPct: stored.fromPerf != null ? parseFloat(stored.fromPerf.toFixed(2)) : null,
        storedAppendixReturnPct: stored.fromAppendix != null ? parseFloat(stored.fromAppendix.toFixed(2)) : null,
        chainedAppendixReturnPct: stored.fromChainedAppendix != null ? parseFloat(stored.fromChainedAppendix.toFixed(2)) : null,
        gapVsPerfPct: stored.fromPerf != null ? parseFloat((stored.fromPerf - sumContrib).toFixed(2)) : null,
        weightWithMissingPriceData: parseFloat((missingWeight * 100).toFixed(2)),
      },
      topContributors,
      holdings: rows,
      hint: "Negative gapVsPerfPct = dashboard under-tracking vs what holdings actually did. Look at FUNDSERV (barchart) source rows for stale-NAV culprits, and weightWithMissingPriceData for holes in coverage.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
