import { getRedis } from "@/app/lib/redis";
import type { OHLCVBar } from "@/app/lib/technicals";
import {
  type MarketRegimeData,
  composeRegime,
  computeCrossAssetReadout,
  computeCreditSignal,
  computeYieldCurveSignal,
  computeBreadthDivergence,
  computeIsmPmi,
  computeRatioSignal,
  computeSpx10mTrend,
  vixReadout,
} from "@/app/lib/market-regime";
import { fredSeries } from "@/app/lib/forward-looking";
import { rollupHorizons, signalsToFlip } from "@/app/lib/horizons";
import { easternToday } from "@/app/lib/date-eastern";
import {
  type RegimeHistoryRow,
  applyLabelHysteresis,
  readRegimeHistory,
  upsertTodayRegimeRow,
} from "@/app/lib/regime-history";

/**
 * Market-regime compute + cache, extracted from /api/market-regime so BOTH the
 * route AND the nightly cron can rebuild it. The cron needs this because
 * pm:market-regime is a 30-min cache that only ever refreshed on a page load —
 * at 06:00 UTC nobody is on the dashboard, so the alert digest was computing
 * regime/transition alerts off a snapshot that could be a day old.
 *
 * pm:market-regime is a PURE CACHE over Yahoo/FRED-derived math — no user input.
 * Safe to nuke; the next call rebuilds it. Never deletes, never seeds defaults.
 */

