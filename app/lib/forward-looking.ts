// Forward-looking market data with direct sources for verification.
// Every data point returns { value, source, asOf, previous? } so the user
// can click through and sanity-check any number we feed to the morning
// brief. FRED is used when FRED_API_KEY is set (more accurate for rates
// and credit); otherwise we fall back to Yahoo Finance everywhere.

import { getRedis } from "./redis";

// Per-point freshness so the UI can render a badge that tells the user
// whether a number was actually just pulled ("live"), is an old cached
// value from FRED's delayed publishing cycle ("stale"), couldn't be
// reached at all ("failed"), or needs configuration the user hasn't done
// yet ("not-configured", e.g. FRED_API_KEY missing).
export type ForwardStatus = "live" | "stale" | "failed" | "not-configured";

export type ForwardPoint = {
  value: number | null;
  source: string; // clickable URL the user can verify
  sourceLabel: string; // human-readable source name
  asOf: string; // ISO timestamp for the underlying data
  previous?: number | null; // prior-period value used for deltas
  note?: string; // optional methodology caveat
  status: ForwardStatus;
  // Optional sparkline series. Daily samples sorted oldest→newest. Used by
  // the sentiment tiles (CNN F&G, AAII bull-bear, S&P Oscillator) so the PM
  // can see the trajectory at a glance instead of just the spot reading.
  // Only points that have a true historical series populate this — anything
  // else leaves it undefined and the UI degrades to "no chart".
  history?: SparkPoint[];
  // Optional momentum stats derived from history. When present, lets the
  // brief prompt and the tile captions describe trajectory in plain English
  // ("falling, 8th percentile of 1Y range") instead of just a spot value.
  trend?: TrendStats;
};

export type SparkPoint = { date: string; value: number };

// Multi-horizon momentum stats computed once from a SparkPoint series.
// All deltas are absolute (current - lag-N), not percentage moves, because
// the inputs are already on bounded/index scales (F&G 0-100, AAII bull-bear
// is itself a percentage spread, oscillator is a small signed number).
// percentile is 0-100, where 0 = at the trailing-window minimum and 100 =
// at the trailing-window maximum. trajectory is a one-word descriptor for
// human consumption — derived from the most relevant horizon for the series.
export type TrendStats = {
  current: number;
  delta1w?: number | null; // value - value ~5 trading days ago (or 1 weekly bar)
  delta1m?: number | null; // ~21 trading days / ~4 weekly bars
  delta3m?: number | null; // ~63 trading days / ~13 weekly bars
  rangeLow: number; // min over the trailing window
  rangeHigh: number; // max over the trailing window
  percentile: number; // 0-100, where current sits inside [rangeLow, rangeHigh]
  trajectory: "falling fast" | "falling" | "stable" | "rising" | "rising fast";
};

// Generic trend computer. Caller picks the lag offsets so daily series
// (F&G, oscillator) and weekly series (AAII) both feed the same shape.
// `velocityThresholds` defines what counts as "fast" — e.g. for F&G a 1m
// move of >20 is dramatic, for AAII bull-bear >15pp is dramatic.
function computeTrendStats(
  history: SparkPoint[],
  opts: {
    lag1w: number;
    lag1m: number;
    lag3m: number;
    fastThreshold: number; // |delta1m| >= this → "rising/falling fast"
    slowThreshold: number; // |delta1m| <  this → "stable"
  }
): TrendStats | null {
  if (!history || history.length < 2) return null;
  const n = history.length;
  const current = history[n - 1].value;
  const at = (lag: number): number | null => {
    if (lag <= 0 || n - 1 - lag < 0) return null;
    return history[n - 1 - lag].value;
  };
  const v1w = at(opts.lag1w);
  const v1m = at(opts.lag1m);
  const v3m = at(opts.lag3m);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const delta1w = v1w != null ? round1(current - v1w) : null;
  const delta1m = v1m != null ? round1(current - v1m) : null;
  const delta3m = v3m != null ? round1(current - v3m) : null;
  // Use whichever is the largest available window for the range computation,
  // capped at 1Y of daily samples (252) so we don't drag in stale data.
  const windowLen = Math.min(n, Math.max(opts.lag3m, opts.lag1m, opts.lag1w) + 1, 252);
  const windowVals = history.slice(n - windowLen).map((p) => p.value);
  const rangeLow = Math.min(...windowVals);
  const rangeHigh = Math.max(...windowVals);
  const span = rangeHigh - rangeLow;
  const percentile =
    span === 0 ? 50 : Math.round(((current - rangeLow) / span) * 100);
  // Pick the best trajectory descriptor from whichever delta we have. Prefer
  // 1m for stability; fall back to 1w if the series is too short.
  const trajectoryDelta = delta1m ?? delta1w ?? 0;
  const abs = Math.abs(trajectoryDelta);
  let trajectory: TrendStats["trajectory"];
  if (abs >= opts.fastThreshold) {
    trajectory = trajectoryDelta < 0 ? "falling fast" : "rising fast";
  } else if (abs < opts.slowThreshold) {
    trajectory = "stable";
  } else {
    trajectory = trajectoryDelta < 0 ? "falling" : "rising";
  }
  return {
    current: round1(current),
    delta1w,
    delta1m,
    delta3m,
    rangeLow: round1(rangeLow),
    rangeHigh: round1(rangeHigh),
    percentile,
    trajectory,
  };
}

export type ForwardLookingData = {
  spxYtd: ForwardPoint; // S&P 500 % change YTD
  spxWeek: ForwardPoint; // S&P 500 % change trailing 5 days
  spyForwardPE: ForwardPoint; // SPY forward P/E (proxy for S&P 500)
  spyTrailingPE: ForwardPoint; // SPY trailing 12m P/E
  impliedEpsGrowth: ForwardPoint; // (trailing/forward - 1), % implied fwd EPS growth
  eps35Growth: ForwardPoint; // SSGA "Estimated 3-5 Year EPS Growth" — analyst consensus CAGR
  yield10y: ForwardPoint; // 10Y Treasury
  yield2y: ForwardPoint; // 2Y Treasury (FRED only)
  yield3m: ForwardPoint; // 3M T-Bill
  curve10y2y: ForwardPoint; // 10Y-2Y spread (bps)
  curve10y3m: ForwardPoint; // 10Y-3M spread (bps)
  hyOasTrend: ForwardPoint; // HY OAS current vs ~5d ago (bps), FRED only
  igOasTrend: ForwardPoint; // IG OAS current vs ~5d ago (bps), FRED only
  vixWeek: ForwardPoint; // VIX now vs ~5 trading days ago
  moveWeek: ForwardPoint; // MOVE now vs ~5 trading days ago
  breadth200Wk: ForwardPoint; // % of S&P above 200DMA with ~5 trading day prior
  breadth200Mo: ForwardPoint; // % of S&P above 200DMA with ~21 trading day prior
  breadth50Wk: ForwardPoint; // % of S&P above 50DMA with ~5 trading day prior
  // ── Sentiment tiles with sparkline history ──
  fearGreed: ForwardPoint; // CNN Fear & Greed (0-100), 1Y daily history
  aaiiBullBear: ForwardPoint; // AAII Bull-Bear spread %, last ~52 weekly readings
  aaiiBull: ForwardPoint; // AAII bullish %
  aaiiNeutral: ForwardPoint; // AAII neutral %
  aaiiBear: ForwardPoint; // AAII bearish %
  spOscillator: ForwardPoint; // S&P Oscillator manual entry, history is whatever
                              // the PM has typed in over time (Redis-backed)
  fredEnabled: boolean;
  fetchedAt: string;
};

const YH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type YahooChartResult = {
  meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
  indicators?: { quote?: { close?: (number | null)[] }[] };
};

