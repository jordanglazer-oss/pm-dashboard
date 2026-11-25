import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import type { PimModelData, PimModelGroup, PimPerformanceData, PimPortfolioState, PimProfileType } from "@/app/lib/pim-types";

/**
 * GET /api/admin/fund-distribution-audit
 *
 * READ-ONLY. Measures how much the RECORDED model performance is understated
 * because the daily performance job prices mutual funds on a plain NAV, which
 * falls by the amount of every distribution (found 2026-11-24).
 *
 * For every mutual fund (FUNDSERV code) in the PIM models:
 *   - its distributions, read off the same Globe / Barchart feed by comparing
 *     the plain NAV with the distribution-adjusted NAV day by day;
 *   - its year-to-date return both ways.
 * For every recorded series (group × profile):
 *   - each distribution that fell on a day the series was being tracked, times
 *     the fund's weight in that book = the return the record is missing.
 *
 * ESTIMATE, and labelled as one: weights are TODAY'S model target weights (the
 * record does not keep a fund's weight on each past day), and a fund is assumed
 * held from its first buy in the trade log (or from the start of tracking when
 * the log has no buy). Reads pm:pim-models, pm:pim-performance and
 * pm:pim-portfolio-state; writes nothing.
 */

const log = createLogger("Fund-distribution-audit");
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isFund = (s: string) => /^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(s);
const bare = (s: string) => s.replace(/-T$/i, "").toUpperCase();

