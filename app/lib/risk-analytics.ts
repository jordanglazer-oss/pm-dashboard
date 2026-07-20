import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { normalizeSector } from "./scoring";
import type { Stock } from "./types";

/**
 * Book-level risk lens (the "risk infrastructure" layer). Computes, for the
 * PORTFOLIO bucket only:
 *
 *   • per-name realized vol / max drawdown from 1y of daily closes (Yahoo)
 *   • covariance-based RISK CONTRIBUTION — which names drive portfolio
 *     volatility vs the weight they occupy (the invisible-concentration view)
 *   • CORRELATION CLUSTERS — holdings that trade as one position (pairwise
 *     corr ≥ CLUSTER_THRESHOLD, union-find)
 *   • beta-weighted sector exposure with fund LOOK-THROUGH (fundData
 *     sectorWeightings) vs live S&P sector weights (pm:market) when present
 *   • STRESS REPLAYS — documented historical sector-shock vectors (2022 rate
 *     shock, COVID crash) applied to today's look-through weights, plus a
 *     beta-scaled uniform market-drop scenario
 *
 * Reads pm:stocks and pm:market READ-ONLY. Writes only its own regenerable
 * cache key (pm:risk-analytics). Zero Anthropic; ~1 Yahoo chart call per
 * holding, cached for hours.
 */

const log = createLogger("RiskAnalytics");

export const RISK_KEY = "pm:risk-analytics";
export const RISK_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const CLUSTER_THRESHOLD = 0.7;
const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Historical sector shock vectors (% total return), documented approximations
 *  of S&P sector-index performance over each episode. Keyed by the dashboard's
 *  normalized sector vocabulary. */
const SCENARIOS: { key: string; label: string; note: string; shocks: Record<string, number>; market: number }[] = [
  {
    key: "rates2022",
    label: "2022 Rate Shock (full year)",
    note: "S&P 500 −18% as rates repriced; long-duration growth hit hardest, energy soared.",
    market: -18,
    shocks: {
      "Technology": -28, "Communication Services": -38, "Consumer Discretionary": -36,
      "Financials": -11, "Industrials": -6, "Materials": -12, "Energy": 64,
      "Consumer Staples": -1, "Healthcare": -2, "Utilities": 2, "Real Estate": -26,
    },
  },
  {
    key: "covid2020",
    label: "COVID Crash (Feb 19 – Mar 23, 2020)",
    note: "S&P 500 −34% in 23 trading days; everything fell, energy and financials most.",
    market: -34,
    shocks: {
      "Technology": -31, "Communication Services": -29, "Consumer Discretionary": -34,
      "Financials": -42, "Industrials": -41, "Materials": -37, "Energy": -56,
      "Consumer Staples": -24, "Healthcare": -27, "Utilities": -36, "Real Estate": -38,
    },
  },
];

export type RiskName = {
  ticker: string;
  name: string;
  sector: string;
  weight: number;        // normalized within included names (0..1)
  rawWeight: number;     // as stored (percent)
  beta: number;
  annVol: number | null;      // %
  maxDrawdown: number | null; // % (negative)
  ctrPct: number | null;      // share of portfolio risk (0..100)
  bars: number;               // trading days of history used
};

export type RiskCluster = {
  members: string[];
  avgCorr: number;
  totalWeight: number; // 0..1
};

export type SectorExposure = {
  sector: string;
  weight: number;        // look-through, 0..1
  betaWeighted: number;  // Σ w·β within sector
  spWeight: number | null; // live S&P weight (0..1) when available
};

export type ScenarioResult = {
  key: string;
  label: string;
  note: string;
  portfolioImpact: number; // %
  marketImpact: number;    // % (the episode's index move, for comparison)
  worst: { ticker: string; impact: number }[]; // top negative name contributions (pp)
};

export type RiskAnalytics = {
  computedAt: string;
  namesIncluded: number;
  namesSkipped: string[];
  portfolioAnnVol: number | null; // %
  weightedBeta: number;
  top5Weight: number; // 0..1 of included book
  hhi: number;        // Herfindahl on normalized weights (0..1)
  names: RiskName[];
  clusters: RiskCluster[];
  sectors: SectorExposure[];
  scenarios: ScenarioResult[];
  betaScenario: { label: string; portfolioImpact: number }; // market −10% × β
};

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

async function fetchCloses(ticker: string): Promise<Map<string, number> | null> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=1y&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];
    const out = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && isFinite(c) && c > 0) {
        out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
      }
    }
    return out.size >= 60 ? out : null; // need a real history, not a stub
  } catch {
    return null;
  }
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch { return fb; }
}

