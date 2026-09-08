/**
 * Calendar section — earnings across Portfolio / Watchlist / Suggested, the
 * prints that just landed (FactSet metrics recap: reported vs consensus), and
 * the economic calendar with the most recent actual for each release.
 *
 * Redis: reads pm:stocks, pm:suggested-watchlist, pm:street-takeaways
 * (all READ-ONLY); owns the regenerable cache `pm:earnings-dates` (Yahoo
 * next-earnings dates for names NOT in pm:stocks, 24h TTL, safe to nuke).
 *
 * Consensus for economic prints is NOT available from any wired source
 * (FRED publishes actuals only). Every EconResult carries `consensus: null`
 * and `consensusSource: "none"` so a source can be plugged in without a
 * shape change.
 */

import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { easternToday, daysFromToday } from "@/app/lib/date-eastern";
import { earningsEvents, econEvents, fomcEvents, type CatalystCalendar } from "@/app/lib/catalyst-calendar";
import { fredSeries } from "@/app/lib/forward-looking";
import { loadStreetTakeaways, type StreetTakeaway } from "@/app/lib/street-takeaways";
import { SUGGESTED_STORE_KEY, type SuggestedStore } from "@/app/lib/suggested-watchlist";
import type { Stock } from "@/app/lib/types";

const log = createLogger("Summary-calendar");

export const EARNINGS_DATES_KEY = "pm:earnings-dates";
const EARNINGS_TTL_MS = 24 * 60 * 60 * 1000;
const SUGGESTED_RECENT_DAYS = 21;

export type EarningsBucket = "Portfolio" | "Watchlist" | "Suggested";

export type EarningsRow = {
  ticker: string;
  name?: string;
  bucket: EarningsBucket;
  date: string;
  daysAway: number;
  weightPct: number | null; // Portfolio only
  impliedMovePct: number | null; // from the latest FactSet metrics recap when present
};

export type PostPrintRow = {
  ticker: string;
  name?: string;
  bucket: "Portfolio" | "Watchlist";
  date: string;
  event?: string;
  results: { label: string; actual?: string; consensus?: string; yoy?: string }[];
  guidance?: string;
  overview?: string;
  trackRecord?: { epsBeatRate?: string; revenueBeatRate?: string; impliedMovePct?: number };
};

export type EconRow = { title: string; date: string; daysAway: number; importance: "high" | "medium"; kind: "econ" | "fomc" };

export type EconResult = {
  title: string;
  series: string;
  asOf: string; // observation period (YYYY-MM-DD)
  actual: number | null;
  prior: number | null;
  unit: string; // "% m/m", "k", "%", "% q/q saar"
  consensus: null;
  consensusSource: "none";
};

export type CalendarSection = {
  today: string;
  windowDays: number;
  earnings: EarningsRow[];
  postPrints: PostPrintRow[];
  econ: EconRow[];
  econRecent: EconResult[];
  econStatus: CatalystCalendar["econStatus"];
};

type EarningsDateCache = Record<string, { date: string | null; fetchedAt: string }>;

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// ── Yahoo next-earnings for names outside pm:stocks ────────────────────────

const YAHOO = "https://query2.finance.yahoo.com";

async function yahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const c = await fetch("https://fc.yahoo.com", { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    const cookie = c.headers.get("set-cookie") || "";
    const r = await fetch(`${YAHOO}/v1/test/getcrumb`, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie }, signal: AbortSignal.timeout(6000) });
    const crumb = await r.text();
    if (!crumb || crumb.includes("error")) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