async function navSeries(code: string, adjusted: boolean): Promise<Map<string, number>> {
  const q = adjusted ? "dividends=true&backadjust=true" : "dividends=false&backadjust=false";
  const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(`${code}.CF`)}&data=daily&maxrecords=1300&volume=contract&order=asc&${q}`;
  const out = new Map<string, number>();
  try {
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.theglobeandmail.com/" } });
    if (!res.ok) return out;
    for (const line of (await res.text()).trim().split("\n")) {
      const p = line.split(",");
      const v = parseFloat(p[5]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(p[1] ?? "") && Number.isFinite(v) && v > 0) out.set(p[1], v);
    }
  } catch {
    /* an empty series is reported as "no data" */
  }
  return out;
}

type Dist = { date: string; pct: number };

/** Distribution dates = days the adjusted ÷ plain NAV ratio steps. pct = share of NAV paid out. */
function distributions(raw: Map<string, number>, adj: Map<string, number>): Dist[] {
  const out: Dist[] = [];
  let prev: number | null = null;
  for (const [d, r] of raw) {
    const a = adj.get(d);
    if (a == null) continue;
    const ratio = a / r;
    if (prev != null && Math.abs(ratio / prev - 1) > 0.0005) out.push({ date: d, pct: +((ratio / prev - 1) * 100).toFixed(3) });
    prev = ratio;
  }
  return out;
}

function ytd(m: Map<string, number>, year: string): number | null {
  let base: number | null = null, last: number | null = null;
  for (const [d, v] of m) {
    if (d < `${year}-01-01`) base = v;
    last = v;
  }
  return base && last ? +((last / base - 1) * 100).toFixed(2) : null;
}

const BOOKS: PimProfileType[] = ["conservative", "balanced", "growth", "allEquity", "core", "thematic", "alpha", "stocks"];

/** A fund's share of a book at TODAY'S model targets (0 when the book does not hold it). */
function weightIn(group: PimModelGroup, symbol: string, book: PimProfileType): number {
  const h = group.holdings.find((x) => bare(x.symbol) === bare(symbol));
  if (!h) return 0;
  const mix = group.profiles[book as "balanced"];
  if (book === "conservative" || book === "balanced" || book === "growth" || book === "allEquity") {
    if (!mix) return 0;
    const alloc = h.assetClass === "equity" ? mix.equity : h.assetClass === "fixedIncome" ? mix.fixedIncome : mix.alternatives;
    return h.weightInClass * alloc;
  }
  if (h.assetClass !== "equity") return 0;
  const bucket = h.bucket ?? "thematic"; // an equity mutual fund with no bucket on file is a Managed Alpha fund
  const eq = group.holdings.filter((x) => x.assetClass === "equity");
  const bucketOf = (x: (typeof eq)[number]) => x.bucket ?? (isFund(x.symbol) ? "thematic" : undefined);
  const sum = (f: (x: (typeof eq)[number]) => boolean) => eq.filter(f).reduce((a, x) => a + x.weightInClass, 0);
  if (book === "core") return bucket === "core" ? h.weightInClass / (sum((x) => bucketOf(x) === "core") || 1) : 0;
  if (book === "thematic") return bucket === "thematic" ? h.weightInClass / (sum((x) => bucketOf(x) === "thematic") || 1) : 0;
  if (book === "alpha") return bucket !== "core" ? h.weightInClass / (sum((x) => bucketOf(x) !== "core") || 1) : 0;
  return 0; // stocks book holds no funds
}

export async function GET() {
  try {
    const redis = await getRedis();
    const [mRaw, pRaw, sRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:pim-performance"), redis.get("pm:pim-portfolio-state")]);
    if (!mRaw) return NextResponse.json({ error: "No models on file" }, { status: 404 });
    const models = JSON.parse(mRaw) as PimModelData;
    const perf = pRaw ? (JSON.parse(pRaw) as PimPerformanceData) : null;
    const state = sRaw ? (JSON.parse(sRaw) as PimPortfolioState) : null;
    const year = new Date().toISOString().slice(0, 4);

    const codes = [...new Set(models.groups.flatMap((g) => g.holdings.filter((h) => isFund(h.symbol)).map((h) => bare(h.symbol))))];
    const funds: Record<string, { name: string; dists: Dist[]; ytdPlain: number | null; ytdWithDistributions: number | null; navFrom: string | null; navTo: string | null }> = {};
    await Promise.all(
      codes.map(async (code) => {
        const [raw, adj] = await Promise.all([navSeries(code, false), navSeries(code, true)]);
        const dates = [...raw.keys()];
        const name = models.groups.flatMap((g) => g.holdings).find((h) => bare(h.symbol) === code)?.name ?? code;
        funds[code] = { name, dists: distributions(raw, adj), ytdPlain: ytd(raw, year), ytdWithDistributions: ytd(adj, year), navFrom: dates[0] ?? null, navTo: dates[dates.length - 1] ?? null };
      }),
    );

    const books: unknown[] = [];
    for (const g of models.groups) {
      const gs = state?.groupStates.find((x) => x.groupId === g.id);
      const trackingStart = gs?.trackingStart?.date?.slice(0, 10) ?? null;
      const firstTrade = (gs?.transactions ?? []).map((t) => t.date.slice(0, 10)).sort()[0] ?? null;
      for (const book of BOOKS) {
        const series = perf?.models.find((m) => m.groupId === g.id && m.profile === book);
        if (!series?.history?.length) continue;
        const hist = [...series.history].sort((a, b) => a.date.localeCompare(b.date));
        const first = hist[0].date, last = hist[hist.length - 1].date;
        const recorded = new Map(hist.map((h) => [h.date, h]));
        // The daily job only computes days from when tracking began; earlier history was imported.
        const engineFrom = [first, trackingStart, firstTrade].filter((d): d is string => Boolean(d)).sort().pop() as string;
        const base = hist.filter((h) => h.date < `${year}-01-01`).pop();
        const recordedYtd = base ? +((hist[hist.length - 1].value / base.value - 1) * 100).toFixed(2) : null;

        const events: { date: string; fund: string; distributionPct: number; weightPct: number; missingPts: number; recordedDayReturnPct: number | null; counted: boolean; why?: string }[] = [];
        for (const code of codes) {
          const w = weightIn(g, code, book);
          if (w <= 0) continue;
          const buy = (gs?.transactions ?? []).filter((t) => bare(t.symbol) === code && t.direction === "buy").map((t) => t.date.slice(0, 10)).sort()[0] ?? null;
          for (const d of funds[code].dists) {
            if (d.date < first || d.date > last) continue;
            const beforeEngine = d.date < engineFrom;
            const beforeBuy = buy != null && d.date < buy;
            const counted = !beforeEngine && !beforeBuy;
            events.push({
              date: d.date, fund: code, distributionPct: d.pct, weightPct: +(w * 100).toFixed(2), missingPts: +(w * d.pct).toFixed(3),
              recordedDayReturnPct: recorded.get(d.date)?.dailyReturn ?? null, counted,
              ...(counted ? {} : { why: beforeBuy ? `before the first buy on file (${buy})` : `before daily tracking began (${engineFrom}) — that history was imported, not computed` }),
            });
          }
        }
        events.sort((a, b) => a.date.localeCompare(b.date));
        const sum = (f: (e: (typeof events)[number]) => boolean) => +events.filter((e) => e.counted && f(e)).reduce((a, e) => a + e.missingPts, 0).toFixed(2);
        const missingYtd = sum((e) => e.date >= `${year}-01-01`);
        books.push({
          group: g.id, book, seriesFrom: first, seriesTo: last, dailyTrackingFrom: engineFrom,
          recordedYtdPct: recordedYtd,
          estimatedMissingYtdPts: missingYtd,
          estimatedCorrectedYtdPct: recordedYtd == null ? null : +(((1 + recordedYtd / 100) * (1 + missingYtd / 100) - 1) * 100).toFixed(2),
          estimatedMissingSinceTrackingPts: sum(() => true),
          distributionsCounted: events.filter((e) => e.counted).length,
          distributionsNotCounted: events.filter((e) => !e.counted).length,
          events,
        });
      }
    }

    return NextResponse.json({
      readOnly: true,
      generatedAt: new Date().toISOString(),
      method: [
        "Distributions are read off the fund price feed: the days the distribution-adjusted NAV and the plain NAV diverge.",
        "Missing return on a distribution day = the fund's weight in that book × the distribution (% of NAV).",
        "Weights are TODAY'S model target weights — an estimate; the record does not keep past weights.",
        "A distribution is counted only on days the daily job computed (after tracking began) and after the fund's first buy on file.",
        "recordedDayReturnPct is what the record shows for that day: a fall of about the 'missing' size, not explained by markets, is the false loss.",
      ],
      funds,
      books,
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
