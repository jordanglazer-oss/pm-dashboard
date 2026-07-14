import { getRedis } from "@/app/lib/redis";
import { computeRegimeTransition, type RegimeTransition } from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import type { StockContext } from "@/app/lib/alerts";

/**
 * ONE loader for every input the alert engine needs, so the in-app
 * "Needs your attention" tile (/api/alerts) and the morning email digest
 * (alert-digest) are computed from IDENTICAL data. Previously each read Redis
 * separately and the digest lacked the per-stock context, so the email was
 * thinner than the tile.
 *
 * Everything here is READ-ONLY: pm:thesis-health, pm:market-regime, pm:stocks,
 * pm:analyst-snapshots, pm:score-history. No writes.
 */

export type ThesisHoldings = {
  holdings?: Array<{
    ticker: string;
    verdict: string;
    summary?: string;
    drivers?: Array<{ signal: string; direction: string; detail: string }>;
  }>;
} | null;

export type RiskRow = {
  ticker: string;
  riskLevel?: string;
  bucket?: string;
  dangerSignals?: string[];
  riskSummary?: string;
};

export type AlertInputs = {
  thesis: ThesisHoldings;
  transition: RegimeTransition | null;
  risk: RiskRow[] | null;
  /** Per-ticker supporting context (UPPER-cased key) used to enrich alerts. */
  context: Record<string, StockContext>;
  /** Watchlist rows for the Opportunities half. */
  watchlist: Array<{ ticker: string; netRevisions?: number | null; scoreDelta?: number | null; riskLevel?: string }>;
};

type StoredStock = {
  ticker?: string;
  name?: string;
  sector?: string;
  bucket?: string;
  price?: number;
  riskAlert?: { level?: string; summary?: string; signals?: Array<{ name: string; status: string }> };
};

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function loadAlertInputs(): Promise<AlertInputs> {
  const redis = await getRedis();
  const [thesisRaw, regimeRaw, stocksRaw, snapsRaw, scoreRaw] = await Promise.all([
    redis.get("pm:thesis-health"),
    redis.get("pm:market-regime"),
    redis.get("pm:stocks"),
    redis.get("pm:analyst-snapshots"),
    redis.get("pm:score-history"),
  ]);

  const thesis = parse<ThesisHoldings>(thesisRaw, null);

  let transition: RegimeTransition | null = null;
  const regime = parse<MarketRegimeData | null>(regimeRaw, null);
  if (regime?.composite) {
    try {
      transition = computeRegimeTransition(regime);
    } catch {
      transition = null;
    }
  }

  const stocks = parse<StoredStock[]>(stocksRaw, []);
  const risk: RiskRow[] | null = Array.isArray(stocks)
    ? stocks.map((s) => ({
        ticker: s.ticker ?? "",
        bucket: s.bucket,
        riskLevel: s.riskAlert?.level,
        riskSummary: s.riskAlert?.summary,
        dangerSignals: (s.riskAlert?.signals ?? []).filter((sig) => sig.status === "danger").map((sig) => sig.name),
      }))
    : null;

  const snaps = parse<Record<string, { factset?: { revUp?: number; revDown?: number; analystCount?: number; averageTarget?: number } }>>(
    snapsRaw,
    {}
  );
  const scoreHist = parse<Record<string, Array<{ date: string; total?: number; adjusted?: number }>>>(scoreRaw, {});

  /** Composite score change over ~45 calendar days, from the per-ticker history. */
  const historyFor = (tk: string) =>
    (scoreHist[tk] ?? scoreHist[tk.toUpperCase()] ?? [])
      .filter((e) => e && typeof e.date === "string" && typeof (e.adjusted ?? e.total) === "number")
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const val = (e: { total?: number; adjusted?: number }) => (e.adjusted ?? e.total) as number;

  const scoreDeltaFor = (tk: string): number | null => {
    const hist = historyFor(tk);
    if (hist.length < 2) return null;
    const latest = hist[hist.length - 1];
    const [y, m, d] = latest.date.split("-").map(Number);
    const cutoff = new Date(Date.UTC(y, m - 1, d - 45)).toISOString().slice(0, 10);
    let baseline = val(hist[0]);
    for (const e of hist) if (e.date <= cutoff) baseline = val(e);
    return Math.round((val(latest) - baseline) * 10) / 10;
  };
  const compositeFor = (tk: string): number | null => {
    const hist = historyFor(tk);
    return hist.length ? val(hist[hist.length - 1]) : null;
  };
  const netRevFor = (tk: string): number | null => {
    const fs = snaps[tk]?.factset ?? snaps[tk.toUpperCase()]?.factset;
    if (!fs || (typeof fs.revUp !== "number" && typeof fs.revDown !== "number")) return null;
    return (fs.revUp ?? 0) - (fs.revDown ?? 0);
  };

  const context: Record<string, StockContext> = {};
  for (const s of stocks) {
    const tk = (s.ticker || "").toUpperCase();
    if (!tk) continue;
    const fs = snaps[tk]?.factset;
    context[tk] = {
      name: s.name,
      sector: s.sector,
      bucket: s.bucket,
      price: typeof s.price === "number" ? s.price : null,
      composite: compositeFor(tk),
      scoreDelta: scoreDeltaFor(tk),
      netRevisions: netRevFor(tk),
      revUp: typeof fs?.revUp === "number" ? fs.revUp : null,
      revDown: typeof fs?.revDown === "number" ? fs.revDown : null,
      riskLevel: s.riskAlert?.level ?? null,
    };
  }

  const watchlist = (risk ?? [])
    .filter((r) => r.bucket === "Watchlist" && r.ticker)
    .map((r) => {
      const tk = r.ticker.toUpperCase();
      return { ticker: tk, netRevisions: netRevFor(tk), scoreDelta: scoreDeltaFor(tk), riskLevel: r.riskLevel };
    });

  return { thesis, transition, risk, context, watchlist };
}