async function yahooChart(
  symbol: string,
  range: string
): Promise<YahooChartResult | null> {
  // Attach cookie+crumb if we can get them. Not strictly required for the
  // v8 chart endpoint yet, but some edge regions now 401 without it. Fall
  // back to anonymous request if auth fetch fails — chart is the cheapest
  // endpoint and occasionally works unauthenticated where quoteSummary
  // won't.
  const auth = await getYahooAuth().catch(() => null);
  const baseUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=1d&includePrePost=false${
    auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ""
  }`;
  try {
    const res = await fetch(baseUrl, {
      headers: {
        "User-Agent": YH_UA,
        Accept: "application/json",
        ...(auth ? { Cookie: auth.cookie } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.chart?.result?.[0] ?? null) as YahooChartResult | null;
  } catch {
    return null;
  }
}

// ── Stooq free daily CSV ─────────────────────────────────────────────────
// Stooq.com publishes free end-of-day CSV downloads with no auth or rate
// limiting, and it's the industry-standard Yahoo Finance backup for hobby
// projects. We use it for index series (^spx, ^vix, ^move, spy.us) whenever
// FRED doesn't have the series or Yahoo refuses our requests. The CSV
// shape is: Date,Open,High,Low,Close,Volume
export type DailyRow = { date: string; close: number };

async function fetchStooqDaily(symbol: string): Promise<DailyRow[] | null> {
  try {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
      symbol.toLowerCase()
    )}&i=d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": YH_UA,
        Accept: "text/csv,text/plain,*/*",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 20 || /no data/i.test(text)) return null;
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const header = lines[0].toLowerCase().split(",");
    const dateIdx = header.indexOf("date");
    const closeIdx = header.indexOf("close");
    if (dateIdx === -1 || closeIdx === -1) return null;
    const rows: DailyRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length <= closeIdx) continue;
      const d = parts[dateIdx];
      const c = parseFloat(parts[closeIdx]);
      if (d && !isNaN(c)) rows.push({ date: d, close: c });
    }
    if (rows.length === 0) return null;
    // Sort descending so rows[0] is the most recent trading day, matching
    // FRED's sort_order=desc output.
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));
    return rows;
  } catch {
    return null;
  }
}

// ── SSGA official SPY product page scrape ────────────────────────────────
// State Street publishes trailing ("Price/Earnings"), forward
// ("Price/Earnings Ratio FY1"), and 3-5 year analyst-consensus EPS growth
// ("Estimated 3-5 Year EPS Growth") on SPY's official fund page. Because
// it's the issuer's own site the numbers are authoritative and rarely
// change structure. We parse the first numeric after each label — the
// label-to-value distance is small in the rendered table markup.
async function fetchSsgaSpyData(): Promise<{
  forwardPE: number | null;
  trailingPE: number | null;
  eps35Growth: number | null;
} | null> {
  try {
    const url =
      "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy";
    const res = await fetch(url, {
      headers: {
        "User-Agent": YH_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 5000) return null;
    // Forward P/E = "Price/Earnings Ratio FY1" → first decimal that follows.
    const forwardMatch = html.match(
      /Price\/Earnings Ratio FY1[\s\S]{0,2000}?(\d+\.\d+)/
    );
    // Trailing P/E = "Price/Earnings" NOT followed by "Ratio". The table
    // format puts "Price/Earnings<...>27.12" on the same row.
    const trailingMatch = html.match(
      /Price\/Earnings(?!\s*Ratio)[\s\S]{0,2000}?(\d+\.\d+)/
    );
    // 3-5Y EPS Growth — SSGA renders "Estimated 3-5 Year EPS Growth" with a
    // tooltip describing the FactSet methodology, and the value is written
    // as "14.28%". We anchor on the specific label to avoid picking up
    // trailing/forward growth numbers from elsewhere on the page.
    const epsGrowthMatch = html.match(
      /Estimated 3-5 Year EPS Growth[\s\S]{0,2000}?(\d+\.\d+)\s*%/
    );
    const forwardPE = forwardMatch ? parseFloat(forwardMatch[1]) : null;
    const trailingPE = trailingMatch ? parseFloat(trailingMatch[1]) : null;
    const eps35Growth = epsGrowthMatch ? parseFloat(epsGrowthMatch[1]) : null;
    if (forwardPE == null && trailingPE == null && eps35Growth == null)
      return null;
    return { forwardPE, trailingPE, eps35Growth };
  } catch {
    return null;
  }
}

// ── Finviz breadth scrape ────────────────────────────────────────────────
// Finviz's public S&P 500 screener pages report how many constituents match
// a given technical filter (e.g. "price above 200DMA"). The result box
// always renders as "#1 / N" at the top of the results table, which we
// regex out and divide by the constant 500 to get the percentage. Two
// filters give us the classic breadth pair: above 200DMA (long-term trend
// participation) and above 50DMA (short-term momentum participation).
const FINVIZ_SP500_ABOVE_200DMA =
  "https://finviz.com/screener.ashx?v=111&f=idx_sp500,ta_sma200_pa&ft=4";
const FINVIZ_SP500_ABOVE_50DMA =
  "https://finviz.com/screener.ashx?v=111&f=idx_sp500,ta_sma50_pa&ft=4";

async function fetchFinvizCount(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": YH_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 2000) return null;
    // Pattern: '#1 / 268' in the count-text span.
    const m = html.match(/#1\s*\/\s*(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (isNaN(n) || n < 0 || n > 520) return null;
    return n;
  } catch {
    return null;
  }
}

async function fetchFinvizBreadth(): Promise<{
  above200Pct: number | null;
  above50Pct: number | null;
}> {
  const [c200, c50] = await Promise.all([
    fetchFinvizCount(FINVIZ_SP500_ABOVE_200DMA),
    fetchFinvizCount(FINVIZ_SP500_ABOVE_50DMA),
  ]);
  // S&P 500 nominally has 500 constituents — slightly more in practice due
  // to dual-class listings, but divided by 500 gives a clean percentage
  // directly comparable to what you'd read on StockCharts or WSJ.
  const toPct = (n: number | null) =>
    n == null ? null : parseFloat(((n / 500) * 100).toFixed(1));
  return { above200Pct: toPct(c200), above50Pct: toPct(c50) };
}

// ── Redis-backed breadth history ─────────────────────────────────────────
// Finviz only exposes the current snapshot, so we build our own rolling
// history under a NEW Redis key ("pm:breadth-history") to enable wk/wk and
// mo/mo deltas without touching any existing cached data. Each refresh
// appends today's snapshot (dedup by date) and trims to the last 45
// calendar days so the payload stays tiny. On first run the history has
// only one entry and the delta tiles will show no comparison — that's
// expected and will fill in over the next few trading days.
const BREADTH_HISTORY_KEY = "pm:breadth-history";
const BREADTH_HISTORY_MAX_DAYS = 45;

type BreadthSnapshot = {
  date: string; // ISO YYYY-MM-DD
  above200: number | null;
  above50: number | null;
};

async function loadBreadthHistory(): Promise<BreadthSnapshot[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(BREADTH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is BreadthSnapshot =>
        x &&
        typeof x.date === "string" &&
        (typeof x.above200 === "number" || x.above200 === null) &&
        (typeof x.above50 === "number" || x.above50 === null)
    );
  } catch (e) {
    console.error("Breadth history read failed:", e);
    return [];
  }
}

async function saveBreadthHistory(history: BreadthSnapshot[]): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.set(BREADTH_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.error("Breadth history write failed:", e);
  }
}

// Returns the merged history after appending today's snapshot (if it
// wasn't already recorded today). Sorted descending so [0] is newest.
async function recordBreadthSnapshot(
  todaySnapshot: BreadthSnapshot
): Promise<BreadthSnapshot[]> {
  const history = await loadBreadthHistory();
  const existingIdx = history.findIndex((s) => s.date === todaySnapshot.date);
  if (existingIdx >= 0) {
    // Update existing entry in place so multi-refresh-per-day works.
    history[existingIdx] = todaySnapshot;
  } else {
    history.push(todaySnapshot);
  }
  history.sort((a, b) => (a.date < b.date ? 1 : -1));
  const cutoffMs =
    Date.now() - BREADTH_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = history.filter(
    (s) => new Date(s.date + "T00:00:00Z").getTime() >= cutoffMs
  );
  await saveBreadthHistory(trimmed);
  return trimmed;
}

// ── SPX-proxy breadth backfill ────────────────────────────────────────────
// Free historical-breadth data sources (Barchart, WSJ, Nasdaq, Yahoo, Stooq)
// all require auth or don't expose $SPXA200R / S5TH at all from server IPs,
// so the first few days of a fresh install have no wk/wk or mo/mo delta to
// show. To avoid forcing the user to wait ~5 trading sessions for a real
// comparison, we synthesize an *estimated* historical breadth series using
// data we already have for free: SPX daily closes. The empirical link is
//   breadth_above_200 ≈ 50 + k * (SPX distance above its 200DMA)
// with a similar (but steeper) relationship for the 50DMA version. We
// calibrate against TODAY's actual Finviz reading so the series anchors on
// a known-true point and deviates historically based on how SPX itself was
// positioned against its own moving average on each past day. The result
// is never written to Redis — it's merged in-memory just before the
// delta lookup so real Finviz snapshots always win as they accumulate.
function sma(rowsAsc: DailyRow[], window: number, idx: number): number | null {
  if (idx < window - 1) return null;
  let sum = 0;
  for (let i = idx - window + 1; i <= idx; i++) sum += rowsAsc[i].close;
  return sum / window;
}

function synthesizeBreadthBackfill(
  spxRows: DailyRow[] | null,
  anchor: { above200: number | null; above50: number | null },
  todayIso: string
): BreadthSnapshot[] {
  if (!spxRows || spxRows.length < 210) return [];
  // forward-looking.ts stores rows newest-first; switch to ascending for SMA math.
  const rowsAsc = [...spxRows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastIdx = rowsAsc.length - 1;
  const todaySma200 = sma(rowsAsc, 200, lastIdx);
  const todaySma50 = sma(rowsAsc, 50, lastIdx);
  if (todaySma200 == null || todaySma50 == null) return [];
  const todayDist200 =
    ((rowsAsc[lastIdx].close - todaySma200) / todaySma200) * 100;
  const todayDist50 =
    ((rowsAsc[lastIdx].close - todaySma50) / todaySma50) * 100;

  // Sensitivity constants from multi-year regression of the public $SPXA200R
  // and $SPXA50R series against SPX distance-above-MA. Rough rule of thumb:
  // every 1% SPX moves above/below its own 200DMA corresponds to roughly 3pp
  // of names flipping above/below their individual 200DMA. Using a fixed k
  // avoids divide-by-zero when today's distance is near 0.
  const K_200 = 3.0;
  const K_50 = 2.5;
  const clamp = (x: number) => Math.max(0, Math.min(100, x));

  const out: BreadthSnapshot[] = [];
  // Need a valid 200DMA at each historical index, so we can only go back
  // (rowsAsc.length - 200) entries. Cap at BREADTH_HISTORY_MAX_DAYS.
  const maxBack = Math.min(BREADTH_HISTORY_MAX_DAYS, rowsAsc.length - 200);
  for (let back = 0; back < maxBack; back++) {
    const idx = lastIdx - back;
    if (idx < 199) break;
    const row = rowsAsc[idx];
    if (row.date === todayIso) continue; // never overwrite the real anchor point
    const s200 = sma(rowsAsc, 200, idx);
    const s50 = sma(rowsAsc, 50, idx);
    if (s200 == null || s50 == null) continue;
    const dist200 = ((row.close - s200) / s200) * 100;
    const dist50 = ((row.close - s50) / s50) * 100;

    const above200 =
      anchor.above200 != null
        ? clamp(anchor.above200 + K_200 * (dist200 - todayDist200))
        : null;
    const above50 =
      anchor.above50 != null
        ? clamp(anchor.above50 + K_50 * (dist50 - todayDist50))
        : null;

    out.push({
      date: row.date,
      above200: above200 != null ? parseFloat(above200.toFixed(1)) : null,
      above50: above50 != null ? parseFloat(above50.toFixed(1)) : null,
    });
  }
  // Return descending (newest first) to match the shape loadBreadthHistory
  // uses elsewhere.
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

// Merge synthetic backfill into the real history without writing to Redis.
// Real (Finviz-sourced) snapshots always win over synthetic estimates on
// the same date, so as actual history accumulates the backfill naturally
// fades out from newest to oldest.
function mergeBreadthHistory(
  real: BreadthSnapshot[],
  synthetic: BreadthSnapshot[]
): BreadthSnapshot[] {
  const byDate = new Map<string, BreadthSnapshot>();
  for (const s of synthetic) byDate.set(s.date, s);
  for (const s of real) byDate.set(s.date, s); // real overwrites synthetic
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
}

// Pick the snapshot closest to (but strictly older than) today's entry,
// targeting a calendar-day lag. Returns null when the history is too
// short to produce a real prior observation — the caller should then
// render the tile without a delta rather than displaying a bogus 0.
//
// We deliberately reject any candidate whose date equals today's (or is
// even newer) so a day-1 history containing only {today} yields null
// rather than "compare today to today → 0pp".
function pickHistoricalBreadth(
  history: BreadthSnapshot[],
  calendarDaysAgo: number
): BreadthSnapshot | null {
  if (history.length < 2) return null;
  const newestDate = history[0].date;
  const newestMs = new Date(newestDate + "T00:00:00Z").getTime();
  const targetMs = newestMs - calendarDaysAgo * 24 * 60 * 60 * 1000;

  let best: BreadthSnapshot | null = null;
  let bestDiff = Infinity;
  for (const s of history) {
    // Never compare today to itself.
    if (s.date === newestDate) continue;
    const t = new Date(s.date + "T00:00:00Z").getTime();
    // Prefer entries at or before the target to avoid look-ahead bias.
    if (t > targetMs) continue;
    const diff = Math.abs(t - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  // If no entry old enough exists yet, degrade to the oldest non-today
  // entry we do have — that still gives a directional comparison once
  // the history has been seeded for at least one prior trading day,
  // without fabricating a zero delta against today.
  if (!best) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].date !== newestDate) {
        best = history[i];
        break;
      }
    }
  }
  return best;
}

// ── CNBC quote page scrape for MOVE index ────────────────────────────────
// CNBC inlines a JSON payload on /quotes/.MOVE that contains the current
// price (`"last":"72.15"`), previous close (`"previous_day_closing"`), the
// `last_time` ISO date, and a `returnsData` array with `5D` / `1MO` / etc.
// close prices. Since Stooq now requires an API key and Yahoo 429s our
// server, this is the cleanest free source for MOVE.
async function fetchCnbcQuote(
  path: string
): Promise<{
  last: number | null;
  prior5d: number | null;
  asOf: string;
} | null> {
  try {
    const res = await fetch(`https://www.cnbc.com/quotes/${path}`, {
      headers: {
        "User-Agent": YH_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 5000) return null;
    const lastMatch = html.match(/"last"\s*:\s*"?(-?\d+\.\d+)/);
    const asOfMatch = html.match(/"last_time"\s*:\s*"([^"]+)"/);
    // "returnsData":[{"type":"5D","closePrice":81.78,...
    const fiveDayMatch = html.match(
      /"type"\s*:\s*"5D"\s*,\s*"closePrice"\s*:\s*(-?\d+\.\d+)/
    );
    const last = lastMatch ? parseFloat(lastMatch[1]) : null;
    const prior5d = fiveDayMatch ? parseFloat(fiveDayMatch[1]) : null;
    const asOf = asOfMatch
      ? asOfMatch[1].slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    if (last == null) return null;
    return { last, prior5d, asOf };
  } catch {
    return null;
  }
}

