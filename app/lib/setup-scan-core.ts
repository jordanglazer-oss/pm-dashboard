import { getRedis } from "./redis";
import {
  computeTechnicals,
  computeImprovingSignals,
  computeBaseSetup,
  type OHLCVBar,
  type BaseSetup,
  type ImprovingScore,
} from "./technicals";

/**
 * Setup-scan engine, shared by the manual button and the nightly cron.
 *
 * Extracted deliberately: two copies of scan logic is the exact shape of the
 * bug that cost a day earlier in this project — one writer's idea of the state
 * diverging from another's. The button and the cron differ only in how many
 * slices they ask for.
 *
 * WHY SLICES. Both Yahoo hosts answer 8/8 from a laptop with these headers, so
 * the 429s are not the endpoint or the pacing: Yahoo throttles DATACENTRE IPs
 * and Vercel's are shared, so much of the per-IP budget is spent by other
 * tenants before this asks for anything. Ninety bar requests will not get
 * through in one invocation however politely spaced — but a few smaller
 * batches separated in time do.
 */

export const SCAN_KEY = "pm:setup-scan";

const YAHOO_HOSTS = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const CONCURRENCY = 3;
const REQUEST_GAP_MS = 150;
const MAX_RETRIES = 3;
export const DEFAULT_LIMIT = 25;
/** A reading from earlier today is the same reading — reuse it. */
const FRESH_MS = 12 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Redis = Awaited<ReturnType<typeof getRedis>>;

export type SetupRow = {
  ticker: string;
  name?: string;
  sector?: string;
  price: number;
  improving: { score: number; label: ImprovingScore["label"]; active: string[] };
  base: BaseSetup | null;
  error?: string;
};

export type ScanResult = {
  generatedAt: string;
  universe: string;
  requested: number;
  reused: number;
  fetched: number;
  failed: number;
  complete: number;
  remaining: number;
  truncated: boolean;
  note?: string;
  rows: SetupRow[];
};

function toYahoo(t: string) {
  if (t.endsWith(".U")) return t.replace(/\.U$/, "-U.TO");
  if (t.endsWith("-T")) return t.replace(/-T$/, ".TO");
  return t;
}

async function fetchBars(ticker: string): Promise<OHLCVBar[]> {
  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Alternate hosts across retries: a 429 is per-host, so trying the other
    // is more useful than waiting longer on the one that just refused.
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
    const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i], volume = q.volume?.[i];
    if (open == null || high == null || low == null || close == null || volume == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open, high, low, close, volume });
  }
  return out;
}

const empty = (t: string, err?: string): SetupRow => ({
  ticker: t, price: 0, improving: { score: 0, label: "None", active: [] }, base: null, error: err,
});

async function scanTickers(tickers: string[], deadlineAt: number): Promise<SetupRow[]> {
  const rows: SetupRow[] = [];
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      if (Date.now() > deadlineAt) return;
      const t = tickers[i++];
      await sleep(REQUEST_GAP_MS);
      try {
        const bars = await fetchBars(t);
        const tech = computeTechnicals(bars);
        if (!tech) { rows.push(empty(t, "not enough history")); continue; }
        const imp = computeImprovingSignals(bars, tech);
        rows.push({
          ticker: t,
          price: tech.currentPrice,
          improving: { score: imp.score, label: imp.label, active: imp.signals.filter((s) => s.active).map((s) => s.name) },
          base: computeBaseSetup(bars, tech),
        });
      } catch (e) {
        rows.push(empty(t, String(e).slice(0, 80)));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));
  return rows;
}

async function resolveUniverse(redis: Redis, opts: RunOpts): Promise<{ tickers: string[]; universe: string }> {
  if (opts.tickers?.length) return { tickers: opts.tickers, universe: "explicit" };

  if (opts.universe === "watchlist" || opts.universe === "portfolio") {
    const raw = await redis.get("pm:stocks");
    const stocks = raw ? (JSON.parse(raw) as { ticker: string; bucket?: string; instrumentType?: string }[]) : [];
    const bucket = opts.universe === "portfolio" ? "Portfolio" : "Watchlist";
    // Funds and ETFs have no base to break out of in any useful sense.
    return {
      tickers: stocks
        .filter((s) => s.bucket === bucket && (!s.instrumentType || s.instrumentType === "stock"))
        .map((s) => s.ticker),
      universe: opts.universe,
    };
  }

  const raw = await redis.get("pm:watchlist-candidates");
  const cands = raw ? (JSON.parse(raw) as { candidates: { ticker: string; fallenOffAt?: string }[] }).candidates : [];
  return { tickers: cands.filter((c) => !c.fallenOffAt).map((c) => c.ticker), universe: "suggested-watchlist" };
}

