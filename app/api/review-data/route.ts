import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { fetchCloses, SECTOR_ETFS } from "@/app/lib/journal-attribution";
import { VERDICT_LOG_KEY, type VerdictLog } from "@/app/lib/thesis-verdict";
import { nextFirstMonday } from "@/app/lib/tactical-plan";
import type { PimPerformanceData } from "@/app/lib/pim-types";

/**
 * GET /api/review-data?group=pim&profile=balanced — everything the monthly
 * review / daily hub needs that the client cannot compute from context:
 *   returns   1M price return per held name, its sector ETF's, and SPY's
 *             (Yahoo, cached 6h in pm:review-returns — regenerable)
 *   model     month-to-date and 1M return of the requested model series
 *             (pm:pim-performance, read-only)
 *   since     what changed since the last first-Monday meeting: verdict-log
 *             rows, tripped kill conditions, plan flags, re-underwrites due
 * Read-only against everything but its own cache. Zero model spend.
 */

const log = createLogger("Review-data");
const CACHE_KEY = "pm:review-returns";
const CACHE_MS = 6 * 60 * 60 * 1000;

type ReturnRow = { r1m: number | null; sectorEtf: string | null; sector1m: number | null };
type ReturnsCache = { computedAt: string; spy1m: number | null; rows: Record<string, ReturnRow> };

function ret1m(closes: Map<string, number> | null): number | null {
  if (!closes || closes.size < 15) return null;
  const dates = [...closes.keys()].sort();
  const last = dates[dates.length - 1];
  const target = new Date(`${last}T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() - 1);
  const t = target.toISOString().slice(0, 10);
  let base: string | null = null;
  for (const d of dates) { if (d <= t) base = d; else break; }
  if (!base) return null;
  const a = closes.get(base)!;
  const b = closes.get(last)!;
  return a > 0 ? b / a - 1 : null;
}

/** First Monday of the current month if it has passed, else of last month. */
function lastMeetingDate(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const thisMonth = nextFirstMonday(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10));
  if (thisMonth <= today) return thisMonth;
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return nextFirstMonday(prev.toISOString().slice(0, 10));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const groupId = url.searchParams.get("group") || "pim";
  const profile = url.searchParams.get("profile") || "balanced";
  const force = url.searchParams.get("refresh") === "1";
  const today = new Date().toISOString().slice(0, 10);
  try {
    const redis = await getRedis();
    const [{ context, killWatch, tacticalWatch, thesisVerdicts }, perfRaw, logRaw, cacheRaw] = await Promise.all([
      loadAlertInputs(),
      redis.get("pm:pim-performance"),
      redis.get(VERDICT_LOG_KEY),
      redis.get(CACHE_KEY),
    ]);

    // ── Returns (cached) ──
    const held = Object.entries(context).filter(([, c]) => c.bucket === "Portfolio");
    let cache: ReturnsCache | null = null;
    try { cache = cacheRaw ? (JSON.parse(cacheRaw) as ReturnsCache) : null; } catch { cache = null; }
    const stale = !cache || Date.now() - Date.parse(cache.computedAt) > CACHE_MS || held.some(([tk]) => !(tk in cache!.rows));
    if (stale || force) {
      const etfs = new Set<string>(["SPY"]);
      for (const [, c] of held) { const e = c.sector ? SECTOR_ETFS[c.sector] : undefined; if (e) etfs.add(e); }
      const etfCloses = new Map<string, number | null>();
      await Promise.all([...etfs].map(async (e) => etfCloses.set(e, ret1m(await fetchCloses(e)))));
      const rows: Record<string, ReturnRow> = {};
      // Bounded concurrency: a dozen at a time keeps Yahoo happy.
      const list = held.map(([tk, c]) => ({ tk, sector: c.sector ?? null }));
      for (let i = 0; i < list.length; i += 12) {
        await Promise.all(list.slice(i, i + 12).map(async ({ tk, sector }) => {
          const etf = sector ? SECTOR_ETFS[sector] ?? null : null;
          rows[tk] = { r1m: ret1m(await fetchCloses(tk)), sectorEtf: etf, sector1m: etf ? etfCloses.get(etf) ?? null : null };
        }));
      }
      cache = { computedAt: new Date().toISOString(), spy1m: etfCloses.get("SPY") ?? null, rows };
      await redis.set(CACHE_KEY, JSON.stringify(cache)).catch(() => {});
    }

    // ── Model return (MTD + 1M) from the performance ledger ──
    let model: { mtd: number | null; r1m: number | null; asOf: string | null } = { mtd: null, r1m: null, asOf: null };
    try {
      const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
      const series = perf?.models.find((m) => m.groupId === groupId && m.profile === profile)?.history ?? [];
      if (series.length > 1) {
        const last = series[series.length - 1];
        const monthStart = last.date.slice(0, 7);
        const prevMonthEnd = [...series].reverse().find((r) => r.date.slice(0, 7) < monthStart);
        const d = new Date(`${last.date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
        const t = d.toISOString().slice(0, 10);
        const base1m = [...series].reverse().find((r) => r.date <= t);
        model = {
          mtd: prevMonthEnd && prevMonthEnd.value > 0 ? last.value / prevMonthEnd.value - 1 : null,
          r1m: base1m && base1m.value > 0 ? last.value / base1m.value - 1 : null,
          asOf: last.date,
        };
      }
    } catch { /* ledger unreadable → nulls */ }

    // ── Since the last meeting ──
    const since = lastMeetingDate(today);
    let verdictLog: VerdictLog = {};
    try { verdictLog = logRaw ? (JSON.parse(logRaw) as VerdictLog) : {}; } catch { verdictLog = {}; }
    const verdictChanges = Object.entries(verdictLog).flatMap(([tk, rows]) => {
      const inWindow = rows.filter((r) => r.date >= since);
      if (!inWindow.length) return [];
      const before = [...rows].reverse().find((r) => r.date < since)?.verdict ?? null;
      const latest = inWindow[inWindow.length - 1];
      if (latest.verdict === before) return [];
      return [{ ticker: tk, from: before, to: latest.verdict, date: latest.date, summary: latest.summary }];
    });
    const trips = killWatch.filter((k) => k.tripped > 0).map((k) => ({ ticker: k.ticker, tripped: k.tripped, auto: k.auto, what: k.checks.filter((c) => c.status === "tripped").map((c) => `${c.condition.theme ?? c.condition.kind}: ${c.reading}`) }));
    const reUnderwriteDue = killWatch.filter((k) => k.reUnderwriteBy && k.reUnderwriteBy <= today).map((k) => ({ ticker: k.ticker, due: k.reUnderwriteBy! }));
    const planFlags = tacticalWatch.filter((t) => t.flags.length).map((t) => ({ ticker: t.ticker, flags: t.flags.map((f) => f.text), severity: t.flags.some((f) => f.severity === "high") ? "high" : "medium" }));
    const verdictNow = Object.fromEntries(thesisVerdicts.map((v) => [v.ticker, v.verdict]));

    return NextResponse.json({
      today,
      lastMeeting: since,
      nextMeeting: nextFirstMonday(today),
      returns: cache ? { computedAt: cache.computedAt, spy1m: cache.spy1m, rows: cache.rows } : { computedAt: null, spy1m: null, rows: {} },
      model,
      since: { verdictChanges, trips, reUnderwriteDue, planFlags, verdictNow },
      sleeves: Object.fromEntries(held.map(([tk, c]) => [tk, c.sleeves ?? null])),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "review data failed" }, { status: 500 });
  }
}
