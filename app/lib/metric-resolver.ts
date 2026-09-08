/**
 * Server-side resolver for the kill-condition kinds that need data the client
 * doesn't hold:
 *
 *   - `metric`      → the newest FactSet Metrics Recap on file for the name
 *                     (pm:street-takeaways, kind "metrics"): results[] and
 *                     guidanceLines[], matched by label substring, number parsed
 *                     from the printed string.
 *   - `sia_floor`   → latest percentile from pm:sia-history (+ SMAX off the stock row)
 *   - `equate_rank` → the name's rank on the Research tab's Equate lists
 *   - `marketedge`  → opinion + power rating off the stock row
 *
 * Deterministic, read-only, zero tokens. Used by loadAlertInputs (nightly sweep
 * + thesis-watch) and by GET /api/thesis-signals (the stock-page tile).
 */

import { getRedis } from "./redis";
import { canonicalTicker, crossListingRoot } from "./ticker";
import type { KillCondition, KillSignals, MetricReading, MetricSpec } from "./kill-conditions";
import { loadStreetTakeaways, type StreetTakeaway, type StreetTakeawaysStore } from "./street-takeaways";
import { readSiaHistory, type SiaHistoryStore } from "./sia-history";

export type KillSignalExtras = Pick<
  KillSignals,
  "metricReadings" | "siaPercentile" | "siaSmax" | "equateRank" | "marketEdgeOpinion" | "marketEdgePower"
>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();

/** Does a printed label match a spec's `match`? Substring either way after
 *  normalisation, so "Data Center revenue" ↔ "data center rev" both hit. */
export function labelMatches(label: string, match: string): boolean {
  const a = norm(label);
  const b = norm(match);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // Every significant word of the spec appears in the label (order-free).
  const words = b.split(" ").filter((w) => w.length > 2 && !["the", "and", "vs", "yoy"].includes(w));
  return words.length > 0 && words.every((w) => a.includes(w));
}

/**
 * Parse the first number out of a printed figure. Handles "$41.1B", "73%",
 * "(2.1%)" / "-2.1%" (negatives), "$5.25B-$5.55B" (takes the midpoint), and
 * unicode minus. Returns null when nothing numeric is present.
 */