async function yahooNextEarnings(ticker: string, auth: { cookie: string; crumb: string }): Promise<string | null> {
  try {
    const url = `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const ed = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0];
    const fmt: string | undefined = ed?.fmt;
    const raw: number | undefined = ed?.raw;
    if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}/.test(fmt)) return fmt.slice(0, 10);
    if (typeof raw === "number") return new Date(raw * 1000).toISOString().slice(0, 10);
    return null;
  } catch {
    return null;
  }
}

/** Earnings dates for tickers we don't hold — cached 24h in pm:earnings-dates. */
async function earningsDatesFor(tickers: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (tickers.length === 0) return out;
  const cache = (await readJson<EarningsDateCache>(EARNINGS_DATES_KEY)) ?? {};
  const now = Date.now();
  const missing: string[] = [];
  for (const t of tickers) {
    const c = cache[t];
    if (c && now - Date.parse(c.fetchedAt) < EARNINGS_TTL_MS) out[t] = c.date;
    else missing.push(t);
  }
  if (missing.length > 0) {
    const auth = await yahooCrumb();
    if (auth) {
      const results = await Promise.all(missing.slice(0, 40).map(async (t) => [t, await yahooNextEarnings(t, auth)] as const));
      const fetchedAt = new Date().toISOString();
      for (const [t, d] of results) {
        out[t] = d;
        cache[t] = { date: d, fetchedAt };
      }
      try {
        await (await getRedis()).set(EARNINGS_DATES_KEY, JSON.stringify(cache));
      } catch (e) {
        log.warn("earnings-dates cache write failed:", e);
      }
    }
  }
  return out;
}

// ── FRED actuals ───────────────────────────────────────────────────────────

type EconSpec = { match: string; title: string; series: string; unit: EconResult["unit"]; transform: "mom-pct" | "level" | "diff-k" };
const ECON_SERIES: EconSpec[] = [
  { match: "consumer price index", title: "CPI", series: "CPIAUCSL", unit: "% m/m", transform: "mom-pct" },
  { match: "employment situation", title: "Nonfarm payrolls", series: "PAYEMS", unit: "k", transform: "diff-k" },
  { match: "employment situation", title: "Unemployment rate", series: "UNRATE", unit: "%", transform: "level" },
  { match: "gross domestic product", title: "Real GDP", series: "A191RL1Q225SBEA", unit: "% q/q saar", transform: "level" },
  { match: "personal income", title: "PCE price index", series: "PCEPI", unit: "% m/m", transform: "mom-pct" },
  { match: "producer price index", title: "PPI (final demand)", series: "PPIFIS", unit: "% m/m", transform: "mom-pct" },
  { match: "advance monthly sales for retail", title: "Retail sales", series: "RSAFS", unit: "% m/m", transform: "mom-pct" },
];

async function econActuals(): Promise<EconResult[]> {
  const out: EconResult[] = [];
  await Promise.all(
    ECON_SERIES.map(async (spec) => {
      const obs = await fredSeries(spec.series, 3).catch(() => null);
      if (!obs || obs.length === 0) return;
      const [a, b, c] = obs; // newest first
      const val = (x: { value: number } | undefined) => (x && isFinite(x.value) ? x.value : null);
      let actual: number | null = null;
      let prior: number | null = null;
      if (spec.transform === "level") {
        actual = val(a);
        prior = val(b);
      } else if (spec.transform === "mom-pct") {
        const a0 = val(a), b0 = val(b), c0 = val(c);
        actual = a0 != null && b0 != null && b0 !== 0 ? parseFloat(((a0 / b0 - 1) * 100).toFixed(2)) : null;
        prior = b0 != null && c0 != null && c0 !== 0 ? parseFloat(((b0 / c0 - 1) * 100).toFixed(2)) : null;
      } else {
        const a0 = val(a), b0 = val(b), c0 = val(c);
        actual = a0 != null && b0 != null ? Math.round(a0 - b0) : null;
        prior = b0 != null && c0 != null ? Math.round(b0 - c0) : null;
      }
      out.push({ title: spec.title, series: spec.series, asOf: a.date, actual, prior, unit: spec.unit, consensus: null, consensusSource: "none" });
    })
  );
  const order = ECON_SERIES.map((s) => s.title);
  return out.sort((x, y) => order.indexOf(x.title) - order.indexOf(y.title));
}

// ── Section builder ────────────────────────────────────────────────────────

export async function buildCalendarSection(windowDays = 14): Promise<CalendarSection> {
  const today = easternToday();
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + windowDays * 86_400_000).toISOString().slice(0, 10);

  const [stocksRaw, suggested, takeaways, econ, actuals] = await Promise.all([
    readJson<Stock[] | { stocks?: Stock[] }>("pm:stocks"),
    readJson<SuggestedStore>(SUGGESTED_STORE_KEY),
    loadStreetTakeaways().catch(() => ({} as Record<string, StreetTakeaway[]>)),
    econEvents(today, end).catch(() => ({ events: [], status: "unavailable" as const })),
    econActuals(),
  ]);
  const stocks: Stock[] = Array.isArray(stocksRaw) ? stocksRaw : stocksRaw?.stocks ?? [];
  const heldTickers = new Set(stocks.map((s) => s.ticker.toUpperCase()));
  const nameOf = new Map(stocks.map((s) => [s.ticker.toUpperCase(), s.name]));

  // Latest implied move per ticker from the FactSet metrics recap.
  const impliedMove = new Map<string, number>();
  for (const [tk, list] of Object.entries(takeaways)) {
    const m = list.find((t) => t.kind === "metrics" && typeof t.trackRecord?.impliedMovePct === "number");
    if (m) impliedMove.set(tk.toUpperCase(), m.trackRecord!.impliedMovePct as number);
  }

  // Held names — earningsDate lives on healthData.
  const heldEvents = earningsEvents(
    stocks.map((s) => ({ ticker: s.ticker, name: s.name, bucket: s.bucket, earningsDate: s.healthData?.earningsDate })),
    today,
    end
  );
  const weightOf = new Map(stocks.filter((s) => s.bucket === "Portfolio").map((s) => [s.ticker.toUpperCase(), s.weights?.portfolio ?? null]));
  const earnings: EarningsRow[] = heldEvents.map((e) => {
    const tk = (e.ticker ?? "").toUpperCase();
    const w = weightOf.get(tk);
    return {
      ticker: tk,
      name: nameOf.get(tk),
      bucket: e.bucket === "Portfolio" ? "Portfolio" : "Watchlist",
      date: e.date,
      daysAway: daysFromToday(e.date, today),
      weightPct: typeof w === "number" ? parseFloat((w * 100).toFixed(2)) : null,
      impliedMovePct: impliedMove.get(tk) ?? null,
    };
  });

  // Suggested names (recently seen, not already held) — dates from Yahoo.
  const cutoff = Date.now() - SUGGESTED_RECENT_DAYS * 86_400_000;
  const suggestedTickers = Object.values(suggested?.entries ?? {})
    .filter((e) => e && typeof e.ticker === "string" && Date.parse(e.lastSeenAt) >= cutoff)
    .map((e) => e.ticker.toUpperCase())
    .filter((t) => !heldTickers.has(t));
  const suggestedDates = await earningsDatesFor([...new Set(suggestedTickers)]);
  for (const [tk, d] of Object.entries(suggestedDates)) {
    if (!d || d < today || d > end) continue;
    earnings.push({ ticker: tk, bucket: "Suggested", date: d, daysAway: daysFromToday(d, today), weightPct: null, impliedMovePct: impliedMove.get(tk) ?? null });
  }
  earnings.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  // Prints in the last 7 days with a metrics recap.
  const postPrints: PostPrintRow[] = [];
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  for (const s of stocks) {
    const tk = s.ticker.toUpperCase();
    const list = takeaways[tk] ?? takeaways[s.ticker] ?? [];
    const m = list.find((t) => t.kind === "metrics" && t.date >= weekAgo && t.date <= today);
    if (!m) continue;
    postPrints.push({
      ticker: tk,
      name: s.name,
      bucket: s.bucket,
      date: m.date,
      event: m.event,
      results: (m.results ?? []).slice(0, 4).map((r) => ({ label: r.label, actual: r.actual, consensus: r.consensus, yoy: r.yoy })),
      guidance: m.guidance,
      overview: m.overview,
      trackRecord: m.trackRecord
        ? { epsBeatRate: m.trackRecord.epsBeatRate, revenueBeatRate: m.trackRecord.revenueBeatRate, impliedMovePct: m.trackRecord.impliedMovePct }
        : undefined,
    });
  }
  postPrints.sort((a, b) => b.date.localeCompare(a.date));

  const econRows: EconRow[] = [
    ...econ.events.map((e) => ({ title: e.title, date: e.date, daysAway: daysFromToday(e.date, today), importance: e.importance, kind: "econ" as const })),
    ...fomcEvents(today, end).map((e) => ({ title: e.title, date: e.date, daysAway: daysFromToday(e.date, today), importance: e.importance, kind: "fomc" as const })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return { today, windowDays, earnings, postPrints, econ: econRows, econRecent: actuals, econStatus: econ.status };
}
