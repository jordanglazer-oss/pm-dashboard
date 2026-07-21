/**
 * Catalyst Calendar — Phase 01 of the forward-looking roadmap
 * (docs/forward-looking-roadmap.md).
 *
 * Assembles the forward event calendar the Brief currently has no view of:
 *   - EARNINGS: read straight off pm:stocks (refresh-data already stores
 *     `earningsDate` per holding via Yahoo calendarEvents — no re-fetch).
 *   - ECON: FRED release-dates calendar (CPI, jobs, GDP, PCE, PPI, retail),
 *     using the FRED_API_KEY integration already present in forward-looking.ts.
 *   - FOMC: the Fed's published 2026 meeting schedule (decision day).
 *
 * Pure derived data. The route caches the result in pm:catalyst-calendar
 * (a cache, safe to nuke). No user input, no mutation of source keys.
 */

import { createLogger } from "@/app/lib/logger";
import { easternToday } from "@/app/lib/date-eastern";

const log = createLogger("Catalyst");

export type CatalystKind = "earnings" | "econ" | "fomc";
export type CatalystImportance = "high" | "medium";

export type CatalystEvent = {
  date: string; // YYYY-MM-DD
  kind: CatalystKind;
  title: string; // "NVDA earnings" | "CPI" | "FOMC decision"
  importance: CatalystImportance;
  ticker?: string; // earnings only
  bucket?: string; // earnings only — "Portfolio" | "Watchlist"
};

export type CatalystCalendar = {
  builtAt: string; // ISO
  windowDays: number;
  events: CatalystEvent[]; // sorted ascending by date
  sources: { earnings: number; econ: number; fomc: number };
  econStatus: "live" | "unavailable" | "not-configured";
};

/** Minimal shape we need off a stored stock. */
type StockLike = {
  ticker?: string;
  name?: string;
  bucket?: string;
  earningsDate?: string;
};

/**
 * The Fed's published 2026 FOMC meeting schedule — decision day (second day
 * of each two-day meeting). Publicly scheduled well in advance; UPDATE ANNUALLY.
 * Source: federalreserve.gov FOMC calendar.
 */
const FOMC_DECISION_DAYS_2026 = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
];

/**
 * FRED releases we surface, matched case-insensitively against the release
 * name. `high` = market-moving macro prints; `medium` = secondary.
 */
const ECON_RELEASE_MATCHERS: Array<{ match: string; title: string; importance: CatalystImportance }> = [
  { match: "consumer price index", title: "CPI", importance: "high" },
  { match: "employment situation", title: "Jobs report (NFP)", importance: "high" },
  { match: "gross domestic product", title: "GDP", importance: "high" },
  { match: "personal income", title: "PCE (Personal Income & Outlays)", importance: "high" },
  { match: "producer price index", title: "PPI", importance: "medium" },
  { match: "advance monthly sales for retail", title: "Retail sales", importance: "medium" },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive [today, today+windowDays] membership on a YYYY-MM-DD string. */
function withinWindow(dateStr: string, todayStr: string, endStr: string): boolean {
  return dateStr >= todayStr && dateStr <= endStr;
}

/** Earnings events from already-stored stock data. */
export function earningsEvents(stocks: StockLike[], todayStr: string, endStr: string): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const s of stocks) {
    const d = typeof s.earningsDate === "string" ? s.earningsDate.slice(0, 10) : "";
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!withinWindow(d, todayStr, endStr)) continue;
    const tk = (s.ticker || "").toUpperCase();
    if (!tk) continue;
    out.push({
      date: d,
      kind: "earnings",
      title: `${tk} earnings`,
      importance: s.bucket === "Portfolio" ? "high" : "medium",
      ticker: tk,
      bucket: s.bucket,
    });
  }
  return out;
}

/** FOMC decision days inside the window. */
export function fomcEvents(todayStr: string, endStr: string): CatalystEvent[] {
  return FOMC_DECISION_DAYS_2026.filter((d) => withinWindow(d, todayStr, endStr)).map((d) => ({
    date: d,
    kind: "fomc" as const,
    title: "FOMC decision",
    importance: "high" as const,
  }));
}

/**
 * FRED release-dates econ calendar. Returns [] (not throw) on any failure so
 * the calendar degrades to earnings + FOMC rather than breaking.
 */
export async function econEvents(
  todayStr: string,
  endStr: string,
): Promise<{ events: CatalystEvent[]; status: CatalystCalendar["econStatus"] }> {
  const key = process.env.FRED_API_KEY;
  if (!key) return { events: [], status: "not-configured" };
  try {
    const url =
      `https://api.stlouisfed.org/fred/releases/dates?api_key=${key}&file_type=json` +
      `&realtime_start=${todayStr}&sort_order=asc&include_release_dates_with_no_data=true&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      log.warn("FRED releases/dates non-200:", res.status);
      return { events: [], status: "unavailable" };
    }
    const json = (await res.json()) as {
      release_dates?: Array<{ release_id?: number; release_name?: string; date?: string }>;
    };
    const rows = Array.isArray(json.release_dates) ? json.release_dates : [];
    const out: CatalystEvent[] = [];
    const seen = new Set<string>(); // dedupe title+date
    for (const r of rows) {
      const d = typeof r.date === "string" ? r.date.slice(0, 10) : "";
      const name = (r.release_name || "").toLowerCase();
      if (!d || !withinWindow(d, todayStr, endStr) || !name) continue;
      const matcher = ECON_RELEASE_MATCHERS.find((m) => name.includes(m.match));
      if (!matcher) continue;
      const dedupeKey = `${matcher.title}|${d}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ date: d, kind: "econ", title: matcher.title, importance: matcher.importance });
    }
    return { events: out, status: "live" };
  } catch (e) {
    log.warn("FRED releases/dates failed:", e instanceof Error ? e.message : e);
    return { events: [], status: "unavailable" };
  }
}

/**
 * Assemble the full calendar. `stocks` should be the portfolio + watchlist
 * (both live in pm:stocks). Sorted ascending; high-importance first within a
 * day so the reader sees the market-movers on top.
 */
export async function buildCatalystCalendar(
  stocks: StockLike[],
  windowDays = 14,
): Promise<CatalystCalendar> {
  const now = new Date();
  // Window anchored to the US-Eastern trading day, NOT UTC — a brief generated
  // in the evening (UTC already tomorrow) must still start the window at the
  // correct Eastern "today" so same-day events aren't dropped.
  const todayStr = easternToday(now);
  const endStr = isoDate(new Date(Date.parse(`${todayStr}T00:00:00Z`) + windowDays * 24 * 60 * 60 * 1000));

  const earnings = earningsEvents(stocks, todayStr, endStr);
  const fomc = fomcEvents(todayStr, endStr);
  const { events: econ, status: econStatus } = await econEvents(todayStr, endStr);

  const events = [...earnings, ...econ, ...fomc].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // high before medium within the same day
    if (a.importance !== b.importance) return a.importance === "high" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return {
    builtAt: now.toISOString(),
    windowDays,
    events,
    sources: { earnings: earnings.length, econ: econ.length, fomc: fomc.length },
    econStatus,
  };
}