// Yahoo's v10 quoteSummary endpoint now requires an A1/A3 cookie pair and a
// matching crumb. Without them every request returns 401 "Invalid Cookie",
// which is why SPY forward P/E and trailing P/E were coming back N/A. The
// flow below mirrors what yahoo-finance2 does under the hood: hit a page
// that hands out consent cookies, then trade those for a crumb. Results are
// cached for an hour so we don't pay the two-request overhead on every call.
let cachedYahooAuth: {
  crumb: string;
  cookie: string;
  expiresAt: number;
} | null = null;

async function getYahooAuth(): Promise<{ crumb: string; cookie: string } | null> {
  if (cachedYahooAuth && cachedYahooAuth.expiresAt > Date.now()) {
    return { crumb: cachedYahooAuth.crumb, cookie: cachedYahooAuth.cookie };
  }
  try {
    // Step 1: hit fc.yahoo.com to receive A1/A3 cookies.
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": YH_UA, Accept: "*/*" },
      redirect: "manual",
    });
    const raw = cookieRes.headers.get("set-cookie");
    if (!raw) return null;
    // Node's fetch collapses multiple Set-Cookie headers into one comma-joined
    // string. Split on commas that precede a new cookie name=value pair.
    const cookieParts = raw
      .split(/,(?=[^;,]+=)/)
      .map((c) => c.split(";")[0].trim())
      .filter((c) => c.includes("="));
    if (cookieParts.length === 0) return null;
    const cookie = cookieParts.join("; ");

    // Step 2: trade cookies for a crumb.
    const crumbRes = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          "User-Agent": YH_UA,
          Cookie: cookie,
          Accept: "text/plain",
        },
        cache: "no-store",
      }
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 5 || crumb.includes("<")) return null;

    cachedYahooAuth = {
      crumb,
      cookie,
      expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour
    };
    return { crumb, cookie };
  } catch {
    return null;
  }
}

type YahooSummary = {
  summaryDetail?: {
    forwardPE?: { raw?: number };
    trailingPE?: { raw?: number };
  };
  defaultKeyStatistics?: {
    forwardPE?: { raw?: number };
    trailingPE?: { raw?: number };
  };
};

async function yahooQuoteSummary(
  symbol: string,
  modules: string
): Promise<YahooSummary | null> {
  const auth = await getYahooAuth();
  if (!auth) return null;
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol
    )}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": YH_UA,
        Cookie: auth.cookie,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      // Auth expired — force refresh and retry once.
      cachedYahooAuth = null;
      const fresh = await getYahooAuth();
      if (!fresh) return null;
      const retry = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
          symbol
        )}?modules=${modules}&crumb=${encodeURIComponent(fresh.crumb)}`,
        {
          headers: {
            "User-Agent": YH_UA,
            Cookie: fresh.cookie,
            Accept: "application/json",
          },
          cache: "no-store",
        }
      );
      if (!retry.ok) return null;
      const retryData = await retry.json();
      return (retryData?.quoteSummary?.result?.[0] ?? null) as
        | YahooSummary
        | null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.quoteSummary?.result?.[0] ?? null) as YahooSummary | null;
  } catch {
    return null;
  }
}

export type FredObs = { date: string; value: number };

// Optional — returns null when FRED_API_KEY is not set or the request fails.
export async function fredSeries(
  seriesId: string,
  limit = 10
): Promise<FredObs[] | null> {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const obs: FredObs[] = (data.observations ?? [])
      .map((o: { date: string; value: string }) => ({
        date: o.date,
        value: parseFloat(o.value),
      }))
      .filter((o: { value: number }) => !isNaN(o.value));
    return obs.length > 0 ? obs : null;
  } catch {
    return null;
  }
}

function pct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return parseFloat((((current - previous) / previous) * 100).toFixed(2));
}

function missing(
  source: string,
  sourceLabel: string,
  note: string,
  status: ForwardStatus = "failed"
): ForwardPoint {
  return {
    value: null,
    source,
    sourceLabel,
    asOf: new Date().toISOString(),
    note,
    status,
  };
}

// FRED publishes daily series with a ~1 business day lag. Anything within 5
// calendar days of today is treated as fresh; anything older is "stale" so
// the UI can warn that the series hasn't refreshed.
function fredStatusFromDate(dateStr: string): ForwardStatus {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return "stale";
  const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > 5 ? "stale" : "live";
}

// Derived points (curves, EPS growth) are only as fresh as their weakest leg.
function worstStatus(...inputs: (ForwardStatus | undefined)[]): ForwardStatus {
  const order: ForwardStatus[] = ["failed", "not-configured", "stale", "live"];
  let worst: ForwardStatus = "live";
  for (const s of inputs) {
    if (!s) continue;
    if (order.indexOf(s) < order.indexOf(worst)) worst = s;
  }
  return worst;
}

// ── CNN Fear & Greed ──────────────────────────────────────────────────────
// CNN exposes the index plus full daily history at the same dataviz endpoint
// the cnn.com/markets/fear-and-greed page consumes. The endpoint 418's any
// request that doesn't look like a real browser, so we have to send the full
// origin/referer/sec-fetch headers — confirmed working from server IPs as of
// 2026-04. The response carries:
//   • current score (0-100)
//   • previous_close, previous_1_week, previous_1_month, previous_1_year
//   • fear_and_greed_historical.data → 1Y of daily {x: ms, y: score}
// We use the historical array directly as the sparkline series, no Redis
// persistence needed (CNN already gives us the full history we want every
// fetch).
type CnnFearGreedResult = {
  score: number;
  previousClose: number | null;
  previousWeek: number | null;
  asOfIso: string; // YYYY-MM-DD
  history: SparkPoint[]; // oldest → newest, 1Y daily
};

async function fetchCnnFearGreed(): Promise<CnnFearGreedResult | null> {
  try {
    const res = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        headers: {
          "User-Agent": YH_UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://www.cnn.com",
          Referer: "https://www.cnn.com/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      console.error(`CNN F&G fetch HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const fg = data?.fear_and_greed;
    const histArr = data?.fear_and_greed_historical?.data;
    if (!fg || typeof fg.score !== "number" || !Array.isArray(histArr)) {
      return null;
    }
    const history: SparkPoint[] = histArr
      .filter(
        (d: { x?: number; y?: number }) =>
          typeof d?.x === "number" && typeof d?.y === "number"
      )
      .map((d: { x: number; y: number }) => ({
        date: new Date(d.x).toISOString().slice(0, 10),
        value: parseFloat(d.y.toFixed(2)),
      }));
    const asOfIso =
      typeof fg.timestamp === "string"
        ? fg.timestamp.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    return {
      score: parseFloat(fg.score.toFixed(2)),
      previousClose:
        typeof fg.previous_close === "number"
          ? parseFloat(fg.previous_close.toFixed(2))
          : null,
      previousWeek:
        typeof fg.previous_1_week === "number"
          ? parseFloat(fg.previous_1_week.toFixed(2))
          : null,
      asOfIso,
      history,
    };
  } catch (e) {
    console.error("CNN F&G fetch failed:", e);
    return null;
  }
}

// ── AAII Investor Sentiment ───────────────────────────────────────────────
// AAII publishes the full weekly history (back to 1987) as a public xls at
// aaii.com/files/surveys/sentiment.xls. The "SENTIMENT" sheet has columns:
//   0=Date, 1=Bullish, 2=Neutral, 3=Bearish, 4=Total, 5=8wk MA, 6=Bull-Bear
// Percentages are stored as strings like "35.75%". We parse the latest row
// for the spot reading and the trailing ~52 rows for the sparkline.
//
// Note: dynamic import of xlsx so the parser only loads when this code path
// runs (it's a chunky CJS module — keeping it out of the cold-start path).
type AaiiResult = {
  date: string;
  bullish: number;
  neutral: number;
  bearish: number;
  bullBear: number;
  history: SparkPoint[]; // bull-bear spread, oldest → newest
};

function parsePctString(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/%/g, "").trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  return isNaN(n) ? null : n;
}

// AAII writes dates as M-D-YY; convert to ISO YYYY-MM-DD assuming 19xx for
// year >= 80, 20xx otherwise. Anchor: the survey started in 1987.
function parseAaiiDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (m[3].length === 2) year = year >= 80 ? 1900 + year : 2000 + year;
  if (
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

async function fetchAaiiSentiment(): Promise<AaiiResult | null> {
  try {
    const res = await fetch("https://www.aaii.com/files/surveys/sentiment.xls", {
      headers: {
        "User-Agent": YH_UA,
        Accept:
          "application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`AAII xls fetch HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // Dynamic import — xlsx is ~1MB CJS, only pay the cost when this runs.
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets["SENTIMENT"] ?? wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return null;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
    });

    // Walk backwards to find the most recent row with parseable date + pcts.
    type Parsed = {
      date: string;
      bullish: number;
      neutral: number;
      bearish: number;
      bullBear: number;
    };
    const parsed: Parsed[] = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 7) continue;
      const date = parseAaiiDate(r[0]);
      const bullish = parsePctString(r[1]);
      const neutral = parsePctString(r[2]);
      const bearish = parsePctString(r[3]);
      const bullBear = parsePctString(r[6]);
      if (
        date &&
        bullish != null &&
        neutral != null &&
        bearish != null &&
        bullBear != null
      ) {
        parsed.push({ date, bullish, neutral, bearish, bullBear });
      }
    }
    if (parsed.length === 0) return null;
    // Oldest → newest after sort.
    parsed.sort((a, b) => (a.date < b.date ? -1 : 1));
    const latest = parsed[parsed.length - 1];
    // Last 52 weekly readings → ~1 year of sparkline data.
    const history: SparkPoint[] = parsed
      .slice(-52)
      .map((p) => ({ date: p.date, value: p.bullBear }));
    return {
      date: latest.date,
      bullish: latest.bullish,
      neutral: latest.neutral,
      bearish: latest.bearish,
      bullBear: latest.bullBear,
      history,
    };
  } catch (e) {
    console.error("AAII xls fetch/parse failed:", e);
    return null;
  }
}

// ── S&P Oscillator history (Redis-backed manual entry log) ───────────────
// MarketEdge requires a paid login, so the oscillator stays manual. But we
// log every value the PM saves into Redis so the tile can render a sparkline
// of his own historical entries — context the raw single number lacks.
// Lookups happen via append + getOscillatorHistory(); writes happen from
// /api/kv/market when the user updates marketData.spOscillator.
const OSCILLATOR_HISTORY_KEY = "pm:oscillator-history";
const OSCILLATOR_HISTORY_MAX_DAYS = 180; // 6 months — enough for trend context

export async function appendOscillatorEntry(value: number): Promise<void> {
  if (typeof value !== "number" || isNaN(value)) return;
  try {
    const redis = await getRedis();
    const raw = await redis.get(OSCILLATOR_HISTORY_KEY);
    const today = new Date().toISOString().slice(0, 10);
    let history: SparkPoint[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          history = parsed.filter(
            (x): x is SparkPoint =>
              x &&
              typeof x.date === "string" &&
              typeof x.value === "number"
          );
        }
      } catch {
        history = [];
      }
    }
    // Replace today's entry if one exists; otherwise append.
    const existingIdx = history.findIndex((s) => s.date === today);
    if (existingIdx >= 0) {
      // Skip the write if the value hasn't actually changed — keeps the
      // history clean across multi-save days.
      if (history[existingIdx].value === value) return;
      history[existingIdx] = { date: today, value };
    } else {
      history.push({ date: today, value });
    }
    history.sort((a, b) => (a.date < b.date ? -1 : 1));
    const cutoffMs =
      Date.now() - OSCILLATOR_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
    history = history.filter(
      (s) => new Date(s.date + "T00:00:00Z").getTime() >= cutoffMs
    );
    await redis.set(OSCILLATOR_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.error("Oscillator history write failed:", e);
  }
}

async function loadOscillatorHistory(): Promise<SparkPoint[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(OSCILLATOR_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SparkPoint =>
        x && typeof x.date === "string" && typeof x.value === "number"
    );
  } catch (e) {
    console.error("Oscillator history read failed:", e);
    return [];
  }
}

export async function fetchForwardLookingData(): Promise<ForwardLookingData> {
  const asOf = new Date().toISOString();
  const fredEnabled = !!process.env.FRED_API_KEY;

  // ── S&P 500 YTD and weekly change ─────────────────────────────────────────
  // Multi-source fallback chain because Yahoo Finance now blocks a lot of
  // server-side traffic outright (any Vercel/AWS IP range can get 429'd or
  // 401'd without warning). Preference order:
  //   1. FRED SP500  — most authoritative, updates daily, matches index
  //                    values you'd pull on fred.stlouisfed.org
  //   2. Stooq ^spx  — free daily CSV, no auth required
  //   3. Yahoo ^GSPC — original path, kept as a final fallback
  let spxYtd: ForwardPoint = missing(
    "https://fred.stlouisfed.org/series/SP500",
    "FRED SP500 / Stooq ^SPX / Yahoo ^GSPC",
    "All SPX sources returned no data."
  );
  let spxWeek: ForwardPoint = missing(
    "https://fred.stlouisfed.org/series/SP500",
    "FRED SP500 / Stooq ^SPX / Yahoo ^GSPC",
    "All SPX sources returned no data."
  );
  // Hoisted so the breadth block further down can reuse the same daily
  // closes to synthesize an estimated historical breadth series on cold
  // start. Sorted newest-first.
  let spxDailyRows: DailyRow[] | null = null;
  {
    let rows: DailyRow[] | null = null;
    let sourceLabel = "";
    let sourceUrl = "";

    if (fredEnabled) {
      const sp500 = await fredSeries("SP500", 260);
      if (sp500 && sp500.length >= 2) {
        rows = sp500.map((o) => ({ date: o.date, close: o.value }));
        sourceLabel = "FRED SP500";
        sourceUrl = "https://fred.stlouisfed.org/series/SP500";
      }
    }
    if (!rows) {
      const stooq = await fetchStooqDaily("^spx");
      if (stooq && stooq.length >= 2) {
        rows = stooq;
        sourceLabel = "Stooq ^SPX";
        sourceUrl = "https://stooq.com/q/?s=%5Espx";
      }
    }
    if (!rows) {
      // Last resort: rebuild a rows array from the Yahoo chart YTD range.
      // Yahoo returns parallel timestamp[] and indicators.quote[0].close[]
      // arrays in chronological order.
      type YahooChartRaw = YahooChartResult & { timestamp?: number[] };
      const ytdRes = (await yahooChart("^GSPC", "ytd")) as YahooChartRaw | null;
      const timestamps: number[] = ytdRes?.timestamp ?? [];
      const closes: (number | null)[] = ytdRes?.indicators?.quote?.[0]?.close ?? [];
      if (timestamps.length === closes.length && closes.length >= 2) {
        const built: DailyRow[] = [];
        for (let i = 0; i < closes.length; i++) {
          const c = closes[i];
          if (typeof c === "number") {
            built.push({
              date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
              close: c,
            });
          }
        }
        if (built.length >= 2) {
          built.sort((a, b) => (a.date < b.date ? 1 : -1));
          rows = built;
          sourceLabel = "Yahoo Finance ^GSPC";
          sourceUrl = "https://finance.yahoo.com/quote/%5EGSPC/";
        }
      }
    }

    if (rows && rows.length >= 2) {
      const now = rows[0].close;
      const currentYear = rows[0].date.slice(0, 4);
      // YTD baseline = oldest row in the current calendar year.
      const inYear = rows.filter((r) => r.date.startsWith(currentYear));
      const ytdBase = inYear[inYear.length - 1] ?? rows[rows.length - 1];
      const wkBase = rows[Math.min(5, rows.length - 1)];

      const ytdValue = pct(now, ytdBase?.close ?? null);
      const wkValue = pct(now, wkBase?.close ?? null);

      const status: ForwardStatus = fredStatusFromDate(rows[0].date);

      spxYtd = {
        value: ytdValue,
        source: sourceUrl,
        sourceLabel,
        asOf: rows[0].date,
        previous: ytdBase?.close ?? null,
        note: `S&P 500 percent change from first trading day of ${currentYear}. Source: ${sourceLabel}. Latest close: ${rows[0].date}.`,
        status: ytdValue != null ? status : "failed",
      };
      spxWeek = {
        value: wkValue,
        source: sourceUrl,
        sourceLabel,
        asOf: rows[0].date,
        previous: wkBase?.close ?? null,
        note: `S&P 500 5-trading-day percent change. Source: ${sourceLabel}. Latest close: ${rows[0].date}.`,
        status: wkValue != null ? status : "failed",
      };
      // Expose full history for breadth backfill synthesis below.
      spxDailyRows = rows;
    }
  }

  // ── SPY forward / trailing P/E and implied EPS growth ────────────────────
  // Yahoo's quoteSummary endpoint is blocked from most server IPs (returns
  // "Too Many Requests" even with a fresh crumb). State Street's own SPY
  // product page is the authoritative fallback — it publishes both the
  // trailing "Price/Earnings" and the forward "Price/Earnings Ratio FY1"
  // straight from the fund's index basket.
  const spyKeyStatsUrl = "https://finance.yahoo.com/quote/SPY/key-statistics";
  const ssgaSpyUrl =
    "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy";
  let spyForwardPE: ForwardPoint = missing(
    ssgaSpyUrl,
    "SSGA SPY / Yahoo Finance SPY",
    "All SPY P/E sources returned no data."
  );
  let spyTrailingPE: ForwardPoint = missing(
    ssgaSpyUrl,
    "SSGA SPY / Yahoo Finance SPY",
    "All SPY P/E sources returned no data."
  );
  let impliedEpsGrowth: ForwardPoint = missing(
    ssgaSpyUrl,
    "SSGA SPY / Yahoo Finance SPY",
    "Derived from (trailing P/E / forward P/E - 1); needs both values."
  );
  let eps35Growth: ForwardPoint = missing(
    ssgaSpyUrl,
    "SSGA SPY",
    "SSGA product page did not expose Estimated 3-5 Year EPS Growth."
  );
  {
    let fwd: number | null = null;
    let trl: number | null = null;
    let peSourceUrl = ssgaSpyUrl;
    let peSourceLabel = "SSGA SPY";

    // Try SSGA first — the issuer's own page is the most reliable source
    // and is not blocked from Vercel/AWS IPs. Also carries the 3-5Y
    // consensus EPS growth number we surface in a separate tile below.
    const ssga = await fetchSsgaSpyData();
    if (ssga) {
      if (ssga.forwardPE != null) fwd = ssga.forwardPE;
      if (ssga.trailingPE != null) trl = ssga.trailingPE;
      if (ssga.eps35Growth != null) {
        eps35Growth = {
          value: ssga.eps35Growth,
          source: ssgaSpyUrl,
          sourceLabel: "SSGA SPY",
          asOf,
          note: "Estimated 3-5 Year EPS Growth for SPY's underlying holdings. Weighted-average analyst consensus sourced from FactSet Estimates on the SSGA product page.",
          status: "live",
        };
      }
    }

    // Yahoo as a secondary source for anything SSGA didn't return.
    if (fwd == null || trl == null) {
      try {
        const summary = await yahooQuoteSummary(
          "SPY",
          "summaryDetail,defaultKeyStatistics"
        );
        const det = summary?.summaryDetail;
        const ks = summary?.defaultKeyStatistics;
        const yFwd = det?.forwardPE?.raw ?? ks?.forwardPE?.raw ?? null;
        const yTrl = det?.trailingPE?.raw ?? ks?.trailingPE?.raw ?? null;
        if (fwd == null && yFwd != null) {
          fwd = yFwd;
          peSourceUrl = spyKeyStatsUrl;
          peSourceLabel = "Yahoo Finance SPY";
        }
        if (trl == null && yTrl != null) {
          trl = yTrl;
          peSourceUrl = spyKeyStatsUrl;
          peSourceLabel = "Yahoo Finance SPY";
        }
      } catch {
        // leave null, tile falls back to Stale
      }
    }

    if (fwd != null) {
      spyForwardPE = {
        value: parseFloat(fwd.toFixed(2)),
        source: peSourceUrl,
        sourceLabel: peSourceLabel,
        asOf,
        note: `SPY forward blended P/E via ${peSourceLabel} — closest automated proxy for the S&P 500 forward multiple.`,
        status: "live",
      };
    }
    if (trl != null) {
      spyTrailingPE = {
        value: parseFloat(trl.toFixed(2)),
        source: peSourceUrl,
        sourceLabel: peSourceLabel,
        asOf,
        note: `SPY trailing twelve-month P/E via ${peSourceLabel}.`,
        status: "live",
      };
    }
    if (fwd != null && trl != null && fwd > 0) {
      const impl = (trl / fwd - 1) * 100;
      impliedEpsGrowth = {
        value: parseFloat(impl.toFixed(1)),
        source: peSourceUrl,
        sourceLabel: peSourceLabel,
        asOf,
        note: "Implied forward 12-month EPS growth, derived as (trailing P/E / forward P/E - 1) × 100.",
        status: "live",
      };
    }
  }

  // ── Yields: FRED preferred, Yahoo fallback ───────────────────────────────
  let yield10y: ForwardPoint;
  let yield2y: ForwardPoint;
  let yield3m: ForwardPoint;

  if (fredEnabled) {
    const [dgs10, dgs2, dgs3mo] = await Promise.all([
      fredSeries("DGS10"),
      fredSeries("DGS2"),
      fredSeries("DGS3MO"),
    ]);
    yield10y =
      dgs10 && dgs10[0]
        ? {
            value: dgs10[0].value,
            source: "https://fred.stlouisfed.org/series/DGS10",
            sourceLabel: "FRED DGS10",
            asOf: dgs10[0].date,
            previous: dgs10[1]?.value ?? null,
            note: `10-Year Treasury constant-maturity yield. Latest FRED observation: ${dgs10[0].date}.`,
            status: fredStatusFromDate(dgs10[0].date),
          }
        : missing(
            "https://fred.stlouisfed.org/series/DGS10",
            "FRED DGS10",
            "FRED returned no data for DGS10"
          );
    yield2y =
      dgs2 && dgs2[0]
        ? {
            value: dgs2[0].value,
            source: "https://fred.stlouisfed.org/series/DGS2",
            sourceLabel: "FRED DGS2",
            asOf: dgs2[0].date,
            previous: dgs2[1]?.value ?? null,
            note: `2-Year Treasury constant-maturity yield. Latest FRED observation: ${dgs2[0].date}.`,
            status: fredStatusFromDate(dgs2[0].date),
          }
        : missing(
            "https://fred.stlouisfed.org/series/DGS2",
            "FRED DGS2",
            "FRED returned no data for DGS2"
          );
    yield3m =
      dgs3mo && dgs3mo[0]
        ? {
            value: dgs3mo[0].value,
            source: "https://fred.stlouisfed.org/series/DGS3MO",
            sourceLabel: "FRED DGS3MO",
            asOf: dgs3mo[0].date,
            previous: dgs3mo[1]?.value ?? null,
            note: `3-Month Treasury bill secondary-market rate. Latest FRED observation: ${dgs3mo[0].date}.`,
            status: fredStatusFromDate(dgs3mo[0].date),
          }
        : missing(
            "https://fred.stlouisfed.org/series/DGS3MO",
            "FRED DGS3MO",
            "FRED returned no data for DGS3MO"
          );
  } else {
    const [tnx, irx] = await Promise.all([
      yahooChart("^TNX", "1d"),
      yahooChart("^IRX", "1d"),
    ]);
    const tnxPrice = tnx?.meta?.regularMarketPrice ?? null;
    const irxPrice = irx?.meta?.regularMarketPrice ?? null;
    yield10y = {
      value: tnxPrice != null ? parseFloat(tnxPrice.toFixed(2)) : null,
      source: "https://finance.yahoo.com/quote/%5ETNX",
      sourceLabel: "Yahoo Finance ^TNX",
      asOf,
      note: "10-Year Treasury yield via Yahoo ^TNX. Add FRED_API_KEY to .env.local to switch to FRED DGS10 (official end-of-day series).",
      status: tnxPrice != null ? "live" : "failed",
    };
    yield2y = {
      value: null,
      source: "https://fred.stlouisfed.org/series/DGS2",
      sourceLabel: "FRED DGS2 (requires API key)",
      asOf,
      note: "Yahoo does not expose a 2Y Treasury ticker. Add FRED_API_KEY to .env.local to enable.",
      status: "not-configured",
    };
    yield3m = {
      value: irxPrice != null ? parseFloat(irxPrice.toFixed(2)) : null,
      source: "https://finance.yahoo.com/quote/%5EIRX",
      sourceLabel: "Yahoo Finance ^IRX",
      asOf,
      note: "13-week T-Bill discount rate via Yahoo ^IRX. FRED DGS3MO is the constant-maturity equivalent.",
      status: irxPrice != null ? "live" : "failed",
    };
  }

  // ── Yield curve spreads (bps) ────────────────────────────────────────────
  const curve10y2y: ForwardPoint = (() => {
    const ten = typeof yield10y.value === "number" ? yield10y.value : null;
    const two = typeof yield2y.value === "number" ? yield2y.value : null;
    if (ten == null || two == null) {
      return {
        value: null,
        source: "https://fred.stlouisfed.org/series/T10Y2Y",
        sourceLabel: "FRED T10Y2Y",
        asOf,
        note: fredEnabled
          ? "Computed from DGS10 - DGS2. Missing one leg."
          : "Needs FRED_API_KEY for DGS2 (Yahoo has no 2Y ticker).",
        status: worstStatus(yield10y.status, yield2y.status),
      };
    }
    return {
      value: parseFloat(((ten - two) * 100).toFixed(0)),
      source: "https://fred.stlouisfed.org/series/T10Y2Y",
      sourceLabel: "FRED T10Y2Y",
      asOf,
      note: "10Y - 2Y Treasury spread in basis points. Inversion (< 0) has historically preceded recessions.",
      status: worstStatus(yield10y.status, yield2y.status),
    };
  })();

  const curve10y3m: ForwardPoint = (() => {
    const ten = typeof yield10y.value === "number" ? yield10y.value : null;
    const three = typeof yield3m.value === "number" ? yield3m.value : null;
    if (ten == null || three == null) {
      return {
        value: null,
        source: "https://fred.stlouisfed.org/series/T10Y3M",
        sourceLabel: "FRED T10Y3M",
        asOf,
        note: "Computed from 10Y - 3M. Missing one leg.",
        status: worstStatus(yield10y.status, yield3m.status),
      };
    }
    return {
      value: parseFloat(((ten - three) * 100).toFixed(0)),
      source: "https://fred.stlouisfed.org/series/T10Y3M",
      sourceLabel: "FRED T10Y3M",
      asOf,
      note: "10Y - 3M Treasury spread in basis points — the NY Fed's preferred recession indicator.",
      status: worstStatus(yield10y.status, yield3m.status),
    };
  })();

  // ── HY / IG OAS trend (FRED only) ─────────────────────────────────────────
  let hyOasTrend: ForwardPoint = missing(
    "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
    "FRED BAMLH0A0HYM2",
    fredEnabled
      ? "No data"
      : "Add FRED_API_KEY to .env.local to enable automated HY OAS trend.",
    fredEnabled ? "failed" : "not-configured"
  );
  let igOasTrend: ForwardPoint = missing(
    "https://fred.stlouisfed.org/series/BAMLC0A0CM",
    "FRED BAMLC0A0CM",
    fredEnabled
      ? "No data"
      : "Add FRED_API_KEY to .env.local to enable automated IG OAS trend.",
    fredEnabled ? "failed" : "not-configured"
  );

  if (fredEnabled) {
    const [hy, ig] = await Promise.all([
      fredSeries("BAMLH0A0HYM2"),
      fredSeries("BAMLC0A0CM"),
    ]);
    if (hy && hy[0]) {
      const latest = hy[0].value;
      const priorIdx = Math.min(5, hy.length - 1);
      const prior = hy[priorIdx]?.value ?? null;
      hyOasTrend = {
        value: Math.round(latest * 100),
        source: "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
        sourceLabel: "FRED BAMLH0A0HYM2",
        asOf: hy[0].date,
        previous: prior != null ? Math.round(prior * 100) : null,
        note: `ICE BofA US High Yield Index option-adjusted spread (bps). Previous = ~5 trading days ago. Latest FRED observation: ${hy[0].date}.`,
        status: fredStatusFromDate(hy[0].date),
      };
    }
    if (ig && ig[0]) {
      const latest = ig[0].value;
      const priorIdx = Math.min(5, ig.length - 1);
      const prior = ig[priorIdx]?.value ?? null;
      igOasTrend = {
        value: Math.round(latest * 100),
        source: "https://fred.stlouisfed.org/series/BAMLC0A0CM",
        sourceLabel: "FRED BAMLC0A0CM",
        asOf: ig[0].date,
        previous: prior != null ? Math.round(prior * 100) : null,
        note: `ICE BofA US Corporate Index OAS (bps). Previous = ~5 trading days ago. Latest FRED observation: ${ig[0].date}.`,
        status: fredStatusFromDate(ig[0].date),
      };
    }
  }

  // ── VIX / MOVE weekly deltas (multi-source) ──────────────────────────────
  // VIX fallback chain: FRED VIXCLS → Stooq ^vix → Yahoo ^VIX
  // MOVE fallback chain: Stooq ^move → Yahoo ^MOVE (FRED has no MOVE series)
  // Each source builds a DailyRow[] sorted newest-first so rows[0] is the
  // latest close and rows[~5] is ~one trading week back.
  const volPointFromRows = (
    rows: DailyRow[],
    sourceUrl: string,
    sourceLabel: string,
    label: string
  ): ForwardPoint => {
    const now = rows[0]?.close ?? null;
    const priorIdx = Math.min(5, rows.length - 1);
    const prior = rows[priorIdx]?.close ?? null;
    const status: ForwardStatus =
      now != null ? fredStatusFromDate(rows[0].date) : "failed";
    return {
      value: now != null ? parseFloat(now.toFixed(2)) : null,
      source: sourceUrl,
      sourceLabel,
      asOf: rows[0]?.date ?? asOf,
      previous: prior != null ? parseFloat(prior.toFixed(2)) : null,
      note: `${label} latest close with ~5-trading-day prior for week-over-week delta. Source: ${sourceLabel}. Latest close: ${rows[0]?.date}.`,
      status,
    };
  };

  const yahooChartToRows = (
    res:
      | (YahooChartResult & { timestamp?: number[] })
      | null
  ): DailyRow[] | null => {
    const timestamps: number[] = res?.timestamp ?? [];
    const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
    if (timestamps.length !== closes.length || closes.length < 2) return null;
    const built: DailyRow[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      if (typeof c === "number") {
        built.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          close: c,
        });
      }
    }
    if (built.length < 2) return null;
    built.sort((a, b) => (a.date < b.date ? 1 : -1));
    return built;
  };

  let vixWeek: ForwardPoint = missing(
    "https://fred.stlouisfed.org/series/VIXCLS",
    "FRED VIXCLS / Stooq ^VIX / Yahoo ^VIX",
    "All VIX sources returned no data."
  );
  let moveWeek: ForwardPoint = missing(
    "https://www.cnbc.com/quotes/.MOVE",
    "CNBC .MOVE / Stooq ^MOVE / Yahoo ^MOVE",
    "All MOVE sources returned no data."
  );

  // VIX
  {
    let rows: DailyRow[] | null = null;
    let sourceLabel = "";
    let sourceUrl = "";

    if (fredEnabled) {
      const vixFred = await fredSeries("VIXCLS", 15);
      if (vixFred && vixFred.length >= 2) {
        rows = vixFred.map((o) => ({ date: o.date, close: o.value }));
        sourceLabel = "FRED VIXCLS";
        sourceUrl = "https://fred.stlouisfed.org/series/VIXCLS";
      }
    }
    if (!rows) {
      const stooq = await fetchStooqDaily("^vix");
      if (stooq && stooq.length >= 2) {
        rows = stooq;
        sourceLabel = "Stooq ^VIX";
        sourceUrl = "https://stooq.com/q/?s=%5Evix";
      }
    }
    if (!rows) {
      type Raw = YahooChartResult & { timestamp?: number[] };
      const res = (await yahooChart("^VIX", "1mo")) as Raw | null;
      const built = yahooChartToRows(res);
      if (built) {
        rows = built;
        sourceLabel = "Yahoo Finance ^VIX";
        sourceUrl = "https://finance.yahoo.com/quote/%5EVIX";
      }
    }
    if (rows && rows.length >= 2) {
      vixWeek = volPointFromRows(rows, sourceUrl, sourceLabel, "VIX");
    }
  }

  // MOVE — CNBC primary (inlines current + 5D return), Stooq/Yahoo as
  // remote possibilities (both currently blocked for most server IPs).
  {
    const cnbc = await fetchCnbcQuote(".MOVE");
    if (cnbc && cnbc.last != null) {
      moveWeek = {
        value: parseFloat(cnbc.last.toFixed(2)),
        source: "https://www.cnbc.com/quotes/.MOVE",
        sourceLabel: "CNBC .MOVE",
        asOf: cnbc.asOf,
        previous:
          cnbc.prior5d != null ? parseFloat(cnbc.prior5d.toFixed(2)) : null,
        note: `ICE BofA MOVE index latest close with 5-trading-day prior from CNBC's inlined returnsData. Latest close: ${cnbc.asOf}.`,
        status: fredStatusFromDate(cnbc.asOf),
      };
    } else {
      // Fallback chain if CNBC ever changes markup or blocks us.
      let rows: DailyRow[] | null = null;
      let sourceLabel = "";
      let sourceUrl = "";

      const stooq = await fetchStooqDaily("^move");
      if (stooq && stooq.length >= 2) {
        rows = stooq;
        sourceLabel = "Stooq ^MOVE";
        sourceUrl = "https://stooq.com/q/?s=%5Emove";
      }
      if (!rows) {
        type Raw = YahooChartResult & { timestamp?: number[] };
        const res = (await yahooChart("^MOVE", "1mo")) as Raw | null;
        const built = yahooChartToRows(res);
        if (built) {
          rows = built;
          sourceLabel = "Yahoo Finance ^MOVE";
          sourceUrl = "https://finance.yahoo.com/quote/%5EMOVE";
        }
      }
      if (rows && rows.length >= 2) {
        moveWeek = volPointFromRows(rows, sourceUrl, sourceLabel, "MOVE");
      }
    }
  }

  // ── Breadth: current snapshot from Finviz + Redis-backed history ─────────
  // Finviz gives us "how many S&P 500 names are above their 200/50 DMA"
  // right now; we fold that into a small rolling cache in Redis
  // ("pm:breadth-history") so every subsequent run can compute wk/wk and
  // mo/mo deltas without ever having to reach a paid data provider. The
  // history key is new so it can't clobber anything that's already cached.
  const finvizUrl = "https://finviz.com/screener.ashx?f=idx_sp500";
  let breadth200Wk: ForwardPoint = missing(
    FINVIZ_SP500_ABOVE_200DMA,
    "Finviz S&P 500 >200DMA",
    "Finviz breadth scrape unavailable."
  );
  let breadth200Mo: ForwardPoint = missing(
    FINVIZ_SP500_ABOVE_200DMA,
    "Finviz S&P 500 >200DMA",
    "Finviz breadth scrape unavailable."
  );
  let breadth50Wk: ForwardPoint = missing(
    FINVIZ_SP500_ABOVE_50DMA,
    "Finviz S&P 500 >50DMA",
    "Finviz breadth scrape unavailable."
  );
  try {
    const { above200Pct, above50Pct } = await fetchFinvizBreadth();
    // Use today's ISO date for the snapshot key — Finviz always reflects
    // the latest session close.
    const todayIso = new Date().toISOString().slice(0, 10);
    const realHistory = await recordBreadthSnapshot({
      date: todayIso,
      above200: above200Pct,
      above50: above50Pct,
    });

    // On cold start (or any time the real history hasn't accumulated at
    // least ~a month of distinct trading days) fold in an SPX-proxy
    // backfill so wk/wk and mo/mo deltas render immediately instead of
    // showing "building…". The synthetic points are kept in memory only
    // — never written to Redis — so as genuine Finviz snapshots roll in
    // they displace the estimated values and the tiles become fully
    // real within a few weeks.
    const needsBackfill = realHistory.length < 22;
    const synthetic = needsBackfill
      ? synthesizeBreadthBackfill(
          spxDailyRows,
          { above200: above200Pct, above50: above50Pct },
          todayIso
        )
      : [];
    const history = needsBackfill
      ? mergeBreadthHistory(realHistory, synthetic)
      : realHistory;
    const backfillActive = needsBackfill && synthetic.length > 0;

    const wkAgo = pickHistoricalBreadth(history, 7);
    const moAgo = pickHistoricalBreadth(history, 30);

    const wkAgoDate = wkAgo?.date;
    const moAgoDate = moAgo?.date;

    // If the wk/wk or mo/mo prior falls on a synthesized date (i.e. any
    // date not present in the REAL history), mark it as estimated so the
    // tile note can disclose the methodology honestly.
    const realDates = new Set(realHistory.map((s) => s.date));
    const wkEstimated = wkAgo != null && !realDates.has(wkAgo.date);
    const moEstimated = moAgo != null && !realDates.has(moAgo.date);
    const estimatedSuffix = backfillActive
      ? " Estimated historical points are derived from SPX distance above its own 200/50 DMA anchored to today's real Finviz reading; they are replaced by live snapshots as the Redis history (pm:breadth-history) accumulates."
      : "";

    if (above200Pct != null) {
      breadth200Wk = {
        value: above200Pct,
        source: finvizUrl,
        sourceLabel: "Finviz S&P 500 >200DMA",
        asOf: todayIso,
        previous: wkAgo?.above200 ?? null,
        note: `Percentage of S&P 500 constituents trading above their 200-day moving average, scraped from Finviz (count / 500). Prior snapshot: ${
          wkAgoDate ?? "none yet (history building)"
        }${wkEstimated ? " (SPX-proxy estimate)" : ""}. History accumulates in Redis key pm:breadth-history so wk/wk and mo/mo comparisons become fully real within a few weeks.${estimatedSuffix}`,
        status: "live",
      };
      breadth200Mo = {
        value: above200Pct,
        source: finvizUrl,
        sourceLabel: "Finviz S&P 500 >200DMA",
        asOf: todayIso,
        previous: moAgo?.above200 ?? null,
        note: `Percentage of S&P 500 constituents above 200DMA — same current snapshot as the weekly tile, but compared to ~30 calendar days ago (${
          moAgoDate ?? "none yet"
        }${moEstimated ? ", SPX-proxy estimate" : ""}).${estimatedSuffix}`,
        status: "live",
      };
    }
    if (above50Pct != null) {
      breadth50Wk = {
        value: above50Pct,
        source: finvizUrl,
        sourceLabel: "Finviz S&P 500 >50DMA",
        asOf: todayIso,
        previous: wkAgo?.above50 ?? null,
        note: `Percentage of S&P 500 constituents above their 50DMA (faster momentum gauge). Prior snapshot: ${
          wkAgoDate ?? "none yet (history building)"
        }${wkEstimated ? " (SPX-proxy estimate)" : ""}.${estimatedSuffix}`,
        status: "live",
      };
    }
  } catch (e) {
    console.error("Breadth fetch failed:", e);
  }

  // ── Sentiment tiles (CNN F&G + AAII + S&P Oscillator history) ───────────
  // All three are independent of the macro fetch chain above. Run them in
  // parallel and let each one fail individually — the tile will fall back
  // to a "stale" state showing the last persisted value.
  const cnnUrl = "https://www.cnn.com/markets/fear-and-greed";
  const aaiiUrl = "https://www.aaii.com/sentimentsurvey";
  const oscillatorUrl = "https://app.marketedge.com/#!/markets";

  let fearGreed: ForwardPoint = missing(
    cnnUrl,
    "CNN Fear & Greed",
    "CNN dataviz endpoint returned no data."
  );
  let aaiiBullBear: ForwardPoint = missing(
    aaiiUrl,
    "AAII Investor Sentiment Survey",
    "AAII xls download returned no data."
  );
  let aaiiBull: ForwardPoint = missing(
    aaiiUrl,
    "AAII Investor Sentiment Survey",
    "AAII xls download returned no data."
  );
  let aaiiNeutral: ForwardPoint = missing(
    aaiiUrl,
    "AAII Investor Sentiment Survey",
    "AAII xls download returned no data."
  );
  let aaiiBear: ForwardPoint = missing(
    aaiiUrl,
    "AAII Investor Sentiment Survey",
    "AAII xls download returned no data."
  );
  let spOscillator: ForwardPoint = missing(
    oscillatorUrl,
    "S&P Oscillator (manual entry)",
    "No oscillator history yet — type a value into the brief form to start the log."
  );

  const [cnnRes, aaiiRes, oscHistory] = await Promise.all([
    fetchCnnFearGreed(),
    fetchAaiiSentiment(),
    loadOscillatorHistory(),
  ]);

  if (cnnRes) {
    // CNN's history is daily — 5 trading days = 1w, 21 = 1m, 63 = 3m. F&G
    // is on a 0-100 scale so a 1m move >20 is dramatic, <5 is stable.
    const fgTrend = computeTrendStats(cnnRes.history, {
      lag1w: 5,
      lag1m: 21,
      lag3m: 63,
      fastThreshold: 20,
      slowThreshold: 5,
    });
    fearGreed = {
      value: cnnRes.score,
      source: cnnUrl,
      sourceLabel: "CNN Fear & Greed",
      asOf: cnnRes.asOfIso,
      previous: cnnRes.previousWeek,
      note: `CNN Business Fear & Greed Index (0=extreme fear, 100=extreme greed). Sparkline shows trailing 1Y of daily readings from CNN's dataviz endpoint. Previous shown is the 1-week-ago value.`,
      status: "live",
      history: cnnRes.history,
      ...(fgTrend ? { trend: fgTrend } : {}),
    };
  }

  if (aaiiRes) {
    const point = (value: number, label: string): ForwardPoint => ({
      value,
      source: aaiiUrl,
      sourceLabel: "AAII Investor Sentiment Survey",
      asOf: aaiiRes.date,
      note: `${label} from the weekly AAII Investor Sentiment Survey. Auto-fetched from aaii.com/files/surveys/sentiment.xls. Latest reading: ${aaiiRes.date}.`,
      status: "live",
    });
    // AAII history is weekly — 1 bar = 1w, 4 = 1m, 13 = 3m. Bull-bear spread
    // moves a lot more violently than F&G; >15pp over a month is extreme,
    // <3pp is stable.
    const aaiiTrend = computeTrendStats(aaiiRes.history, {
      lag1w: 1,
      lag1m: 4,
      lag3m: 13,
      fastThreshold: 15,
      slowThreshold: 3,
    });
    aaiiBullBear = {
      ...point(aaiiRes.bullBear, "Bull-Bear spread"),
      previous:
        aaiiRes.history.length >= 2
          ? aaiiRes.history[aaiiRes.history.length - 2].value
          : null,
      history: aaiiRes.history,
      ...(aaiiTrend ? { trend: aaiiTrend } : {}),
    };
    aaiiBull = point(aaiiRes.bullish, "Bullish %");
    aaiiNeutral = point(aaiiRes.neutral, "Neutral %");
    aaiiBear = point(aaiiRes.bearish, "Bearish %");
  }

  if (oscHistory.length > 0) {
    const latest = oscHistory[oscHistory.length - 1];
    const previous =
      oscHistory.length >= 2 ? oscHistory[oscHistory.length - 2].value : null;
    // Oscillator history is whatever the PM saved — typically a few entries
    // per week, not strictly daily. Treat each entry as ~1 day for trend
    // purposes; only attach trend stats if we have at least 3 entries (2 is
    // enough for delta1w but not enough for a meaningful range).
    const oscTrend =
      oscHistory.length >= 3
        ? computeTrendStats(oscHistory, {
            lag1w: Math.min(5, oscHistory.length - 1),
            lag1m: Math.min(21, oscHistory.length - 1),
            lag3m: Math.min(63, oscHistory.length - 1),
            // Oscillator typically lives in [-6, +6]; a 1m move >4 is huge,
            // <1 is essentially flat.
            fastThreshold: 4,
            slowThreshold: 1,
          })
        : null;
    spOscillator = {
      value: latest.value,
      source: oscillatorUrl,
      sourceLabel: "S&P Oscillator (manual entry)",
      asOf: latest.date,
      previous,
      note: `MarketEdge S&P Oscillator. The oscillator stays manually entered (MarketEdge requires login) — the sparkline shows the last ${OSCILLATOR_HISTORY_MAX_DAYS} days of values you've saved into the brief.`,
      status: "live",
      history: oscHistory,
      ...(oscTrend ? { trend: oscTrend } : {}),
    };
  }

  return {
    spxYtd,
    spxWeek,
    spyForwardPE,
    spyTrailingPE,
    impliedEpsGrowth,
    eps35Growth,
    yield10y,
    yield2y,
    yield3m,
    curve10y2y,
    curve10y3m,
    hyOasTrend,
    igOasTrend,
    vixWeek,
    moveWeek,
    breadth200Wk,
    breadth200Mo,
    breadth50Wk,
    fearGreed,
    aaiiBullBear,
    aaiiBull,
    aaiiNeutral,
    aaiiBear,
    spOscillator,
    fredEnabled,
    fetchedAt: asOf,
  };
}

// ── Deterministic regime pre-classification ────────────────────────────────
// Runs BEFORE Claude so the prompt can adapt tone instead of Claude inferring
// regime from backward-looking data alone.

export type RegimeClassification = {
  regime: "Risk-On" | "Neutral" | "Risk-Off";
  score: number; // negative = risk-off, positive = risk-on
  signals: string[]; // human-readable drivers of the score
};

export function classifyRegime(args: {
  vix: number;
  vixWeekDeltaPct: number | null;
  hyOas: number;
  hyOasWeekDeltaBps: number | null;
  spxYtd: number | null;
  spxWeek: number | null;
  breadth: number;
  curve10y2y: number | null;
}): RegimeClassification {
  let score = 0;
  const signals: string[] = [];

  if (args.vix <= 15) {
    score += 2;
    signals.push(`VIX ${args.vix} (low — risk-on)`);
  } else if (args.vix <= 18) {
    score += 1;
    signals.push(`VIX ${args.vix} (contained)`);
  } else if (args.vix >= 25) {
    score -= 2;
    signals.push(`VIX ${args.vix} (elevated stress)`);
  } else if (args.vix >= 20) {
    score -= 1;
    signals.push(`VIX ${args.vix} (moderate stress)`);
  }

  if (args.vixWeekDeltaPct != null) {
    if (args.vixWeekDeltaPct <= -10) {
      score += 1;
      signals.push(
        `VIX down ${Math.abs(args.vixWeekDeltaPct).toFixed(1)}% wk/wk`
      );
    } else if (args.vixWeekDeltaPct >= 15) {
      score -= 1;
      signals.push(`VIX up ${args.vixWeekDeltaPct.toFixed(1)}% wk/wk`);
    }
  }

  if (args.hyOas <= 300) {
    score += 1;
    signals.push(`HY OAS ${args.hyOas}bps (tight)`);
  } else if (args.hyOas >= 450) {
    score -= 1;
    signals.push(`HY OAS ${args.hyOas}bps (wide)`);
  }
  if (args.hyOasWeekDeltaBps != null) {
    if (args.hyOasWeekDeltaBps <= -15) {
      score += 1;
      signals.push(
        `HY OAS tightened ${Math.abs(args.hyOasWeekDeltaBps)}bps wk/wk`
      );
    } else if (args.hyOasWeekDeltaBps >= 20) {
      score -= 1;
      signals.push(`HY OAS widened ${args.hyOasWeekDeltaBps}bps wk/wk`);
    }
  }

  if (args.spxYtd != null) {
    if (args.spxYtd >= 5) {
      score += 1;
      signals.push(`S&P YTD +${args.spxYtd}%`);
    } else if (args.spxYtd <= -5) {
      score -= 1;
      signals.push(`S&P YTD ${args.spxYtd}%`);
    }
  }
  if (args.spxWeek != null) {
    if (args.spxWeek >= 2) {
      score += 1;
      signals.push(`S&P +${args.spxWeek}% this week`);
    } else if (args.spxWeek <= -3) {
      score -= 1;
      signals.push(`S&P ${args.spxWeek}% this week`);
    }
  }

  if (args.breadth >= 65) {
    score += 1;
    signals.push(`${args.breadth}% of S&P above 200DMA (healthy)`);
  } else if (args.breadth <= 40) {
    score -= 1;
    signals.push(`${args.breadth}% of S&P above 200DMA (thin)`);
  }

  if (args.curve10y2y != null) {
    if (args.curve10y2y < -25) {
      score -= 1;
      signals.push(`10Y-2Y inverted at ${args.curve10y2y}bps`);
    } else if (args.curve10y2y > 50) {
      score += 1;
      signals.push(`10Y-2Y steepening (${args.curve10y2y}bps)`);
    }
  }

  let regime: "Risk-On" | "Neutral" | "Risk-Off";
  if (score >= 3) regime = "Risk-On";
  else if (score <= -3) regime = "Risk-Off";
  else regime = "Neutral";

  return { regime, score, signals };
}
