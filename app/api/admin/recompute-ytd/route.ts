import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimModelGroup,
  PimProfileType,
  PimPerformanceData,
  PimModelPerformance,
  PimDailyReturn,
  AppendixData,
  PimPortfolioState,
  PimTransaction,
  PimPortfolioPositions,
} from "@/app/lib/pim-types";

const PIM_KEY = "pm:pim-models";
const PERF_KEY = "pm:pim-performance";
const APPENDIX_KEY = "pm:appendix-daily-values";
const STATE_KEY = "pm:pim-portfolio-state";
const POSITIONS_KEY = "pm:pim-positions";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/**
 * POST /api/admin/recompute-ytd
 *
 * Body: { profile?: PimProfileType, group?: string, fromDate?: string, dryRun?: boolean }
 *
 * Forward-simulates a profile's daily portfolio value through the
 * current year using:
 *   - Dec 31 (prior year) appendix value as the anchored baseline
 *   - Historical daily prices for every symbol the profile ever held
 *   - The actual transaction log to apply position changes on the
 *     dates they happened (units derived from targetWeight ×
 *     portfolioValueAtTxn / txn.price since txns don't store units)
 *
 * Writes the resulting daily returns + cumulative values back to
 * pm:pim-performance (model history) and pm:appendix-daily-values
 * (immutable ledger) for ENTRIES IN THE CURRENT YEAR ONLY. Pre-
 * current-year entries are preserved byte-for-byte.
 *
 * Stashes the existing blobs to *.pre-recompute-<ts> keys first so a
 * mistake is reversible.
 *
 * Supports dryRun=true (default false): runs the simulation and
 * returns the computed history without writing anything.
 *
 * Defaults: profile=allEquity, group=pim, fromDate=YYYY-01-01 of current
 * year, dryRun=false.
 */

type SymbolPriceHistory = Map<string, { date: string; close: number }[]>;

function isFundservCode(t: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(t);
}

function toYahoo(t: string): string {
  if (t.endsWith(".U")) return t.replace(/\.U$/, "-U.TO");
  if (t.endsWith("-T")) return t.replace(/-T$/, ".TO");
  return t;
}

async function fetchYahooHistory(t: string, fromDate: string): Promise<{ date: string; close: number }[]> {
  try {
    const sym = toYahoo(t);
    const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return [];
    const timestamps: number[] = r.timestamp ?? [];
    const adjcloses: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? [];
    const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
    // Prefer adjusted close (includes dividends) for accurate total return;
    // fall back to plain close when adjclose is missing.
    const series = adjcloses.length === timestamps.length ? adjcloses : closes;
    const out: { date: string; close: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = series[i];
      if (c == null || !isFinite(c)) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      out.push({ date, close: c });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchBarchartHistory(t: string): Promise<{ date: string; close: number }[]> {
  try {
    const sym = `${t}.CF`;
    const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(sym)}&data=daily&maxrecords=500&volume=contract&order=asc&dividends=false&backadjust=false`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": UA, Referer: "https://www.theglobeandmail.com/" },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const out: { date: string; close: number }[] = [];
    for (const line of text.trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length < 6) continue;
      const close = parseFloat(parts[5]);
      if (!isFinite(close)) continue;
      const raw = parts[1]?.trim();
      if (!raw) continue;
      let iso: string;
      if (raw.includes("/")) {
        const dp = raw.split("/");
        if (dp.length !== 3) continue;
        iso = `${dp[2]}-${dp[0].padStart(2, "0")}-${dp[1].padStart(2, "0")}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        iso = raw;
      } else continue;
      out.push({ date: iso, close });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

async function fetchUsdCadHistory(fromDate: string): Promise<{ date: string; rate: number }[]> {
  return (await fetchYahooHistory("USDCAD=X", fromDate)).map((r) => ({ date: r.date, rate: r.close }));
}

async function fetchAllPriceHistories(symbols: string[], fromDate: string): Promise<SymbolPriceHistory> {
  const map: SymbolPriceHistory = new Map();
  const unique = [...new Set(symbols)];
  const batchSize = 8;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (s) => {
        const hist = isFundservCode(s)
          ? await fetchBarchartHistory(s)
          : await fetchYahooHistory(s, fromDate);
        return { sym: s, hist };
      })
    );
    for (const r of results) map.set(r.sym, r.hist);
  }
  return map;
}

