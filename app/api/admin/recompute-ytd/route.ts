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

/** Derive units for a transaction. Uses targetWeight × portfolioValue /
 *  price. Mutual-fund pending txns (price=0) are handled separately —
 *  they only settle later when NAV publishes, recorded as a separate
 *  trade. For now we approximate by using the day's close NAV as the
 *  execution price. */
function deriveUnits(
  txn: PimTransaction,
  portfolioValueCadAtTxn: number,
  priceCadAtTxn: number,
): number {
  if (priceCadAtTxn <= 0) return 0;
  const targetValue = portfolioValueCadAtTxn * txn.targetWeight;
  return targetValue / priceCadAtTxn;
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

function simulateProfile(args: {
  group: PimModelGroup;
  profile: PimProfileType;
  fromDate: string;
  baselineValue: number;
  currentPositions: PimPortfolioPositions | null;
  transactions: PimTransaction[];
  priceMaps: Map<string, Map<string, number>>;
  fxMap: Map<string, number>;
  tradingDates: string[];
  currencyOf: (sym: string) => "CAD" | "USD";
}): ProfileSimResult {
  const { group, profile, fromDate, baselineValue, currentPositions, transactions, priceMaps, fxMap, tradingDates, currencyOf } = args;
  const warnings: string[] = [];

  // Filter txns to this profile in the current year.
  const profileTxns = transactions
    .filter((t) => (t.profile ?? "balanced") === profile)
    .filter((t) => t.date.slice(0, 10) >= fromDate)
    .filter((t) => t.status !== "pending") // pending mutual fund trades not yet settled
    .sort((a, b) => a.date.localeCompare(b.date));

  // Group txns by date (per profile, per date). All txns on the same
  // date are applied atomically using that date's prices.
  const txnsByDate = new Map<string, PimTransaction[]>();
  for (const t of profileTxns) {
    const d = t.date.slice(0, 10);
    const arr = txnsByDate.get(d) ?? [];
    arr.push(t);
    txnsByDate.set(d, arr);
  }

  // Reconstruct positions at the START of the current year. We have
  // current positions; reverse the net delta of each symbol's 2026 txns
  // to get pre-year units. Without txn units we approximate by using
  // the target-weight implied units at each txn date; sum the deltas
  // for each symbol; subtract from current units.
  //
  // CAVEAT: this is approximate. If the user's txn log has imports
  // without targetWeight or with stale targetWeight, the reconstructed
  // pre-year position will drift from reality. We surface that as a
  // warning if any reconstructed unit count goes negative (data
  // anomaly) and clamp to zero.
  const currentUnitMap = new Map<string, number>();
  if (currentPositions) {
    for (const p of currentPositions.positions) currentUnitMap.set(p.symbol, p.units);
  }

  // First pass: walk forward day by day to compute portfolio value at
  // each txn date, deriving units from targetWeight × value / price.
  // We need an initial position state. Solve iteratively:
  // - Iteration 0: assume current positions held all year. Compute daily
  //   values. Use those values to derive txn units. Track net delta per
  //   symbol. Initial-of-year units = current units - net delta.
  // - This is a single-pass approximation that's good enough when daily
  //   values don't swing wildly relative to txn sizes.

  type DailyPositionState = Map<string, number>; // symbol → units

  // Approximation: start with current units, run forward applying
  // transactions, see resulting end-of-period units. If end-of-period
  // doesn't match current (it won't), the difference is what the
  // start-of-period units should have been. Re-anchor and run again.
  const computeNetDeltaPerSymbol = (units: DailyPositionState): Map<string, number> => {
    const delta = new Map<string, number>();
    for (const [date, txns] of txnsByDate) {
      // Estimate portfolio value at this date using current `units` state
      // and prices on this date.
      let portfolioValueCad = currentPositions?.cashBalance ?? 0;
      for (const [sym, u] of units) {
        const p = priceMaps.get(sym)?.get(date);
        if (p == null) continue;
        const fx = currencyOf(sym) === "USD" ? (fxMap.get(date) ?? 1) : 1;
        portfolioValueCad += u * p * fx;
      }
      for (const t of txns) {
        const sym = t.symbol;
        const priceLocal = t.price > 0 ? t.price : (priceMaps.get(sym)?.get(date) ?? 0);
        if (priceLocal <= 0) {
          warnings.push(`${profile}/${sym} on ${date}: no price available, txn skipped`);
          continue;
        }
        const fx = currencyOf(sym) === "USD" ? (fxMap.get(date) ?? 1) : 1;
        const priceCad = priceLocal * fx;
        const tradedUnits = deriveUnits(t, portfolioValueCad, priceCad);
        const signedUnits = t.direction === "buy" ? tradedUnits : -tradedUnits;
        delta.set(sym, (delta.get(sym) ?? 0) + signedUnits);
      }
    }
    return delta;
  };

  // First-pass delta using current units as initial state
  const firstPassDelta = computeNetDeltaPerSymbol(currentUnitMap);
  const startOfYearUnits: DailyPositionState = new Map();
  for (const [sym, u] of currentUnitMap) {
    const delta = firstPassDelta.get(sym) ?? 0;
    const startUnits = u - delta;
    if (startUnits < -0.01) {
      warnings.push(`${profile}/${sym}: reconstructed start-of-year units = ${startUnits.toFixed(2)} (negative — txn log may be missing entries before this year, or txn targetWeights produced over-large unit deltas). Clamped to 0.`);
    }
    startOfYearUnits.set(sym, Math.max(0, startUnits));
  }
  // Symbols sold off entirely during the year (no current units, but had
  // 2026 txns) — add them back with the positive of their net sell delta.
  for (const [sym, delta] of firstPassDelta) {
    if (!startOfYearUnits.has(sym)) {
      // Current units = 0, delta is net of sells (negative), so start = -delta.
      const start = -delta;
      if (start > 0) startOfYearUnits.set(sym, start);
    }
  }

  // Now walk forward day by day computing portfolio value and daily
  // returns. cashBalance approximated as 0 historically (rebalance
  // trades net to ~0 cash flow; we ignore external cash flows since
  // we have no record of them).
  const units: DailyPositionState = new Map(startOfYearUnits);
  let cash = 0;

  const history: PimDailyReturn[] = [];
  // Anchor: baseline value at the day BEFORE fromDate (Dec 31 of
  // prior year). The baseline maps to the cumulative index value
  // carried in from the locked pre-current-year history.
  let prevValueCad = 0;
  for (const [sym, u] of units) {
    const p = priceMaps.get(sym)?.get(tradingDates[0]);
    if (p == null) continue;
    const fx = currencyOf(sym) === "USD" ? (fxMap.get(tradingDates[0]) ?? 1) : 1;
    prevValueCad += u * p * fx;
  }
  if (prevValueCad <= 0) {
    warnings.push(`${profile}: initial portfolio value at ${tradingDates[0]} is zero — cannot compute daily returns. Check txn log and position data.`);
    return {
      profile,
      history: [],
      startValue: baselineValue,
      endValue: baselineValue,
      ytdReturnPct: 0,
      daysSimulated: 0,
      warnings,
    };
  }

  let cumulativeIndex = baselineValue;
  // First entry: anchor day (no return, just the baseline).
  history.push({ date: tradingDates[0], value: parseFloat(cumulativeIndex.toFixed(4)), dailyReturn: 0 });

  for (let i = 1; i < tradingDates.length; i++) {
    const date = tradingDates[i];

    // Apply any txns on this date BEFORE computing the day's close
    // value. Trades are assumed cash-neutral.
    const txns = txnsByDate.get(date);
    if (txns) {
      for (const t of txns) {
        const sym = t.symbol;
        const priceLocal = t.price > 0 ? t.price : (priceMaps.get(sym)?.get(date) ?? 0);
        if (priceLocal <= 0) continue;
        const fx = currencyOf(sym) === "USD" ? (fxMap.get(date) ?? 1) : 1;
        const priceCad = priceLocal * fx;
        // Recompute portfolio value JUST BEFORE the trade using prev
        // day's units × today's prices (mark-to-market for trade sizing).
        let portfolioValueCadNow = cash;
        for (const [s, u] of units) {
          const p = priceMaps.get(s)?.get(date);
          if (p == null) continue;
          const fxs = currencyOf(s) === "USD" ? (fxMap.get(date) ?? 1) : 1;
          portfolioValueCadNow += u * p * fxs;
        }
        const tradedUnits = deriveUnits(t, portfolioValueCadNow, priceCad);
        const signedUnits = t.direction === "buy" ? tradedUnits : -tradedUnits;
        units.set(sym, (units.get(sym) ?? 0) + signedUnits);
        // Cash-neutral assumption: buys/sells offset each other on a
        // rebalance day. Single-leg trades would have a cash impact;
        // ignored for simplicity.
      }
    }

    // Compute today's end-of-day portfolio value.
    let todayValueCad = cash;
    for (const [sym, u] of units) {
      if (u <= 0) continue;
      const p = priceMaps.get(sym)?.get(date);
      if (p == null) continue;
      const fx = currencyOf(sym) === "USD" ? (fxMap.get(date) ?? 1) : 1;
      todayValueCad += u * p * fx;
    }
    if (todayValueCad <= 0) {
      warnings.push(`${profile}/${date}: portfolio value collapsed to 0. Skipping day.`);
      continue;
    }

    const dailyRet = (todayValueCad - prevValueCad) / prevValueCad;
    cumulativeIndex = cumulativeIndex * (1 + dailyRet);
    history.push({
      date,
      value: parseFloat(cumulativeIndex.toFixed(4)),
      dailyReturn: parseFloat((dailyRet * 100).toFixed(4)),
    });
    prevValueCad = todayValueCad;
  }

  void group; // model holdings list is only used for currency lookup, already extracted

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

    // Run simulations per profile.
    const results: ProfileSimResult[] = [];
    for (const profile of profiles) {
      const currentPositions = positionsBlob?.portfolios.find((p) => p.groupId === groupId && p.profile === profile) ?? null;

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
        currentPositions,
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
