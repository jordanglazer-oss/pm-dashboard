"use client";

import { useMemo, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { formatYmd } from "@/app/lib/date-format";

/**
 * Portfolio X-ray — a book-level roll-up of the Portfolio bucket's FactSet
 * fundamentals: weighted forward/trailing P/E, dividend yield, beta, revenue
 * growth, and average upside to FactSet mean target. Weighted by each holding's
 * portfolio weight when available, else equal-weighted (basis labelled). Pure
 * read from StockContext — no fetches, no writes.
 */

type Tile = { label: string; value: string; hint?: string; accent?: string };

function weightedAvg(pairs: Array<{ w: number; v: number | null | undefined }>): number | null {
  let wsum = 0;
  let vsum = 0;
  for (const { w, v } of pairs) {
    if (typeof v === "number" && isFinite(v) && w > 0) {
      wsum += w;
      vsum += w * v;
    }
  }
  return wsum > 0 ? vsum / wsum : null;
}

const fmt = (v: number | null, digits = 1, suffix = "") =>
  v == null ? "—" : `${v.toFixed(digits)}${suffix}`;

export function PortfolioXray() {
  const { portfolioStocks, analystSnapshots } = useStocks();
  // Stable "now" captured once at mount (lazy state initializer) — keeps the
  // memo pure; second-level staleness is irrelevant for an earnings calendar.
  const [nowMs] = useState(() => Date.now());

  const { tiles, basis, count, upcomingEarnings } = useMemo(() => {
    const holdings = portfolioStocks || [];
    const rawWeights = holdings.map((s) => s.weights?.portfolio ?? 0);
    const totalW = rawWeights.reduce((a, b) => a + b, 0);
    const useWeights = totalW > 0;
    const w = (i: number) => (useWeights ? rawWeights[i] : 1);

    const norm = (t: string) => t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
    const targetByKey = new Map<string, number>();
    for (const [t, snap] of Object.entries(analystSnapshots || {})) {
      const tgt = snap?.factset?.averageTarget;
      if (typeof tgt === "number" && tgt > 0) targetByKey.set(norm(t), tgt);
    }

    const fwdPe = weightedAvg(holdings.map((s, i) => ({ w: w(i), v: s.healthData?.forwardPE })));
    const trailPe = weightedAvg(holdings.map((s, i) => ({ w: w(i), v: s.healthData?.trailingPE })));
    const divYld = weightedAvg(holdings.map((s, i) => ({ w: w(i), v: s.healthData?.dividendYield })));
    const beta = weightedAvg(holdings.map((s, i) => ({ w: w(i), v: typeof s.beta === "number" ? s.beta : null })));
    const revGrowth = weightedAvg(holdings.map((s, i) => ({ w: w(i), v: s.healthData?.revenueGrowth })));
    const upside = weightedAvg(
      holdings.map((s, i) => {
        const tgt = targetByKey.get(norm(s.ticker));
        const price = s.price;
        const v = typeof tgt === "number" && typeof price === "number" && price > 0 ? ((tgt - price) / price) * 100 : null;
        return { w: w(i), v };
      })
    );

    const tiles: Tile[] = [
      { label: "Forward P/E", value: fmt(fwdPe, 1, "×") },
      { label: "Trailing P/E", value: fmt(trailPe, 1, "×") },
      { label: "Dividend yield", value: fmt(divYld, 2, "%") },
      { label: "Beta", value: fmt(beta, 2) },
      { label: "Revenue growth", value: fmt(revGrowth, 1, "%") },
      {
        label: "Upside to target",
        value: fmt(upside, 1, "%"),
        accent: upside == null ? undefined : upside >= 0 ? "text-pos" : "text-neg",
      },
    ];
    // Upcoming earnings — per-holding next report date (Yahoo-sourced; FactSet
    // doesn't expose the next date via the Formula API). Soonest first.
    const upcomingEarnings = holdings
      .map((s) => ({ ticker: s.ticker, date: s.healthData?.earningsDate }))
      .filter((h): h is { ticker: string; date: string } => !!h.date && !Number.isNaN(Date.parse(h.date)))
      .map((h) => ({ ...h, ms: Date.parse(h.date) }))
      .filter((h) => h.ms >= nowMs - 3 * 864e5) // keep today + last 3 days, drop stale
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 10);

    return { tiles, basis: useWeights ? "portfolio-weighted" : "equal-weighted", count: holdings.length, upcomingEarnings };
  }, [portfolioStocks, analystSnapshots, nowMs]);

  if (count === 0) return null;

  return (
    <div className="mb-6 rounded-card border border-line bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-ink">Portfolio X-ray <span className="font-normal text-ink-3">· FactSet fundamentals</span></h2>
        <span className="text-[11px] text-ink-3">{count} holdings · {basis}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-line-soft bg-surface-hover px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t.label}</div>
            <div className={`mt-1 text-lg font-bold tabular-nums ${t.accent || "text-ink"}`}>{t.value}</div>
          </div>
        ))}
      </div>
      {upcomingEarnings.length > 0 && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Upcoming earnings</div>
          <div className="flex flex-wrap gap-1.5">
            {upcomingEarnings.map((e) => (
              <span key={e.ticker} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px]">
                <span className="font-mono font-semibold text-ink">{displayTicker(e.ticker)}</span>
                <span className="text-ink-3">{formatYmd(e.date)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
