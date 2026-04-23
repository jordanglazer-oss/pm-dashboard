import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { OHLCVBar } from "@/app/lib/technicals";
import {
  type MarketRegimeData,
  composeRegime,
  computeCrossAssetReadout,
  computeIsmPmi,
  computeRatioSignal,
  computeSpx10mTrend,
  vixReadout,
} from "@/app/lib/market-regime";
import { fredSeries } from "@/app/lib/forward-looking";
import { rollupHorizons } from "@/app/lib/horizons";

/**
 * Market regime endpoint.
 *
 * GET /api/market-regime            → cached value if fresh (<30min),
 *                                     else recomputes from Yahoo.
 * GET /api/market-regime?refresh=1  → forces a fresh fetch.
 *
 * Storage: `pm:market-regime` holds the last successful `MarketRegimeData`
 * snapshot. It is a pure cache over Yahoo-derived math — it does NOT
 * contain user input. Read-error / missing-key → recompute from Yahoo
 * and write back. If the Yahoo fetch fails we fall back to whatever is
 * cached (even if stale) rather than showing an empty panel.
 *
 * CLAUDE.md compliance: no `redis.del`, no seeding with empty defaults,
 * and no overwrite from a client-supplied payload — only the server's
 * own compute is persisted here.
 */

const KEY = "pm:market-regime";
const STALE_MS = 30 * 60 * 1000; // 30 minutes

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

async function computeFromYahoo(): Promise<MarketRegimeData> {
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

  const ismPmi = napmObs ? computeIsmPmi(napmObs) : null;

  const parts = {
    spx10m,
    breadth,
    sectorRatios: { xlyXlp, xlkXlu, mtumUsmv },
    crossAsset: { vix: vixR, dxy: dxyR, tnx: tnxR, oil: oilR },
    global: { stoxx: stoxxR, nikkei: nikkeiR },
    ismPmi,
  };
  const composite = composeRegime(parts);
  const horizons = rollupHorizons(composite.signals);

  return { computedAt: new Date().toISOString(), ...parts, composite, horizons };
}

async function readCache(): Promise<MarketRegimeData | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
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

async function writeCache(data: MarketRegimeData): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(data));
  } catch (e) {
    console.error("market-regime cache write error:", e);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const forceRefresh = searchParams.get("refresh") === "1";

  const cached = await readCache();
  if (!forceRefresh && cached) {
    const age = Date.now() - new Date(cached.computedAt).getTime();
    if (isFinite(age) && age < STALE_MS) {
      return NextResponse.json({ regime: cached, cached: true, ageMs: age });
    }
  }

  try {
    const fresh = await computeFromYahoo();
    await writeCache(fresh);
    return NextResponse.json({ regime: fresh, cached: false, ageMs: 0 });
  } catch (e) {
    console.error("market-regime compute failed:", e);
    // Fall back to whatever is cached (even if stale). If there's no
    // cache either, return null — the UI can render a blank state.
    if (cached) {
      const age = Date.now() - new Date(cached.computedAt).getTime();
      return NextResponse.json({ regime: cached, cached: true, ageMs: age, stale: true });
    }
    return NextResponse.json({ regime: null, error: "Failed to compute and no cache available" }, { status: 503 });
  }
}