export type RunOpts = {
  tickers?: string[];
  universe?: "suggested" | "watchlist" | "portfolio";
  limit?: number;
  /** Re-read everything, ignoring today's stored readings. */
  full?: boolean;
  startedAt?: number;
  deadlineMs?: number;
};

export async function runSetupScan(redis: Redis, opts: RunOpts = {}): Promise<ScanResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const deadlineAt = startedAt + (opts.deadlineMs ?? 50_000);
  const { tickers, universe } = await resolveUniverse(redis, opts);
  const unique = [...new Set(tickers)];
  if (unique.length === 0) {
    return { generatedAt: new Date().toISOString(), universe, requested: 0, reused: 0, fetched: 0,
      failed: 0, complete: 0, remaining: 0, truncated: false, rows: [], note: "Nothing to scan." };
  }

  // Reuse today's good readings; re-fetch only what is missing or errored.
  // Without this a throttled run threw away its successes, so every retry
  // restarted from zero and hit the same wall in the same place.
  const prevRaw = await redis.get(SCAN_KEY);
  const prev = prevRaw ? (JSON.parse(prevRaw) as { generatedAt?: string; rows?: SetupRow[] }) : null;
  const fresh12h = prev?.generatedAt ? Date.now() - Date.parse(prev.generatedAt) < FRESH_MS : false;
  const wanted = new Set(unique.map((t) => t.toUpperCase()));
  const carried = !opts.full && fresh12h
    ? (prev?.rows ?? []).filter((r) => wanted.has(r.ticker.toUpperCase()) && !r.error && r.price > 0)
    : [];
  const carriedSet = new Set(carried.map((r) => r.ticker.toUpperCase()));

  const todo = unique.filter((t) => !carriedSet.has(t.toUpperCase()));
  const slice = todo.slice(0, opts.limit && opts.limit > 0 ? Math.min(opts.limit, 90) : DEFAULT_LIMIT);
  const fetched = await scanTickers(slice, deadlineAt);
  const fetchedSet = new Set(fetched.map((r) => r.ticker.toUpperCase()));

  // Keep previously-errored rows visible so a name does not flicker in and out
  // between attempts — they stay eligible for re-fetch, since only GOOD
  // readings are carried.
  const priorErrors = (prev?.rows ?? []).filter(
    (r) => r.error && wanted.has(r.ticker.toUpperCase())
      && !fetchedSet.has(r.ticker.toUpperCase()) && !carriedSet.has(r.ticker.toUpperCase()),
  );

  const rows = [...carried, ...fetched, ...priorErrors];

  // Name and sector from pm:stocks where known — same taxonomy as every other
  // tab, and free for anything already tracked.
  try {
    const raw = await redis.get("pm:stocks");
    const known = new Map(
      ((raw ? JSON.parse(raw) : []) as { ticker: string; name?: string; sector?: string }[])
        .map((k) => [k.ticker.toUpperCase().replace(/-T$/, ".TO"), k]),
    );
    for (const r of rows) {
      const hit = known.get(r.ticker.toUpperCase().replace(/-T$/, ".TO"));
      if (hit) { r.name = hit.name; r.sector = hit.sector; }
    }
  } catch { /* labels are cosmetic */ }

  // Coiled bases first — that is the reading the research sources cannot
  // produce — then recovery strength.
  rows.sort((a, b) => (b.base?.score ?? -1) - (a.base?.score ?? -1) || b.improving.score - a.improving.score);

  const complete = rows.filter((r) => !r.error && r.price > 0).length;
  const result: ScanResult = {
    generatedAt: new Date().toISOString(),
    universe,
    requested: unique.length,
    reused: carried.length,
    fetched: fetched.length,
    failed: fetched.filter((r) => r.error).length,
    complete,
    remaining: unique.length - complete,
    truncated: complete < unique.length,
    note: complete < unique.length
      ? `${complete} of ${unique.length} read. Yahoo throttles datacentre IPs, so each pass takes a slice — readings already taken are kept.`
      : undefined,
    rows,
  };
  await redis.set(SCAN_KEY, JSON.stringify(result));
  return result;
}