export function parseFigure(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.replace(/−/g, "-").replace(/,/g, "");
  const neg = /^\s*\(/.test(t) && /\)\s*$/.test(t);
  const nums = [...t.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  // A range like "$5.25B-$5.55B" parses as [5.25, -5.55] because of the dash;
  // treat two numbers with the second negative-by-dash as a range midpoint.
  let v: number;
  if (nums.length >= 2 && /\d\s*[-–]\s*\$?\d/.test(t)) v = (Math.abs(nums[0]) + Math.abs(nums[1])) / 2;
  else v = nums[0];
  if (neg && v > 0) v = -v;
  return v;
}

function readingFromRecap(spec: MetricSpec, recaps: StreetTakeaway[]): MetricReading | null {
  for (const t of recaps) {
    if (spec.source === "results") {
      for (const r of t.results ?? []) {
        if (!labelMatches(r.label, spec.match)) continue;
        const src = spec.field === "yoy" ? r.yoy : r.actual;
        const v = parseFigure(src);
        if (v == null) continue;
        const display = `${r.label}: ${r.actual ?? "—"}${r.consensus ? ` vs cons ${r.consensus}` : ""}${r.yoy ? ` (${r.yoy} YoY)` : ""}`;
        return { value: v, display, asOf: t.date, event: t.event };
      }
    } else {
      for (const g of t.guidanceLines ?? []) {
        if (!labelMatches(g.metric, spec.match)) continue;
        if (spec.period && !norm(g.period).includes(norm(spec.period))) continue;
        const v = parseFigure(g.value);
        if (v == null) continue;
        const display = `${g.period} ${g.metric} guide: ${g.value}${g.priorGuidance ? ` (prior ${g.priorGuidance})` : ""}${g.direction ? ` · ${g.direction}` : ""}`;
        return { value: v, display, asOf: t.date, event: t.event };
      }
    }
  }
  return null;
}

/** Newest-first Metrics Recap alerts for a ticker (cross-listing aware). */
function recapsFor(store: StreetTakeawaysStore, ticker: string): StreetTakeaway[] {
  const keys = [canonicalTicker(ticker).toUpperCase(), ticker.toUpperCase(), crossListingRoot(ticker).toUpperCase()];
  const seen = new Set<string>();
  const out: StreetTakeaway[] = [];
  for (const k of keys) {
    for (const t of store[k] ?? []) {
      if (t.kind !== "metrics" || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** The printed lines available to build `metric` conditions against — what the
 *  drafter is allowed to reference. Newest recap only. */
export function availableMetricLines(store: StreetTakeawaysStore, ticker: string): { results: string[]; guidance: string[]; asOf?: string; event?: string } {
  const [latest] = recapsFor(store, ticker);
  if (!latest) return { results: [], guidance: [] };
  return {
    asOf: latest.date,
    event: latest.event,
    results: (latest.results ?? []).map((r) => `${r.label}: ${r.actual ?? "—"}${r.consensus ? ` vs consensus ${r.consensus}` : ""}${r.yoy ? ` (${r.yoy} YoY)` : ""}`),
    guidance: (latest.guidanceLines ?? []).map((g) => `${g.period} ${g.metric}: ${g.value}${g.priorGuidance ? ` (prior ${g.priorGuidance})` : ""}${g.direction ? ` · ${g.direction}` : ""}`),
  };
}

type StockRow = { ticker?: string; sia?: number; marketEdge?: { opinion?: "long" | "neutral" | "avoid"; powerRating?: number } };
type ResearchLite = { equateCad?: Array<{ ticker?: string; equateRank?: number }>; equateUsd?: Array<{ ticker?: string; equateRank?: number }> };

/** All the Redis reads, once, for a batch of tickers. */
export async function loadKillSignalSources(): Promise<{
  takeaways: StreetTakeawaysStore;
  sia: SiaHistoryStore;
  stocks: StockRow[];
  research: ResearchLite;
}> {
  const redis = await getRedis();
  const [takeaways, sia, stocksRaw, researchRaw] = await Promise.all([
    loadStreetTakeaways().catch(() => ({}) as StreetTakeawaysStore),
    readSiaHistory(),
    redis.get("pm:stocks"),
    redis.get("pm:research"),
  ]);
  let stocks: StockRow[] = [];
  let research: ResearchLite = {};
  try { stocks = stocksRaw ? (JSON.parse(stocksRaw) as StockRow[]) : []; } catch { stocks = []; }
  try { research = researchRaw ? (JSON.parse(researchRaw) as ResearchLite) : {}; } catch { research = {}; }
  return { takeaways, sia, stocks, research };
}

/** Resolve every server-side signal for one ticker's conditions. Pure given the sources. */
export function killSignalExtrasFor(
  ticker: string,
  conditions: KillCondition[],
  src: Awaited<ReturnType<typeof loadKillSignalSources>>,
): KillSignalExtras {
  const tk = canonicalTicker(ticker).toUpperCase();
  const root = crossListingRoot(ticker).toUpperCase();

  // metric readings — only computed when the thesis has metric conditions.
  let metricReadings: Record<string, MetricReading | null> | undefined;
  const metricConds = conditions.filter((c) => c.kind === "metric" && c.metric);
  if (metricConds.length > 0) {
    const recaps = recapsFor(src.takeaways, ticker);
    metricReadings = {};
    for (const c of metricConds) {
      // Only mark "searched but not found" (null) when a recap exists at all;
      // otherwise leave the id out so the checker says "awaiting recap".
      if (recaps.length === 0) continue;
      metricReadings[c.id] = readingFromRecap(c.metric!, recaps);
    }
  }

  // SIA percentile: newest logged reading with a percentile.
  const siaEntries = src.sia[tk] ?? src.sia[root] ?? src.sia[`${root}.TO`] ?? [];
  const latestSia = [...siaEntries].filter((e) => typeof e.percentile === "number").sort((a, b) => b.date.localeCompare(a.date))[0];
  const stock = src.stocks.find((s) => s.ticker && (canonicalTicker(s.ticker).toUpperCase() === tk || crossListingRoot(s.ticker).toUpperCase() === root));

  // Equate rank: undefined when no Equate list is on file at all, null when
  // the sheet exists but the name isn't in the top-decile list.
  const lists = [...(src.research.equateCad ?? []), ...(src.research.equateUsd ?? [])];
  let equateRank: number | null | undefined = undefined;
  if (lists.length > 0) {
    const hit = lists.find((e) => e.ticker && (canonicalTicker(e.ticker).toUpperCase() === tk || crossListingRoot(e.ticker).toUpperCase() === root));
    equateRank = hit && typeof hit.equateRank === "number" ? hit.equateRank : null;
  }

  return {
    metricReadings,
    siaPercentile: latestSia?.percentile ?? null,
    siaSmax: typeof stock?.sia === "number" ? stock.sia : null,
    equateRank,
    marketEdgeOpinion: stock?.marketEdge?.opinion ?? null,
    marketEdgePower: typeof stock?.marketEdge?.powerRating === "number" ? stock.marketEdge.powerRating : null,
  };
}