/** Build a map of (date → close) per symbol, with forward-fill so any
 *  missing-day gaps inherit the prior day's close. This is critical
 *  for FUNDSERV symbols whose NAVs publish on a 1-day lag. */
function indexPriceHistoriesForSimulation(
  histories: SymbolPriceHistory,
  tradingDates: string[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [sym, rows] of histories) {
    const indexed = new Map<string, number>();
    for (const r of rows) indexed.set(r.date, r.close);
    const filled = new Map<string, number>();
    let lastClose: number | null = null;
    for (const d of tradingDates) {
      const c = indexed.get(d);
      if (c != null && isFinite(c)) lastClose = c;
      if (lastClose != null) filled.set(d, lastClose);
    }
    out.set(sym, filled);
  }
  return out;
}

function indexFxForSimulation(
  fxRows: { date: string; rate: number }[],
  tradingDates: string[],
): Map<string, number> {
  const indexed = new Map<string, number>();
  for (const r of fxRows) indexed.set(r.date, r.rate);
  const filled = new Map<string, number>();
  let lastRate: number = 1;
  for (const d of tradingDates) {
    const r = indexed.get(d);
    if (r != null && isFinite(r) && r > 0) lastRate = r;
    filled.set(d, lastRate);
  }
  return filled;
}

/** Holding currency map from the PIM group model. */
function buildCurrencyMap(group: PimModelGroup): Map<string, "CAD" | "USD"> {
  const m = new Map<string, "CAD" | "USD">();
  for (const h of group.holdings) m.set(h.symbol, h.currency);
  return m;
}

type ProfileSimResult = {
  profile: PimProfileType;
  history: PimDailyReturn[];
  startValue: number;
  endValue: number;
  ytdReturnPct: number;
  daysSimulated: number;
  warnings: string[];
};

function getAssetAllocFromProfile(
  profileWeights: { fixedIncome: number; equity: number; alternatives: number } | undefined,
  assetClass: string,
): number {
  if (!profileWeights) return 0;
  if (assetClass === "equity") return profileWeights.equity;
  if (assetClass === "fixedIncome") return profileWeights.fixedIncome;
  if (assetClass === "alternative") return profileWeights.alternatives;
  return 0;
}

/**
 * Weights-based time-weighted return simulation.
 *
 * Tracks each holding's weight as a fraction of the portfolio (NOT units
 * — we don't have reliable unit history). Each trading day:
 *   1. Compute daily return per symbol = (price_today × fx_today) /
 *      (price_yesterday × fx_yesterday) − 1, in CAD terms.
 *   2. Portfolio daily return = sum(weight_i × return_i).
 *   3. Compound into the cumulative index.
 *   4. On rebalance days, update weights for symbols touched by txns
 *      (weight_i ← txn.targetWeight × profile_asset_class_allocation),
 *      then renormalize all weights to sum to profile_total_allocation
 *      (=1 for AllEquity). Renormalization redistributes the cash
 *      impact of added/removed positions proportionally — equivalent
 *      to saying "after the rebalance, the portfolio is fully invested
 *      to the new targets, with proceeds from sells funding the buys".
 *
 * Initial weights at the start of fromDate:
 *   - For each symbol in current pim-models for this profile's asset
 *     classes: weight = weightInClass × profileAssetAllocation.
 *   - Symbols whose earliest 2026 txn is a BUY are flagged as "added
 *     during year" and their initial weight is set to 0; the rebalance
 *     on that buy date promotes them into the portfolio.
 *   - Symbols that appear in 2026 txns but NOT in current pim-models
 *     are flagged as "removed during year"; their initial weight is
 *     approximated by the targetWeight on the earliest 2026 txn for
 *     that symbol (best available proxy for pre-year weight).
 *
 * No unit derivation — this completely sidesteps the over-counting
 * bug from the prior approach where each rebalance txn was being
 * treated as buying a full target-weight worth of units on top of
 * existing position.
 */