type StoredStock = Stock & { fundData?: { sectorWeightings?: Array<{ sector: string; weight: number }> } };

export async function computeRiskAnalytics(): Promise<RiskAnalytics | { error: string }> {
  const redis = await getRedis();
  const stocks = parse<StoredStock[]>(await redis.get("pm:stocks"), []);
  const market = parse<{ sp500SectorWeights?: Record<string, number> }>(await redis.get("pm:market"), {});

  const book = stocks.filter((s) => s.bucket === "Portfolio" && (s.weights?.portfolio || 0) > 0);
  if (book.length < 3) return { error: `only ${book.length} weighted Portfolio names — nothing to analyze` };

  // ── 1y daily closes per name (concurrency-limited) ──
  const closesByTicker = new Map<string, Map<string, number>>();
  const skipped: string[] = [];
  const CONC = 8;
  for (let i = 0; i < book.length; i += CONC) {
    const batch = book.slice(i, i + CONC);
    const results = await Promise.all(batch.map((s) => fetchCloses(s.ticker)));
    batch.forEach((s, j) => {
      const m = results[j];
      if (m) closesByTicker.set(s.ticker, m);
      else skipped.push(s.ticker);
    });
  }

  const included = book.filter((s) => closesByTicker.has(s.ticker));
  if (included.length < 3) return { error: `price history resolved for only ${included.length} names` };

  // Common date spine: dates present for ALL included names (US/CA holiday
  // intersection — typically ~230 of 252 days; correlations stay honest).
  const dateSets = included.map((s) => closesByTicker.get(s.ticker)!);
  let spine = [...dateSets[0].keys()];
  for (const ds of dateSets.slice(1)) spine = spine.filter((d) => ds.has(d));
  spine.sort();
  if (spine.length < 60) return { error: `only ${spine.length} overlapping trading days` };

  // Returns matrix [name][day]
  const rets: number[][] = included.map((s) => {
    const m = closesByTicker.get(s.ticker)!;
    const r: number[] = [];
    for (let i = 1; i < spine.length; i++) r.push(m.get(spine[i])! / m.get(spine[i - 1])! - 1);
    return r;
  });
  const n = included.length;
  const days = rets[0].length;

  // Normalized weights over included names.
  const rawW = included.map((s) => s.weights.portfolio || 0);
  const wSum = rawW.reduce((a, b) => a + b, 0);
  const w = rawW.map((x) => x / wSum);

  // Covariance + correlation (daily).
  const mu = rets.map(mean);
  const cov: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let d = 0; d < days; d++) s += (rets[i][d] - mu[i]) * (rets[j][d] - mu[j]);
      cov[i][j] = cov[j][i] = s / days;
    }
  }
  const sd = cov.map((row, i) => Math.sqrt(row[i]));
  const corr = (i: number, j: number) => (sd[i] > 0 && sd[j] > 0 ? cov[i][j] / (sd[i] * sd[j]) : 0);

  // Portfolio vol + risk contributions: CTR_i = w_i·(Σw)_i / σ_p².
  const sigmaW = cov.map((row) => row.reduce((a, c, j) => a + c * w[j], 0));
  const varP = sigmaW.reduce((a, x, i) => a + x * w[i], 0);
  const sigmaP = Math.sqrt(Math.max(0, varP));
  const annVolP = sigmaP > 0 ? sigmaP * Math.sqrt(252) * 100 : null;

  // Per-name stats.
  const names: RiskName[] = included.map((s, i) => {
    const m = closesByTicker.get(s.ticker)!;
    let peak = -Infinity;
    let mdd = 0;
    for (const d of spine) {
      const c = m.get(d)!;
      peak = Math.max(peak, c);
      mdd = Math.min(mdd, c / peak - 1);
    }
    return {
      ticker: s.ticker,
      name: s.name,
      sector: normalizeSector(s.sector),
      weight: w[i],
      rawWeight: rawW[i],
      beta: s.beta,
      annVol: sd[i] > 0 ? Math.round(sd[i] * Math.sqrt(252) * 1000) / 10 : null,
      maxDrawdown: Math.round(mdd * 1000) / 10,
      ctrPct: varP > 0 ? Math.round(((w[i] * sigmaW[i]) / varP) * 1000) / 10 : null,
      bars: spine.length,
    };
  });

  // ── Correlation clusters (union-find over pairs ≥ threshold) ──
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (corr(i, j) >= CLUSTER_THRESHOLD) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  }
  const clusters: RiskCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let cSum = 0;
    let pairs = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) { cSum += corr(idxs[a], idxs[b]); pairs++; }
    }
    clusters.push({
      members: idxs.map((i) => included[i].ticker),
      avgCorr: Math.round((cSum / pairs) * 100) / 100,
      totalWeight: Math.round(idxs.reduce((a, i) => a + w[i], 0) * 1000) / 1000,
    });
  }
  clusters.sort((a, b) => b.totalWeight - a.totalWeight);

  // ── Beta-weighted sector exposure with fund look-through ──
  const secAgg = new Map<string, { weight: number; betaWeighted: number }>();
  const addSec = (sector: string, wgt: number, beta: number) => {
    const key = normalizeSector(sector) || "Unclassified";
    const cur = secAgg.get(key) ?? { weight: 0, betaWeighted: 0 };
    cur.weight += wgt;
    cur.betaWeighted += wgt * beta;
    secAgg.set(key, cur);
  };
  included.forEach((s, i) => {
    const sw = s.fundData?.sectorWeightings;
    if (Array.isArray(sw) && sw.length > 0) {
      const total = sw.reduce((a, x) => a + (x.weight || 0), 0) || 1;
      for (const x of sw) addSec(x.sector, (w[i] * (x.weight || 0)) / total, s.beta);
    } else {
      addSec(s.sector, w[i], s.beta);
    }
  });
  const spW = market.sp500SectorWeights || null;
  const spTotal = spW ? Object.values(spW).reduce((a, b) => a + b, 0) : 0;
  const sectors: SectorExposure[] = [...secAgg.entries()]
    .map(([sector, v]) => ({
      sector,
      weight: Math.round(v.weight * 1000) / 1000,
      betaWeighted: Math.round(v.betaWeighted * 1000) / 1000,
      spWeight: spW && spTotal > 0
        ? Math.round(((Object.entries(spW).find(([k]) => normalizeSector(k) === sector)?.[1] ?? 0) / spTotal) * 1000) / 1000
        : null,
    }))
    .sort((a, b) => b.weight - a.weight);

  // ── Stress replays (sector shocks × look-through weights) ──
  const scenarios: ScenarioResult[] = SCENARIOS.map((sc) => {
    let impact = 0;
    const perName: { ticker: string; impact: number }[] = [];
    included.forEach((s, i) => {
      // Per-name shock: its (look-through) sector mix mapped through the
      // scenario vector; unmapped sectors get the episode's market move.
      const sw = s.fundData?.sectorWeightings;
      let shock = 0;
      if (Array.isArray(sw) && sw.length > 0) {
        const total = sw.reduce((a, x) => a + (x.weight || 0), 0) || 1;
        for (const x of sw) shock += ((x.weight || 0) / total) * (sc.shocks[normalizeSector(x.sector)] ?? sc.market);
      } else {
        shock = sc.shocks[normalizeSector(s.sector)] ?? sc.market;
      }
      const contrib = w[i] * shock;
      impact += contrib;
      perName.push({ ticker: s.ticker, impact: Math.round(contrib * 10) / 10 });
    });
    perName.sort((a, b) => a.impact - b.impact);
    return {
      key: sc.key,
      label: sc.label,
      note: sc.note,
      portfolioImpact: Math.round(impact * 10) / 10,
      marketImpact: sc.market,
      worst: perName.slice(0, 5),
    };
  });

  const weightedBeta = Math.round(included.reduce((a, s, i) => a + w[i] * s.beta, 0) * 100) / 100;
  const sortedW = [...w].sort((a, b) => b - a);
  const top5Weight = Math.round(sortedW.slice(0, 5).reduce((a, b) => a + b, 0) * 1000) / 1000;
  const hhi = Math.round(w.reduce((a, x) => a + x * x, 0) * 1000) / 1000;

  const out: RiskAnalytics = {
    computedAt: new Date().toISOString(),
    namesIncluded: n,
    namesSkipped: skipped,
    portfolioAnnVol: annVolP != null ? Math.round(annVolP * 10) / 10 : null,
    weightedBeta,
    top5Weight,
    hhi,
    names: names.sort((a, b) => (b.ctrPct ?? 0) - (a.ctrPct ?? 0)),
    clusters,
    sectors,
    scenarios,
    betaScenario: {
      label: "Market −10% (beta-scaled)",
      portfolioImpact: Math.round(-10 * weightedBeta * 10) / 10,
    },
  };

  await redis.set(RISK_KEY, JSON.stringify(out));
  log.info(`computed: ${n} names, σ ${out.portfolioAnnVol}%, ${clusters.length} clusters, ${skipped.length} skipped`);
  return out;
}

export async function readRiskAnalytics(): Promise<RiskAnalytics | null> {
  const redis = await getRedis();
  return parse<RiskAnalytics | null>(await redis.get(RISK_KEY), null);
}
