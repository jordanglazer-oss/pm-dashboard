/**
 * Performance section of the daily summary — READ-ONLY over
 * pm:pim-performance (+ pm:pim-portfolio-state for the rebalance anchor).
 *
 * Answers the first question on the summary page: is the alpha sleeve adding
 * to or detracting from the core sleeve, and is that improving or fading?
 * Both sleeves are firm-wide standalone series under groupId "pim"
 * (profiles "alpha" / "core", built by /api/update-daily-value), so the spread
 * is a like-for-like equity-vs-equity comparison in CAD.
 */

import { getRedis } from "@/app/lib/redis";
import { pimModelSeed } from "@/app/lib/pim-seed";
import type { PimPerformanceData, PimPortfolioState, PimProfileType } from "@/app/lib/pim-types";
import { fetchYahooDaily } from "./yahoo";
import {
  type PeriodReturns,
  type ValuePoint,
  diffReturns,
  emptyReturns,
  normalizeSeries,
  periodReturns,
  returnSince,
} from "./periods";

export type AlphaCoreRead = {
  available: boolean;
  asOf: string | null;
  alpha: PeriodReturns;
  core: PeriodReturns;
  spread: PeriodReturns; // alpha − core, percentage points
  /** 1-month spread now vs the same reading five sessions earlier. */
  momentum: { current: number | null; prior: number | null; direction: "improving" | "fading" | "steady" | null };
  /** Alpha ÷ core, rebased to 100 sixty sessions back — the relative-strength line. */
  spark: { date: string; value: number }[];
  sinceRebalance: { date: string | null; alpha: number | null; core: number | null };
};

export type ModelReturnRow = {
  groupId: string;
  groupName: string;
  profile: PimProfileType;
  asOf: string | null;
  returns: PeriodReturns;
};

export type BenchmarkRow = {
  key: "sp500" | "tsx" | "usdcad";
  label: string;
  asOf: string | null;
  returns: PeriodReturns;
};

export type PerformanceSection = {
  alphaCore: AlphaCoreRead;
  models: ModelReturnRow[];
  benchmarks: BenchmarkRow[];
};

const PROFILE_ORDER: PimProfileType[] = ["conservative", "balanced", "growth", "allEquity"];

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function seriesFor(perf: PimPerformanceData | null, groupId: string, profile: PimProfileType): ValuePoint[] {
  const m = perf?.models?.find((x) => x.groupId === groupId && x.profile === profile);
  return m ? normalizeSeries(m.history ?? []) : [];
}

export async function buildPerformanceSection(): Promise<PerformanceSection> {
  const [perf, state, spx, tsx, usdcad] = await Promise.all([
    readJson<PimPerformanceData>("pm:pim-performance"),
    readJson<PimPortfolioState>("pm:pim-portfolio-state"),
    fetchYahooDaily("^GSPC", "1y"),
    fetchYahooDaily("^GSPTSE", "1y"),
    fetchYahooDaily("USDCAD=X", "1y"),
  ]);

  // ── Alpha vs core ──
  const alpha = seriesFor(perf, "pim", "alpha");
  const core = seriesFor(perf, "pim", "core");
  const available = alpha.length > 1 && core.length > 1;
  const alphaR = available ? periodReturns(alpha) : emptyReturns();
  const coreR = available ? periodReturns(core) : emptyReturns();
  const spread = diffReturns(alphaR, coreR);

  let momentum: AlphaCoreRead["momentum"] = { current: spread["1m"], prior: null, direction: null };
  if (available && alpha.length > 27 && core.length > 27) {
    const a5 = periodReturns(alpha, alpha.length - 6)["1m"];
    const c5 = periodReturns(core, core.length - 6)["1m"];
    const prior = a5 == null || c5 == null ? null : parseFloat((a5 - c5).toFixed(2));
    const current = spread["1m"];
    let direction: AlphaCoreRead["momentum"]["direction"] = null;
    if (current != null && prior != null) {
      const d = current - prior;
      direction = d > 0.25 ? "improving" : d < -0.25 ? "fading" : "steady";
    }
    momentum = { current, prior, direction };
  }

  // Relative line: alpha/core rebased over the last 60 sessions.
  const spark: AlphaCoreRead["spark"] = [];
  if (available) {
    const coreByDate = new Map(core.map((p) => [p.date, p.value]));
    const joined = alpha
      .filter((p) => coreByDate.has(p.date))
      .map((p) => ({ date: p.date, value: p.value / (coreByDate.get(p.date) as number) }));
    const tail = joined.slice(-60);
    if (tail.length > 1) {
      const base = tail[0].value;
      for (const p of tail) spark.push({ date: p.date, value: parseFloat(((p.value / base) * 100).toFixed(3)) });
    }
  }

  const rebalanceDate = state?.groupStates?.find((g) => g.groupId === "pim")?.lastRebalance?.date ?? null;
  const sinceRebalance = {
    date: rebalanceDate ? rebalanceDate.slice(0, 10) : null,
    alpha: rebalanceDate && available ? returnSince(alpha, rebalanceDate.slice(0, 10)) : null,
    core: rebalanceDate && available ? returnSince(core, rebalanceDate.slice(0, 10)) : null,
  };

  const alphaCore: AlphaCoreRead = {
    available,
    asOf: available ? alpha[alpha.length - 1].date : null,
    alpha: alphaR,
    core: coreR,
    spread,
    momentum,
    spark,
    sinceRebalance,
  };

  // ── Every model (group × client profile) ──
  const models: ModelReturnRow[] = [];
  const groupName = new Map(pimModelSeed.map((g) => [g.id, g.name]));
  for (const g of pimModelSeed) {
    for (const profile of PROFILE_ORDER) {
      if (!g.profiles[profile]) continue;
      const s = seriesFor(perf, g.id, profile);
      if (s.length < 2) continue;
      models.push({
        groupId: g.id,
        groupName: groupName.get(g.id) ?? g.id,
        profile,
        asOf: s[s.length - 1].date,
        returns: periodReturns(s),
      });
    }
  }
  // Groups that exist in the data but not in the seed (defensive).
  for (const m of perf?.models ?? []) {
    if (groupName.has(m.groupId) || !PROFILE_ORDER.includes(m.profile)) continue;
    const s = normalizeSeries(m.history ?? []);
    if (s.length < 2) continue;
    models.push({ groupId: m.groupId, groupName: m.groupId, profile: m.profile, asOf: s[s.length - 1].date, returns: periodReturns(s) });
  }

  const benchmarks: BenchmarkRow[] = [
    { key: "sp500", label: "S&P 500 (USD)", asOf: spx.length ? spx[spx.length - 1].date : null, returns: spx.length > 1 ? periodReturns(spx) : emptyReturns() },
    { key: "tsx", label: "S&P/TSX (CAD)", asOf: tsx.length ? tsx[tsx.length - 1].date : null, returns: tsx.length > 1 ? periodReturns(tsx) : emptyReturns() },
    { key: "usdcad", label: "USD/CAD", asOf: usdcad.length ? usdcad[usdcad.length - 1].date : null, returns: usdcad.length > 1 ? periodReturns(usdcad) : emptyReturns() },
  ];

  return { alphaCore, models, benchmarks };
}
