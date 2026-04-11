// Forward-looking market data with direct sources for verification.
// Every data point returns { value, source, asOf, previous? } so the user
// can click through and sanity-check any number we feed to the morning
// brief. FRED is used when FRED_API_KEY is set (more accurate for rates
// and credit); otherwise we fall back to Yahoo Finance everywhere.

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
};

export type ForwardLookingData = {
  spxYtd: ForwardPoint; // S&P 500 % change YTD
  spxWeek: ForwardPoint; // S&P 500 % change trailing 5 days
  spyForwardPE: ForwardPoint; // SPY forward P/E (proxy for S&P 500)
  spyTrailingPE: ForwardPoint; // SPY trailing 12m P/E
  impliedEpsGrowth: ForwardPoint; // (trailing/forward - 1), % implied fwd EPS growth
  yield10y: ForwardPoint; // 10Y Treasury
  yield2y: ForwardPoint; // 2Y Treasury (FRED only)
  yield3m: ForwardPoint; // 3M T-Bill
  curve10y2y: ForwardPoint; // 10Y-2Y spread (bps)
  curve10y3m: ForwardPoint; // 10Y-3M spread (bps)
  hyOasTrend: ForwardPoint; // HY OAS current vs ~5d ago (bps), FRED only
  igOasTrend: ForwardPoint; // IG OAS current vs ~5d ago (bps), FRED only
  vixWeek: ForwardPoint; // VIX now vs ~5 trading days ago
  moveWeek: ForwardPoint; // MOVE now vs ~5 trading days ago
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
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol
      )}?range=${range}&interval=1d&includePrePost=false`,
      { headers: { "User-Agent": YH_UA }, cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.chart?.result?.[0] ?? null) as YahooChartResult | null;
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

export async function fetchForwardLookingData(): Promise<ForwardLookingData> {
  const asOf = new Date().toISOString();
  const fredEnabled = !!process.env.FRED_API_KEY;

  // ── S&P 500 YTD and weekly change (Yahoo ^GSPC) ───────────────────────────
  const spxSource = "https://finance.yahoo.com/quote/%5EGSPC/";
  let spxYtd: ForwardPoint = missing(
    spxSource,
    "Yahoo Finance ^GSPC",
    "Yahoo chart unavailable"
  );
  let spxWeek: ForwardPoint = missing(
    spxSource,
    "Yahoo Finance ^GSPC",
    "Yahoo chart unavailable"
  );
  try {
    const [ytdRes, wkRes] = await Promise.all([
      yahooChart("^GSPC", "ytd"),
      yahooChart("^GSPC", "5d"),
    ]);
    const ytdCloses: (number | null)[] =
      ytdRes?.indicators?.quote?.[0]?.close ?? [];
    const ytdFirst =
      ytdCloses.find((v): v is number => typeof v === "number") ?? null;
    const nowPrice: number | null =
      ytdRes?.meta?.regularMarketPrice ??
      (ytdCloses
        .filter((v): v is number => typeof v === "number")
        .slice(-1)[0] ??
        null);
    const spxYtdValue = pct(nowPrice, ytdFirst);
    spxYtd = {
      value: spxYtdValue,
      source: spxSource,
      sourceLabel: "Yahoo Finance ^GSPC",
      asOf,
      previous: ytdFirst,
      note: "S&P 500 percent change from first trading day of the current calendar year.",
      status: spxYtdValue != null ? "live" : "failed",
    };

    const wkClosesAll: number[] = (wkRes?.indicators?.quote?.[0]?.close ?? [])
      .filter((v): v is number => typeof v === "number");
    const wkNow =
      wkRes?.meta?.regularMarketPrice ??
      (wkClosesAll.length ? wkClosesAll[wkClosesAll.length - 1] : null);
    const wkFirst = wkClosesAll.length > 0 ? wkClosesAll[0] : null;
    const spxWeekValue = pct(wkNow, wkFirst);
    spxWeek = {
      value: spxWeekValue,
      source: spxSource,
      sourceLabel: "Yahoo Finance ^GSPC",
      asOf,
      previous: wkFirst,
      note: "S&P 500 percent change over the trailing 5 trading days.",
      status: spxWeekValue != null ? "live" : "failed",
    };
  } catch {
    // leave as missing
  }

  // ── SPY forward / trailing P/E and implied EPS growth ────────────────────
  const spyKeyStatsUrl = "https://finance.yahoo.com/quote/SPY/key-statistics";
  let spyForwardPE: ForwardPoint = missing(
    spyKeyStatsUrl,
    "Yahoo Finance SPY",
    "Yahoo quote summary unavailable"
  );
  let spyTrailingPE: ForwardPoint = missing(
    spyKeyStatsUrl,
    "Yahoo Finance SPY",
    "Yahoo quote summary unavailable"
  );
  let impliedEpsGrowth: ForwardPoint = missing(
    spyKeyStatsUrl,
    "Yahoo Finance SPY",
    "Derived from (trailing P/E / forward P/E - 1); needs both values."
  );
  try {
    const summary = await yahooQuoteSummary(
      "SPY",
      "summaryDetail,defaultKeyStatistics"
    );
    const det = summary?.summaryDetail;
    const ks = summary?.defaultKeyStatistics;
    const fwd: number | null =
      det?.forwardPE?.raw ?? ks?.forwardPE?.raw ?? null;
    const trl: number | null =
      det?.trailingPE?.raw ?? ks?.trailingPE?.raw ?? null;
    if (fwd != null) {
      spyForwardPE = {
        value: parseFloat(fwd.toFixed(2)),
        source: spyKeyStatsUrl,
        sourceLabel: "Yahoo Finance SPY",
        asOf,
        note: "SPY forward blended P/E — used as the closest automated proxy for the S&P 500 forward multiple.",
        status: "live",
      };
    }
    if (trl != null) {
      spyTrailingPE = {
        value: parseFloat(trl.toFixed(2)),
        source: spyKeyStatsUrl,
        sourceLabel: "Yahoo Finance SPY",
        asOf,
        note: "SPY trailing twelve-month P/E.",
        status: "live",
      };
    }
    if (fwd != null && trl != null && fwd > 0) {
      const impl = (trl / fwd - 1) * 100;
      impliedEpsGrowth = {
        value: parseFloat(impl.toFixed(1)),
        source: spyKeyStatsUrl,
        sourceLabel: "Yahoo Finance SPY",
        asOf,
        note: "Implied forward 12-month EPS growth, derived as (trailing P/E / forward P/E - 1) × 100.",
        status: "live",
      };
    }
  } catch {
    // leave as missing
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

  // ── VIX / MOVE weekly deltas (Yahoo) ─────────────────────────────────────
  const mkVolPoint = (
    res: YahooChartResult | null,
    tickerEncoded: string,
    label: string
  ): ForwardPoint => {
    const closes: number[] = (res?.indicators?.quote?.[0]?.close ?? []).filter(
      (v): v is number => typeof v === "number"
    );
    const now =
      res?.meta?.regularMarketPrice ??
      (closes.length ? closes[closes.length - 1] : null);
    const prior = closes.length > 0 ? closes[0] : null;
    return {
      value: now != null ? parseFloat(now.toFixed(2)) : null,
      source: `https://finance.yahoo.com/quote/%5E${tickerEncoded}`,
      sourceLabel: label,
      asOf,
      previous: prior != null ? parseFloat(prior.toFixed(2)) : null,
      note: `${label} current price with 5-trading-day prior for week-over-week delta.`,
      status: now != null ? "live" : "failed",
    };
  };

  let vixWeek: ForwardPoint = missing(
    "https://finance.yahoo.com/quote/%5EVIX",
    "Yahoo Finance ^VIX",
    "Yahoo chart unavailable"
  );
  let moveWeek: ForwardPoint = missing(
    "https://finance.yahoo.com/quote/%5EMOVE",
    "Yahoo Finance ^MOVE",
    "Yahoo chart unavailable"
  );
  try {
    const [vix5d, move5d] = await Promise.all([
      yahooChart("^VIX", "5d"),
      yahooChart("^MOVE", "5d"),
    ]);
    vixWeek = mkVolPoint(vix5d, "VIX", "Yahoo Finance ^VIX");
    moveWeek = mkVolPoint(move5d, "MOVE", "Yahoo Finance ^MOVE");
  } catch {
    // leave as missing
  }

  return {
    spxYtd,
    spxWeek,
    spyForwardPE,
    spyTrailingPE,
    impliedEpsGrowth,
    yield10y,
    yield2y,
    yield3m,
    curve10y2y,
    curve10y3m,
    hyOasTrend,
    igOasTrend,
    vixWeek,
    moveWeek,
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
