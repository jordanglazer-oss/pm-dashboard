/**
 * Score-calibration engine — does the composite score actually predict
 * forward returns?
 *
 * Joins every entry in pm:score-history (the score a name carried on a given
 * date) to its REALIZED forward return over a horizon, then groups by rating
 * bucket. If higher-scored names returned more, the score discriminates; if
 * the buckets are flat, it doesn't. A per-category breakdown shows which
 * inputs (Technicals? MarketEdge? Fundamental?) carry the signal.
 *
 * Pure functions: prices are passed in as date→close maps so this stays
 * testable and the route owns the Yahoo I/O. Returns are benchmark-relative
 * (excess vs the index) as well as absolute, since alpha is what matters.
 *
 * Honesty: forward returns only exist for entries old enough that the horizon
 * has fully elapsed, and score-history is young — so `n` (sample size) is
 * reported everywhere and early results are noisy by construction.
 */

import type { ScoreHistoryStore, ScoreHistoryEntry } from "@/app/api/kv/score-history/route";
import type { ScoreKey } from "./types";
import { SCORE_GROUPS } from "./types";

/**
 * Keys that are part of the CURRENT scoring schema. pm:score-history is an
 * append-only ledger, so entries logged before a category was renamed/removed
 * (e.g. the retired "externalSources") still carry the old key. We derive the
 * valid set from SCORE_GROUPS so retired keys never surface in the calibration
 * — the per-category signal must reflect categories the score still uses.
 */
const VALID_SCORE_KEYS = new Set<ScoreKey>(
  SCORE_GROUPS.flatMap((g) => g.categories.map((c) => c.key as ScoreKey)),
);

export type PriceMap = Record<string, number>; // dateISO(YYYY-MM-DD) → close

/** Finer rating buckets (match the chart). */
export type Bucket = "Sell" | "Hold" | "Moderate Buy" | "Strong Buy";
const BUCKET_ORDER: Bucket[] = ["Sell", "Hold", "Moderate Buy", "Strong Buy"];

function bucketFor(adjusted: number): Bucket {
  if (adjusted >= 30) return "Strong Buy";
  if (adjusted >= 26) return "Moderate Buy";
  if (adjusted <= 18) return "Sell";
  return "Hold"; // 18 < x < 26
}

/** Close on-or-before `dateISO`, scanning back up to `slack` days for a
 *  trading day. null if none found. */
