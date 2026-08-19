import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import {
  computeTechnicals,
  computeImprovingSignals,
  computeBaseSetup,
  type OHLCVBar,
  type BaseSetup,
  type ImprovingScore,
} from "@/app/lib/technicals";

export const maxDuration = 60;

const KEY = "pm:setup-scan";
const YAHOO = "https://query1.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";
/** Yahoo throttles hard on parallel bursts; this is a scan, not a page load. */
const CONCURRENCY = 6;
const DEADLINE_MS = 50_000;

/**
 * POST /api/setup-scan — find names that look ready to move, not names that
 * already have.
 *
 * WHY THIS IS SEPARATE from the suggested watchlist. Every research source we
 * ingest is backward-looking by construction: Equate ranks on realised
 * momentum and revisions, SIA on realised relative strength, the broker lists
 * publish after a move. They agree on names that have ALREADY broken out. That
 * is useful and worth keeping — but it means the list systematically cannot
 * surface a stock still coiling, because no provider has written it up yet.
 *
 * This is the first thing in the pipeline WE compute rather than a provider
 * asserting. Two independent readings, deliberately not blended:
 *
 *   improving — the existing 0-6 recovery score (RSI lifting off a low, MACD
 *     turning up, approaching a DMA from below, reclaiming the cloud). A stock
 *     coming back from weakness.
 *   base — the new 0-4 coil score (near the high but not at it, range
 *     contracting, volume drying up, above both MAs). A strong stock going
 *     quiet.
 *
 * Averaging them would hide which one a name actually is, and they call for
 * different trades. They are reported side by side and either can be sorted on.
 *
 * Reads price bars only. Writes pm:setup-scan and nothing else.
 */

function toYahoo(t: string) {
  if (t.endsWith(".U")) return t.replace(/\.U$/, "-U.TO");
  if (t.endsWith("-T")) return t.replace(/-T$/, ".TO");
  return t;
}

async function fetchBars(ticker: string): Promise<OHLCVBar[]> {
  const res = await fetch(
    `${YAHOO}/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=1y&interval=1d`,
    { cache: "no-store", headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q || ts.length === 0) throw new Error("no bars");
  const out: OHLCVBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const { open, high, low, close, volume } = {
      open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    };
    if (open == null || high == null || low == null || close == null || volume == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open, high, low, close, volume });
  }
  return out;
}

export type SetupRow = {
  ticker: string;
  name?: string;
  sector?: string;
  price: number;
  improving: { score: number; label: ImprovingScore["label"]; active: string[] };
  base: BaseSetup | null;
  error?: string;
};

async function scanTickers(tickers: string[], startedAt: number) {
  const rows: SetupRow[] = [];
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      if (Date.now() - startedAt > DEADLINE_MS) return;
      const t = tickers[i++];
      try {
        const bars = await fetchBars(t);
        const tech = computeTechnicals(bars);
        if (!tech) { rows.push({ ticker: t, price: 0, improving: { score: 0, label: "None", active: [] }, base: null, error: "not enough history" }); continue; }
        const imp = computeImprovingSignals(bars, tech);
        rows.push({
          ticker: t,
          price: tech.currentPrice,
          improving: { score: imp.score, label: imp.label, active: imp.signals.filter((s) => s.active).map((s) => s.name) },
          base: computeBaseSetup(bars, tech),
        });
      } catch (e) {
        rows.push({ ticker: t, price: 0, improving: { score: 0, label: "None", active: [] }, base: null, error: String(e).slice(0, 80) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));
  return rows;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const body = await req.json().catch(() => ({}));
  const redis = await getRedis();

  // Universe: explicit list, else the suggested candidates, else the watchlist.
  let tickers: string[] = Array.isArray(body?.tickers) ? body.tickers : [];
  let universe = "explicit";
  if (tickers.length === 0) {
    const raw = await redis.get("pm:watchlist-candidates");
    const cands = raw ? (JSON.parse(raw) as { candidates: { ticker: string; fallenOffAt?: string }[] }).candidates : [];
    tickers = cands.filter((c) => !c.fallenOffAt).map((c) => c.ticker);
    universe = "suggested-watchlist";
  }
  if (tickers.length === 0) {
    const raw = await redis.get("pm:stocks");
    const stocks = raw ? (JSON.parse(raw) as { ticker: string; bucket?: string }[]) : [];
    tickers = stocks.filter((s) => s.bucket === "Watchlist").map((s) => s.ticker);
    universe = "watchlist";
  }
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: "No tickers to scan." }, { status: 400 });
  }

  const rows = await scanTickers([...new Set(tickers)], startedAt);

  // Name and sector from pm:stocks where known — same taxonomy as everywhere
  // else, and free for anything already tracked.
  try {
    const raw = await redis.get("pm:stocks");
    const known = new Map(
      ((raw ? JSON.parse(raw) : []) as { ticker: string; name?: string; sector?: string }[]).map((k) => [
        k.ticker.toUpperCase().replace(/-T$/, ".TO"), k,
      ]),
    );
    for (const r of rows) {
      const hit = known.get(r.ticker.toUpperCase().replace(/-T$/, ".TO"));
      if (hit) { r.name = hit.name; r.sector = hit.sector; }
    }
  } catch { /* labels are cosmetic here */ }

  // Coiled bases first, then recovery strength. Sorting on base by default
  // because that is the reading the existing sources CANNOT produce.
  rows.sort((a, b) => (b.base?.score ?? -1) - (a.base?.score ?? -1) || b.improving.score - a.improving.score);

  const payload = {
    generatedAt: new Date().toISOString(),
    universe,
    scanned: rows.length,
    requested: tickers.length,
    truncated: rows.length < tickers.length,
    rows,
  };
  if (!body?.dryRun) await redis.set(KEY, JSON.stringify(payload));
  return NextResponse.json({ ...payload, rows: rows.slice(0, 100) });
}

export async function GET() {
  try {
    const raw = await (await getRedis()).get(KEY);
    return NextResponse.json(raw ? JSON.parse(raw) : { rows: [], generatedAt: null });
  } catch {
    return NextResponse.json({ rows: [], generatedAt: null });
  }
}