function simulateProfile(args: {
  group: PimModelGroup;
  profile: PimProfileType;
  fromDate: string;
  baselineValue: number;
  transactions: PimTransaction[];
  priceMaps: Map<string, Map<string, number>>;
  fxMap: Map<string, number>;
  tradingDates: string[];
  currencyOf: (sym: string) => "CAD" | "USD";
}): ProfileSimResult {
  const { group, profile, fromDate, baselineValue, transactions, priceMaps, fxMap, tradingDates, currencyOf } = args;
  const warnings: string[] = [];

  const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = profile === "alpha"
    ? ALPHA_WEIGHTS
    : group.profiles[profile];
  if (!profileWeights) {
    return { profile, history: [], startValue: baselineValue, endValue: baselineValue, ytdReturnPct: 0, daysSimulated: 0, warnings: [`profile ${profile} not configured`] };
  }
  const totalAlloc = (profileWeights.equity ?? 0) + (profileWeights.fixedIncome ?? 0) + (profileWeights.alternatives ?? 0);

  // Filter txns to this profile + current year + settled-only.
  const profileTxns = transactions
    .filter((t) => (t.profile ?? "balanced") === profile)
    .filter((t) => t.date.slice(0, 10) >= fromDate)
    .filter((t) => t.status !== "pending")
    .sort((a, b) => a.date.localeCompare(b.date));

  const txnsByDate = new Map<string, PimTransaction[]>();
  for (const t of profileTxns) {
    const d = t.date.slice(0, 10);
    const arr = txnsByDate.get(d) ?? [];
    arr.push(t);
    txnsByDate.set(d, arr);
  }

  // Find earliest 2026 txn per symbol to classify added/removed.
  const earliestTxnPerSymbol = new Map<string, PimTransaction>();
  for (const t of profileTxns) {
    const existing = earliestTxnPerSymbol.get(t.symbol);
    if (!existing || t.date < existing.date) earliestTxnPerSymbol.set(t.symbol, t);
  }

  // Build initial weights map.
  const weights = new Map<string, number>();
  const inPimModels = new Set(group.holdings.map((h) => h.symbol));
  for (const h of group.holdings) {
    const allocForClass = getAssetAllocFromProfile(profileWeights, h.assetClass);
    if (allocForClass <= 0) continue; // skip asset classes not in this profile
    const fullWeight = h.weightInClass * allocForClass;
    const earliest = earliestTxnPerSymbol.get(h.symbol);
    if (earliest && earliest.direction === "buy") {
      // Added during the year — start at 0; first-buy rebalance brings
      // it into the portfolio on its txn date.
      weights.set(h.symbol, 0);
    } else {
      weights.set(h.symbol, fullWeight);
    }
  }
  // Symbols that had 2026 txns but aren't in current pim-models =
  // removed during year. Approximate their start-of-year weight as the
  // first 2026 txn's targetWeight (best proxy we have).
  for (const [sym, txn] of earliestTxnPerSymbol) {
    if (inPimModels.has(sym)) continue;
    const allocForClass = (group.holdings.find((h) => h.symbol === sym)?.assetClass)
      ? getAssetAllocFromProfile(profileWeights, group.holdings.find((h) => h.symbol === sym)!.assetClass)
      : profileWeights.equity; // assume equity for removed-during-year names
    weights.set(sym, txn.targetWeight * allocForClass);
    warnings.push(`${profile}/${sym}: appears in 2026 txns but not in current pim-models — treated as removed-during-year, start weight = targetWeight × allocForClass = ${(txn.targetWeight * allocForClass * 100).toFixed(2)}%.`);
  }

  // Renormalize initial weights to sum to totalAlloc.
  const initialSum = [...weights.values()].reduce((s, w) => s + w, 0);
  if (initialSum > 0) {
    for (const [sym, w] of weights) weights.set(sym, (w / initialSum) * totalAlloc);
  } else {
    warnings.push(`${profile}: initial weights sum to 0 — no holdings in this profile`);
    return { profile, history: [], startValue: baselineValue, endValue: baselineValue, ytdReturnPct: 0, daysSimulated: 0, warnings };
  }

  // Walk forward day by day.
  let cumulativeIndex = baselineValue;
  const history: PimDailyReturn[] = [];
  // Anchor entry at day 0 — the baseline carried in from prior year.
  history.push({ date: tradingDates[0], value: parseFloat(cumulativeIndex.toFixed(4)), dailyReturn: 0 });

  for (let i = 1; i < tradingDates.length; i++) {
    const date = tradingDates[i];
    const prevDate = tradingDates[i - 1];

    // Compute weighted daily return using YESTERDAY's weights and
    // today-vs-yesterday price moves. Rebalance txns on `date` apply
    // AFTER the daily return is computed — they don't affect today's
    // return, only tomorrow's.
    const fxToday = fxMap.get(date) ?? 1;
    const fxPrev = fxMap.get(prevDate) ?? 1;
    let dailyReturn = 0;
    let coveredWeight = 0;
    for (const [sym, w] of weights) {
      if (w <= 0) continue;
      const pToday = priceMaps.get(sym)?.get(date);
      const pPrev = priceMaps.get(sym)?.get(prevDate);
      if (pToday == null || pPrev == null || pPrev <= 0) continue;
      const isUsd = currencyOf(sym) === "USD";
      const rCad = isUsd
        ? ((pToday * fxToday) / (pPrev * fxPrev)) - 1
        : (pToday / pPrev) - 1;
      dailyReturn += w * rCad;
      coveredWeight += w;
    }
    // Coverage adjustment: when a holding's price is missing for one of
    // the two days (typically FUNDSERV NAV lag), we exclude it from
    // BOTH sides of the daily return (the right thing — dollar-weighted
    // semantics in weight space). We do NOT scale up the remaining
    // weights to compensate; that's the historical activeWeight bug.
    // If coverage drops too low for the day to be meaningful, skip.
    if (coveredWeight < 0.3 * totalAlloc) {
      // Skip day — too sparse to be meaningful. Carry value forward.
      history.push({ date, value: parseFloat(cumulativeIndex.toFixed(4)), dailyReturn: 0 });
    } else {
      cumulativeIndex = cumulativeIndex * (1 + dailyReturn);
      history.push({
        date,
        value: parseFloat(cumulativeIndex.toFixed(4)),
        dailyReturn: parseFloat((dailyReturn * 100).toFixed(4)),
      });
    }

    // Apply rebalance txns on `date` — update weights, then renormalize.
    const txns = txnsByDate.get(date);
    if (txns && txns.length > 0) {
      for (const t of txns) {
        const sym = t.symbol;
        // The asset-class allocation for the txn symbol. If the symbol
        // is in current pim-models, look it up; else default to equity.
        const holding = group.holdings.find((h) => h.symbol === sym);
        const allocForClass = holding
          ? getAssetAllocFromProfile(profileWeights, holding.assetClass)
          : profileWeights.equity;
        weights.set(sym, t.targetWeight * allocForClass);
      }
      // Renormalize so weights sum to totalAlloc. This preserves the
      // total invested fraction across all asset classes (=1 for
      // AllEquity / Alpha; =0.66+0.28+0.06=1 for Balanced, etc.).
      const sum = [...weights.values()].reduce((s, w) => s + w, 0);
      if (sum > 0) {
        for (const [s, w] of weights) weights.set(s, (w / sum) * totalAlloc);
      }
    }
  }

  return {
    profile,
    history,
    startValue: baselineValue,
    endValue: cumulativeIndex,
    ytdReturnPct: (cumulativeIndex / baselineValue - 1) * 100,
    daysSimulated: history.length,
    warnings,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const profileFilter = typeof body?.profile === "string" ? (body.profile as PimProfileType) : null;
    const groupId = typeof body?.group === "string" ? body.group : "pim";
    const dryRun = Boolean(body?.dryRun);
    const todayIso = new Date().toISOString().slice(0, 10);
    const fromDate = typeof body?.fromDate === "string" ? body.fromDate : `${todayIso.slice(0, 4)}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, perfRaw, appendixRaw, stateRaw, positionsRaw] = await Promise.all([
      redis.get(PIM_KEY),
      redis.get(PERF_KEY),
      redis.get(APPENDIX_KEY),
      redis.get(STATE_KEY),
      redis.get(POSITIONS_KEY),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models not found" }, { status: 404 });

    const pimData = JSON.parse(pimRaw) as { groups: PimModelGroup[] };
    const group = pimData.groups.find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: `group ${groupId} not found` }, { status: 404 });

    const perf: PimPerformanceData = perfRaw
      ? JSON.parse(perfRaw)
      : { models: [], lastUpdated: new Date().toISOString() };
    const appendix: AppendixData = appendixRaw
      ? JSON.parse(appendixRaw)
      : { ledgers: [] };
    const portfolioState: PimPortfolioState | null = stateRaw ? JSON.parse(stateRaw) : null;
    const positionsBlob: { portfolios: PimPortfolioPositions[] } | null = positionsRaw
      ? JSON.parse(positionsRaw)
      : null;

    const groupState = portfolioState?.groupStates.find((gs) => gs.groupId === groupId);
    const txns = groupState?.transactions ?? [];

    const profiles: PimProfileType[] = profileFilter
      ? [profileFilter]
      : ((Object.keys(group.profiles) as PimProfileType[]).filter((p) => group.profiles[p]));

    // Build a unified trading-date axis from union of all available
    // price histories (Yahoo days are the natural cadence). We fetch
    // SPY's history as the canonical trading-day calendar.
    const calendar = await fetchYahooHistory("SPY", fromDate);
    const tradingDates = calendar.map((c) => c.date);
    if (tradingDates.length === 0) {
      return NextResponse.json({ error: "no trading dates fetched from calendar" }, { status: 500 });
    }

    // Collect every symbol the group has ever held + every symbol that
    // appears in this year's txns (in case a holding was sold off
    // entirely and is no longer in pim-models).
    const allSymbols = new Set<string>();
    for (const h of group.holdings) allSymbols.add(h.symbol);
    for (const t of txns) if (t.date.slice(0, 10) >= fromDate) allSymbols.add(t.symbol);

    // Fetch histories.
    const histories = await fetchAllPriceHistories([...allSymbols], fromDate);
    const fxRaw = await fetchUsdCadHistory(fromDate);
    const priceMaps = indexPriceHistoriesForSimulation(histories, tradingDates);
    const fxMap = indexFxForSimulation(fxRaw, tradingDates);
    const currencyMap = buildCurrencyMap(group);
    const currencyOf = (sym: string): "CAD" | "USD" => {
      const c = currencyMap.get(sym);
      if (c) return c;
      // Heuristic for symbols not in pim-models but present in txns
      if (sym.endsWith("-T")) return "CAD";
      if (sym.endsWith(".U") || sym.endsWith(".CF")) return "USD";
      return "USD";
    };

    // Run simulations per profile. The weights-based simulation
    // doesn't need positionsBlob — initial weights come from
    // pim-models, and rebalance txns drive weight updates.
    void positionsBlob; // intentionally unused — see comment above
    const results: ProfileSimResult[] = [];
    for (const profile of profiles) {
      // Baseline = last cumulative value in existing pre-fromDate
      // appendix (locked) or in pm:pim-performance, whichever is
      // available. The simulation will continue from there.
      const ledger = appendix.ledgers.find((l) => l.profile === profile);
      const lastPre = ledger?.entries
        .filter((e) => e.date < fromDate)
        .reduce<{ date: string; value: number } | null>((acc, e) => (acc == null || e.date > acc.date) ? { date: e.date, value: e.value } : acc, null);
      const perfModel = perf.models.find((m) => m.groupId === groupId && m.profile === profile);
      const perfLastPre = perfModel?.history
        .filter((e) => e.date < fromDate)
        .reduce<{ date: string; value: number } | null>((acc, e) => (acc == null || e.date > acc.date) ? { date: e.date, value: e.value } : acc, null);
      const baseline = lastPre?.value ?? perfLastPre?.value ?? 100;

      const sim = simulateProfile({
        group,
        profile,
        fromDate,
        baselineValue: baseline,
        transactions: txns,
        priceMaps,
        fxMap,
        tradingDates,
        currencyOf,
      });
      results.push(sim);
    }

    // Build before/after summary.
    const summary = results.map((r) => {
      const existingModel = perf.models.find((m) => m.groupId === groupId && m.profile === r.profile);
      const ledger = appendix.ledgers.find((l) => l.profile === r.profile);
      const computeYtd = (entries: Array<{ date: string; value: number }> | undefined): number | null => {
        if (!entries || entries.length === 0) return null;
        const fromEntry = entries.find((e) => e.date >= fromDate);
        if (!fromEntry) return null;
        const last = entries[entries.length - 1];
        if (fromEntry.value <= 0) return null;
        return (last.value / fromEntry.value - 1) * 100;
      };
      return {
        profile: r.profile,
        baselineValueAtPriorYearEnd: r.startValue,
        simulatedYtdReturnPct: parseFloat(r.ytdReturnPct.toFixed(2)),
        existingPerfYtdReturnPct: computeYtd(existingModel?.history) != null ? parseFloat((computeYtd(existingModel?.history) as number).toFixed(2)) : null,
        existingAppendixYtdReturnPct: computeYtd(ledger?.entries) != null ? parseFloat((computeYtd(ledger?.entries) as number).toFixed(2)) : null,
        daysSimulated: r.daysSimulated,
        warningCount: r.warnings.length,
        warnings: r.warnings.slice(0, 10), // first 10 only
      };
    });

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wrote: false,
        fromDate,
        groupId,
        summary,
        note: "dryRun=true — no data written. Inspect summary to confirm the new YTDs match expectations before re-running with dryRun=false.",
      });
    }

    // ─── WRITE PATH ───
    // STOP-AND-CONFIRM is enforced at the chat layer; this endpoint
    // doesn't fire on its own. The user explicitly POSTs without
    // dryRun=true to trigger the write.
    const ts = Date.now();
    if (perfRaw) await redis.set(`${PERF_KEY}.pre-recompute-${ts}`, perfRaw);
    if (appendixRaw) await redis.set(`${APPENDIX_KEY}.pre-recompute-${ts}`, appendixRaw);

    // Splice the new current-year entries INTO the existing series,
    // preserving everything before fromDate verbatim.
    const newPerf: PimPerformanceData = { ...perf, models: [...perf.models], lastUpdated: new Date().toISOString() };
    for (const r of results) {
      const idx = newPerf.models.findIndex((m) => m.groupId === groupId && m.profile === r.profile);
      const existing = idx >= 0 ? newPerf.models[idx] : null;
      const preEntries = (existing?.history ?? []).filter((e) => e.date < fromDate);
      const merged: PimModelPerformance = {
        groupId,
        profile: r.profile,
        history: [...preEntries, ...r.history],
        lastUpdated: new Date().toISOString(),
      };
      if (idx >= 0) newPerf.models[idx] = merged;
      else newPerf.models.push(merged);
    }

    const newAppendix: AppendixData = { ledgers: [...appendix.ledgers] };
    const now = new Date().toISOString();
    for (const r of results) {
      const idx = newAppendix.ledgers.findIndex((l) => l.profile === r.profile);
      const existing = idx >= 0 ? newAppendix.ledgers[idx] : null;
      const preEntries = (existing?.entries ?? []).filter((e) => e.date < fromDate);
      const newEntries = r.history.map((h) => ({
        date: h.date,
        value: h.value,
        dailyReturn: h.dailyReturn,
        addedAt: now,
      }));
      const ledger = { profile: r.profile, entries: [...preEntries, ...newEntries] };
      if (idx >= 0) newAppendix.ledgers[idx] = ledger;
      else newAppendix.ledgers.push(ledger);
    }

    await redis.set(PERF_KEY, JSON.stringify(newPerf));
    await redis.set(APPENDIX_KEY, JSON.stringify(newAppendix));

    return NextResponse.json({
      ok: true,
      dryRun: false,
      wrote: true,
      fromDate,
      groupId,
      stashKeys: { perf: perfRaw ? `${PERF_KEY}.pre-recompute-${ts}` : null, appendix: appendixRaw ? `${APPENDIX_KEY}.pre-recompute-${ts}` : null },
      summary,
    });
  } catch (e) {
    console.error("recompute-ytd error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