export const REGIME_KEY = "pm:market-regime";
export const REGIME_STALE_MS = 30 * 60 * 1000; // 30 minutes

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fetchBars(symbol: string, range: string, interval: string): Promise<OHLCVBar[]> {
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo ${symbol} returned ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No result for ${symbol}`);
  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) throw new Error(`No bars for ${symbol}`);
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    bars.push({
      date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      open, high, low, close, volume: volume ?? 0,
    });
  }
  return bars;
}

/** Safe wrapper — never throws; returns empty array on error. */
async function safeBars(symbol: string, range: string, interval: string): Promise<OHLCVBar[]> {
  try {
    return await fetchBars(symbol, range, interval);
  } catch (e) {
    console.error(`market-regime: failed to fetch ${symbol}`, e);
    return [];
  }
}

/** How long a cached FRED-derived readout may stand in when today's FRED call
 *  fails. Prevents a transient fetch error from silently pulling the ISM /
 *  credit / curve votes off the slate (which used to move the label with
 *  zero market movement). ISM prints monthly, so it gets a longer leash. */
const FRED_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const ISM_FALLBACK_MS = 60 * 24 * 60 * 60 * 1000;

function cacheAgeMs(cached: MarketRegimeData | null): number {
  if (!cached) return Infinity;
  const t = new Date(cached.computedAt).getTime();
  return isFinite(t) ? Date.now() - t : Infinity;
}

export async function computeFromYahoo(cached: MarketRegimeData | null = null): Promise<MarketRegimeData> {
  // Fetch all required series in parallel. Daily 1y is enough to cover
  // a 50-day SMA with a 20-day lookback cushion (~70 trading days);
  // SPX needs monthly so we ask for 5y daily and resample.
  // FRED NAPM = ISM Manufacturing PMI (monthly diffusion index). We pull
  // 12 prints so the readout has plenty of history for the 3-month change
  // and the 50-line crossover check. `fredSeries` returns null when
  // FRED_API_KEY is missing or the request fails — we tolerate both.
  const [
    spxDaily,
    rsp, spy,
    xly, xlp,
    xlk, xlu,
    mtum, usmv,
    vix,
    dxy, tnx, oil,
    stoxx, nikkei,
    napmObs,
    hyOasObs,
    curveObs,
  ] = await Promise.all([
    safeBars("^GSPC", "5y", "1d"),
    safeBars("RSP", "1y", "1d"),
    safeBars("SPY", "1y", "1d"),
    safeBars("XLY", "1y", "1d"),
    safeBars("XLP", "1y", "1d"),
    safeBars("XLK", "1y", "1d"),
    safeBars("XLU", "1y", "1d"),
    safeBars("MTUM", "1y", "1d"),
    safeBars("USMV", "1y", "1d"),
    safeBars("^VIX", "3mo", "1d"),
    safeBars("DX-Y.NYB", "3mo", "1d"),
    safeBars("^TNX", "3mo", "1d"),
    safeBars("CL=F", "3mo", "1d"),
    safeBars("^STOXX", "3mo", "1d"),
    safeBars("^N225", "3mo", "1d"),
    fredSeries("NAPM", 12).catch(() => null),
    fredSeries("BAMLH0A0HYM2", 40).catch(() => null), // HY OAS (credit spreads)
    fredSeries("T10Y2Y", 5).catch(() => null), // 10Y-2Y curve (rates dimension)
  ]);

  const spx10m = computeSpx10mTrend(spxDaily);
  const breadth = computeRatioSignal(rsp, spy);
  const xlyXlp = computeRatioSignal(xly, xlp);
  const xlkXlu = computeRatioSignal(xlk, xlu);
  const mtumUsmv = computeRatioSignal(mtum, usmv);

  const vixR = vixReadout(vix);
  const dxyR = computeCrossAssetReadout("DXY", dxy);
  const tnxR = computeCrossAssetReadout("^TNX", tnx);
  const oilR = computeCrossAssetReadout("CL=F", oil);
  const stoxxR = computeCrossAssetReadout("^STOXX", stoxx);
  const nikkeiR = computeCrossAssetReadout("^N225", nikkei);

  // FRED-derived readouts fall back to the cached copy when today's fetch
  // fails, so the slate stays fixed (see FRED_FALLBACK_MS). A missing
  // FRED_API_KEY still yields null everywhere — that's a config state, not a
  // transient error, and the cache would be null too.
  const age = cacheAgeMs(cached);
  const ismFresh = napmObs ? computeIsmPmi(napmObs) : null;
  const ismPmi = ismFresh ?? (age < ISM_FALLBACK_MS ? cached?.ismPmi ?? null : null);
  const creditFresh = computeCreditSignal(hyOasObs);
  const credit = creditFresh ?? (age < FRED_FALLBACK_MS ? cached?.credit ?? null : null);
  const curveFresh = computeYieldCurveSignal(curveObs);
  const curve = curveFresh ?? (age < FRED_FALLBACK_MS ? cached?.curve ?? null : null);
  const breadthDivergence = computeBreadthDivergence(spx10m, breadth);

  const parts = {
    spx10m,
    breadth,
    sectorRatios: { xlyXlp, xlkXlu, mtumUsmv },
    crossAsset: { vix: vixR, dxy: dxyR, tnx: tnxR, oil: oilR },
    global: { stoxx: stoxxR, nikkei: nikkeiR },
    ismPmi,
    credit,
    curve,
    breadthDivergence,
  };
  const composite = composeRegime(parts);
  const horizons = rollupHorizons(composite.signals);

  // Hysteresis: the committed label only follows the raw label after it has
  // read the same way for HYSTERESIS_CONFIRM_DAYS sessions (regime-history.ts).
  const today = easternToday();
  const history = await readRegimeHistory();
  const prior = history.filter((r) => r.date < today);
  const raw = composite.rawLabel ?? composite.label;
  const hyst = applyLabelHysteresis(raw, prior);
  composite.label = hyst.label;
  composite.pending = hyst.pending;
  // Fewest signal changes that would move the RAW label off where it is.
  composite.signalsToShed =
    raw === "Neutral"
      ? Math.min(signalsToFlip(horizons, "Risk-On"), signalsToFlip(horizons, "Risk-Off"))
      : signalsToFlip(horizons, "Neutral");
  if (!isFinite(composite.signalsToShed)) composite.signalsToShed = null;

  const computedAt = new Date().toISOString();
  const data: MarketRegimeData = { computedAt, ...parts, composite, horizons };

  const row: RegimeHistoryRow = {
    date: today,
    computedAt,
    rawLabel: raw,
    label: composite.label,
    weightedScore: composite.weightedScore ?? null,
    score100: composite.score100 ?? null,
    riskOn: composite.signals.filter((s) => s.direction === "risk-on").length,
    riskOff: composite.signals.filter((s) => s.direction === "risk-off").length,
    total: composite.total,
    signals: Object.fromEntries(composite.signals.map((s) => [s.name, s.direction])),
    horizons: {
      tactical: isFinite(horizons.byHorizon.tactical.score) ? horizons.byHorizon.tactical.score : null,
      cyclical: isFinite(horizons.byHorizon.cyclical.score) ? horizons.byHorizon.cyclical.score : null,
      structural: isFinite(horizons.byHorizon.structural.score) ? horizons.byHorizon.structural.score : null,
    },
    spx: spx10m?.price ?? null,
    vix: vixR?.price ?? null,
  };
  await upsertTodayRegimeRow(row);

  return data;
}

export async function readRegimeCache(): Promise<MarketRegimeData | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(REGIME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketRegimeData;
    // Lazy backfill: older blobs predate the `horizons` field. Recompute it
    // from the cached composite signals so the UI doesn't have to wait for
    // the 30-min recompute window. Pure projection — no I/O, no risk.
    if (!parsed.horizons && parsed.composite?.signals) {
      parsed.horizons = rollupHorizons(parsed.composite.signals);
    }
    return parsed;
  } catch (e) {
    console.error("market-regime cache read error:", e);
    return null;
  }
}

export async function writeRegimeCache(data: MarketRegimeData): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.set(REGIME_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("market-regime cache write error:", e);
  }
}

/** Recompute from Yahoo/FRED and persist. Throws if the compute fails so the
 *  caller can decide whether to fall back to a stale cache. */
export async function refreshMarketRegime(): Promise<MarketRegimeData> {
  const cached = await readRegimeCache();
  const fresh = await computeFromYahoo(cached);
  await writeRegimeCache(fresh);
  return fresh;
}
