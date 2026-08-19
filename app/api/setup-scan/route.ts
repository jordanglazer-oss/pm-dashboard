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
/**
 * query2 first, query1 as fallback.
 *
 * /api/prices has been fetching 250 tickers in parallel from query2 without
 * trouble for as long as it has existed, while this route was 429ing on the
 * third request against query1 — the hosts are limited independently. Matching
 * the endpoint and User-Agent of the call that already works is a better
 * starting point than inventing a new one and tuning around its limits.
 */
const YAHOO_HOSTS = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
/**
 * Yahoo rate-limits aggressively. Six parallel workers with no pacing got two
 * names through and then 429'd the other 87 — the scan "succeeded" while
 * returning almost nothing.
 *
 * Two workers with a gap between requests keeps roughly 4-5 req/sec, which
 * Yahoo tolerates. A 429 is retried with backoff rather than discarded: it is
 * a "slow down", not a "no such ticker", and treating it as failure threw away
 * names that would have answered a moment later.
 */
const CONCURRENCY = 3;
const REQUEST_GAP_MS = 150;
/**
 * Fetches attempted per invocation.
 *
 * Both Yahoo hosts answer 8/8 from a laptop, so the 429s are not the endpoint
 * or the pacing — Yahoo throttles DATACENTRE IPs, and Vercel's are shared, so
 * a large part of the per-IP budget is already spent by someone else before
 * this route asks for anything. Ninety requests for a year of daily bars in
 * one invocation will not get through however politely they are spaced.
 *
 * So the scan is a SLICE, not a sweep: it takes a bite, stores it, and the
 * next run continues where it stopped. Repeated runs (or a cron) complete the
 * picture, and a partial answer built up over three passes is worth far more
 * than a complete answer that never arrives.
 */
const MAX_FETCH_PER_RUN = 25;
const MAX_RETRIES = 3;
const DEADLINE_MS = 50_000;
/** A reading from earlier today is still the same reading — reuse it so a
 *  re-run spends its request budget on what actually failed. */
const FRESH_MS = 12 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Alternate hosts across retries: a 429 is per-host, so trying the other
    // one is more useful than waiting longer on the one that just refused.
    const host = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];
    res = await fetch(
      `${host}/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=1y&interval=1d`,
      { cache: "no-store", headers: { "User-Agent": UA } },
    );
    if (res.status !== 429) break;
    if (attempt < MAX_RETRIES) await sleep(400 * Math.pow(2, attempt));
  }
  if (!res || !res.ok) throw new Error(`Yahoo ${res?.status ?? "no response"}`);
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
      // Pace the workers so the burst never trips the limiter in the first
      // place; retries are the safety net, not the strategy.
      await sleep(REQUEST_GAP_MS);
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

  // Universe: an explicit ticker list, a named bucket, or the suggested
  // candidates by default.
  let tickers: string[] = Array.isArray(body?.tickers) ? body.tickers : [];
  let universe = "explicit";

  const wanted = typeof body?.universe === "string" ? body.universe : null;
  if (tickers.length === 0 && (wanted === "watchlist" || wanted === "portfolio")) {
    const raw = await redis.get("pm:stocks");
    const stocks = raw ? (JSON.parse(raw) as { ticker: string; bucket?: string; instrumentType?: string }[]) : [];
    const bucket = wanted === "portfolio" ? "Portfolio" : "Watchlist";
    // Funds and ETFs have no base to break out of in any useful sense, so they
    // are excluded rather than padding the list with names that will never
    // score.
    tickers = stocks
      .filter((s) => s.bucket === bucket && (!s.instrumentType || s.instrumentType === "stock"))
      .map((s) => s.ticker);
    universe = wanted;
  }

  if (tickers.length === 0 && !wanted) {
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

  const unique = [...new Set(tickers)];

  // ── Incremental ────────────────────────────────────────────────────────
  // Reuse today's good readings and re-fetch only what is missing or errored.
  // Without this a rate-limited run threw away its successes too, so every
  // retry restarted from zero and hit the same wall in the same place.
  let carried: SetupRow[] = [];
  if (!body?.full) {
    try {
      const prevRaw = await redis.get(KEY);
      const prev = prevRaw ? (JSON.parse(prevRaw) as { generatedAt?: string; rows?: SetupRow[] }) : null;
      const age = prev?.generatedAt ? Date.now() - Date.parse(prev.generatedAt) : Infinity;
      if (prev?.rows && age < FRESH_MS) {
        const wanted = new Set(unique.map((t) => t.toUpperCase()));
        carried = prev.rows.filter((r) => wanted.has(r.ticker.toUpperCase()) && !r.error && r.price > 0);
      }
    } catch { /* no carry-over; scan everything */ }
  }
  const carriedSet = new Set(carried.map((r) => r.ticker.toUpperCase()));
  const todo = unique.filter((t) => !carriedSet.has(t.toUpperCase()));

  // One slice per run. Anything not reached stays untouched and is picked up
  // next time, rather than being fetched and failing.
  const limit = Number(body?.limit) > 0 ? Math.min(Number(body.limit), 90) : MAX_FETCH_PER_RUN;
  const slice = todo.slice(0, limit);
  const fresh = await scanTickers(slice, startedAt);

  // Carry forward previous ERRORED rows too, so a name that failed twice does
  // not vanish from the table between attempts — but they stay eligible for a
  // re-fetch, since `carried` only reuses good readings.
  const freshSet = new Set(fresh.map((r) => r.ticker.toUpperCase()));
  let priorErrors: SetupRow[] = [];
  try {
    const prevRaw = await redis.get(KEY);
    const prev = prevRaw ? (JSON.parse(prevRaw) as { rows?: SetupRow[] }) : null;
    const wanted = new Set(unique.map((t) => t.toUpperCase()));
    priorErrors = (prev?.rows ?? []).filter(
      (r) => r.error && wanted.has(r.ticker.toUpperCase()) && !freshSet.has(r.ticker.toUpperCase()) && !carriedSet.has(r.ticker.toUpperCase()),
    );
  } catch { /* nothing to carry */ }

  const rows = [...carried, ...fresh, ...priorErrors];

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
    requested: unique.length,
    reused: carried.length,
    fetched: fresh.length,
    failed: fresh.filter((r) => r.error).length,
    // "Remaining" counts names with NO good reading yet — the honest measure of
    // how much of the universe is still unknown, not how many rows exist.
    remaining: unique.length - rows.filter((r) => !r.error && r.price > 0).length,
    complete: rows.filter((r) => !r.error && r.price > 0).length,
    truncated: unique.length > rows.filter((r) => !r.error && r.price > 0).length,
    rows,
  };
  const done = rows.filter((r) => !r.error && r.price > 0).length;
  (payload as Record<string, unknown>).note =
    done < unique.length
      ? `${done} of ${unique.length} scanned. Yahoo throttles datacentre IPs, so each run takes a slice — run again to continue; readings already taken are kept.`
      : undefined;

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