function priceOnOrBefore(map: PriceMap, dateISO: string, slack = 7): number | null {
  const d = new Date(`${dateISO}T00:00:00Z`);
  for (let i = 0; i <= slack; i++) {
    const key = new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10);
    const v = map[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

function addDaysIso(dateISO: string, days: number): string {
  return new Date(new Date(`${dateISO}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

export type BucketStat = {
  bucket: Bucket;
  n: number;
  avgReturn: number;   // absolute %, mean
  avgExcess: number;   // vs benchmark, %, mean
  hitRate: number;     // % of obs that beat the benchmark
};

export type CategorySignal = {
  key: ScoreKey;
  label: string;
  n: number;
  /** avg forward return of above-median category scores minus below-median.
   *  Positive ⇒ a higher score in this category predicts higher return. */
  spread: number;
  /** Rank information coefficient: Spearman correlation between the category
   *  score and forward EXCESS return across observations. The standard factor
   *  measure of predictive power — |IC| ≥ 0.05 is meaningful, ≥ 0.10 strong.
   *  Null when too few observations (< 10) to be worth reading. */
  ic: number | null;
};

/** Per-rubric-era slice of the observation set. The rubric changed materially
 *  at each RUBRIC_REV bump (and pm:score-history stamps rev on append), so
 *  pooling eras averages different scoring systems — these slices keep the
 *  pooled numbers honest by showing how much of each era they contain and
 *  whether the eras' headline discrimination diverges. */
export type EraStat = {
  /** rubricRev of the entries in this slice; null = pre-stamp (pre-band) era. */
  rev: number | null;
  label: string;
  n: number;
  buyHitRate: number | null;
  buyMinusSell: number | null;
};

export type CalibrationResult = {
  horizonDays: number;
  totalObservations: number;
  buckets: BucketStat[];
  categories: CategorySignal[];
  /** Observation mix by rubric era — absent on results cached before this
   *  field existed. When more than one era is present, the pooled bucket /
   *  category numbers mix scoring regimes and should be read with that
   *  caveat (the UI surfaces it). */
  eras?: EraStat[];
  /** Pearson correlation between category sub-scores across observations —
   *  the redundancy test for the reviewer's "one factor wearing four hats"
   *  claim. Optional so cached results computed before this field parse. */
  categoryCorr?: { keys: ScoreKey[]; labels: string[]; matrix: (number | null)[][] };
  headline: {
    buyHitRate: number | null;   // % of Buy-tier obs that beat the index
    strongBuyAvg: number | null;
    sellAvg: number | null;
    buyMinusSell: number | null; // discrimination spread (excess)
  };
};

type Obs = { bucket: Bucket; ret: number; excess: number; scores: Partial<Record<ScoreKey, number>>; rev: number | null };

const CATEGORY_LABELS: Partial<Record<ScoreKey, string>> = {
  marketEdge: "MarketEdge", relativeStrength: "SIA", aiRating: "BoostedAI",
  charting: "Technicals", analystConsensus: "Analyst consensus",
  researchMentions: "Research mentions", growth: "Growth",
  relativeValuation: "Rel. valuation", cashFlowQuality: "Cash-flow quality",
  leverageCoverage: "Leverage", brand: "Brand", secular: "Secular",
};
function catLabel(k: ScoreKey): string {
  return CATEGORY_LABELS[k] ?? String(k).replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Average ranks (1-based), ties get the mean of their positions. */
function avgRanks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2 + 1; // average of 1-based positions i+1..j+1
    for (let k = i; k <= j; k++) out[idx[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (Pearson on average ranks). Null when degenerate
 *  (constant series — e.g. every observation has the same category score). */
function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = avgRanks(a);
  const rb = avgRanks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    const xa = ra[i] - ma;
    const xb = rb[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

export function computeCalibration(args: {
  scoreHistory: ScoreHistoryStore;
  prices: Record<string, PriceMap>; // ticker(UPPER) → date→close
  benchmark: PriceMap;
  horizonDays: number;
  nowMs: number;
}): CalibrationResult {
  const { scoreHistory, prices, benchmark, horizonDays, nowMs } = args;
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  const obs: Obs[] = [];

  for (const [tickerRaw, entriesRaw] of Object.entries(scoreHistory)) {
    const ticker = tickerRaw.toUpperCase();
    const pmap = prices[ticker];
    if (!pmap) continue;
    const entries = (entriesRaw as ScoreHistoryEntry[]).filter((e) => e && typeof e.adjusted === "number" && e.date);
    for (const e of entries) {
      const endIso = addDaysIso(e.date, horizonDays);
      if (endIso > todayIso) continue; // horizon hasn't elapsed yet
      const p0 = priceOnOrBefore(pmap, e.date);
      const p1 = priceOnOrBefore(pmap, endIso);
      if (p0 == null || p1 == null) continue;
      const ret = ((p1 - p0) / p0) * 100;

      const b0 = priceOnOrBefore(benchmark, e.date);
      const b1 = priceOnOrBefore(benchmark, endIso);
      const benchRet = b0 != null && b1 != null ? ((b1 - b0) / b0) * 100 : 0;

      obs.push({ bucket: bucketFor(e.adjusted), ret, excess: ret - benchRet, scores: e.scores, rev: typeof e.rubricRev === "number" ? e.rubricRev : null });
    }
  }

  // Per-bucket aggregates.
  const buckets: BucketStat[] = BUCKET_ORDER.map((bk) => {
    const rows = obs.filter((o) => o.bucket === bk);
    return {
      bucket: bk,
      n: rows.length,
      avgReturn: Number(mean(rows.map((r) => r.ret)).toFixed(2)),
      avgExcess: Number(mean(rows.map((r) => r.excess)).toFixed(2)),
      hitRate: rows.length ? Math.round((rows.filter((r) => r.excess > 0).length / rows.length) * 100) : 0,
    };
  });

  // Per-category signal: above-median vs below-median category score → return spread.
  const allKeys = new Set<ScoreKey>();
  for (const o of obs) for (const k of Object.keys(o.scores)) allKeys.add(k as ScoreKey);
  const categories: CategorySignal[] = [];
  for (const k of allKeys) {
    if (!VALID_SCORE_KEYS.has(k)) continue; // skip retired keys (e.g. externalSources)
    const withK = obs.filter((o) => typeof o.scores[k] === "number");
    if (withK.length < 8) continue; // too thin to say anything
    const vals = withK.map((o) => o.scores[k] as number).slice().sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    const hi = withK.filter((o) => (o.scores[k] as number) > median).map((o) => o.ret);
    const lo = withK.filter((o) => (o.scores[k] as number) <= median).map((o) => o.ret);
    if (hi.length < 3 || lo.length < 3) continue;
    // Rank IC vs EXCESS return (benchmark-adjusted, so a bull tape doesn't
    // make every category look predictive). Null under 10 obs — too noisy.
    const icRaw =
      withK.length >= 10
        ? spearman(withK.map((o) => o.scores[k] as number), withK.map((o) => o.excess))
        : null;
    categories.push({
      key: k,
      label: catLabel(k),
      n: withK.length,
      spread: Number((mean(hi) - mean(lo)).toFixed(2)),
      ic: icRaw == null ? null : Number(icRaw.toFixed(2)),
    });
  }
  categories.sort((a, b) => (b.ic ?? -1) - (a.ic ?? -1) || b.spread - a.spread);

  // Headline.
  const buyObs = obs.filter((o) => o.bucket === "Strong Buy" || o.bucket === "Moderate Buy");
  const sellObs = obs.filter((o) => o.bucket === "Sell");
  const strongBuy = buckets.find((b) => b.bucket === "Strong Buy")!;
  const sell = buckets.find((b) => b.bucket === "Sell")!;
  const headline = {
    buyHitRate: buyObs.length ? Math.round((buyObs.filter((o) => o.excess > 0).length / buyObs.length) * 100) : null,
    strongBuyAvg: strongBuy.n ? strongBuy.avgReturn : null,
    sellAvg: sell.n ? sell.avgReturn : null,
    buyMinusSell: buyObs.length && sellObs.length ? Number((mean(buyObs.map((o) => o.excess)) - mean(sellObs.map((o) => o.excess))).toFixed(2)) : null,
  };

  // ── Inter-category correlation (the redundancy test) ──
  // If the price-derived categories correlate highly, they are one signal
  // counted several times — a name with strong price action earns an unearned
  // multiple boost. Cells with fewer than 10 paired observations are null.
  const corrKeys = Array.from(allKeys).filter((k) => VALID_SCORE_KEYS.has(k)).sort();
  const pearson = (a: number[], b: number[]): number | null => {
    const n = a.length;
    if (n < 10) return null;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da === 0 || db === 0 ? null : Math.round((num / Math.sqrt(da * db)) * 100) / 100;
  };
  const matrix: (number | null)[][] = corrKeys.map((a) =>
    corrKeys.map((b) => {
      if (a === b) return 1;
      const pairs = obs.filter((o) => typeof o.scores[a] === "number" && typeof o.scores[b] === "number");
      return pearson(pairs.map((o) => o.scores[a] as number), pairs.map((o) => o.scores[b] as number));
    }),
  );
  const categoryCorr = { keys: corrKeys, labels: corrKeys.map(catLabel), matrix };

  // ── Era slices ── observation mix + headline discrimination per rubricRev,
  // so pooled numbers can't silently average different scoring systems.
  const revsPresent = Array.from(new Set(obs.map((o) => o.rev))).sort((a, b) => (a ?? 0) - (b ?? 0));
  const eras: EraStat[] = revsPresent.map((rev) => {
    const rows = obs.filter((o) => o.rev === rev);
    const buy = rows.filter((o) => o.bucket === "Strong Buy" || o.bucket === "Moderate Buy");
    const sellRows = rows.filter((o) => o.bucket === "Sell");
    return {
      rev,
      label: rev == null ? "pre-band" : `rev ${rev}`,
      n: rows.length,
      buyHitRate: buy.length ? Math.round((buy.filter((o) => o.excess > 0).length / buy.length) * 100) : null,
      buyMinusSell:
        buy.length && sellRows.length
          ? Number((mean(buy.map((o) => o.excess)) - mean(sellRows.map((o) => o.excess))).toFixed(2))
          : null,
    };
  });

  return { horizonDays, totalObservations: obs.length, buckets, categories, headline, categoryCorr, eras };
}
