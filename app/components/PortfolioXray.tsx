"use client";

import { useMemo, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { formatYmd } from "@/app/lib/date-format";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";

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
    // Persisted fold (pm:ui-prefs `portfolio.xrayCollapsed`), open by default:
    // one hairline strip of six aggregates plus the earnings calendar. The
    // header keeps the holding count visible when it is folded away.
    <CollapsibleSection
      prefKey="portfolio.xrayCollapsed"
      title="Portfolio X-ray"
      subtitle={`FactSet fundamentals · ${count} holdings · ${basis}`}
    >
      <div className="-mx-3.5 -my-2">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((t) => (
            <div key={t.label} className="-ml-px min-w-0 border-l border-line-soft px-3.5 py-2">
              <div className="truncate text-[11px] text-ink-3">{t.label}</div>
              <div className={`mt-0.5 font-mono text-[13px] font-medium tabular-nums ${t.accent || "text-ink"}`}>{t.value}</div>
            </div>
          ))}
        </div>
        {upcomingEarnings.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft px-3.5 py-2 text-[12px]">
            <span className="text-[11px] text-ink-3">Upcoming earnings</span>
            {upcomingEarnings.map((e) => (
              <span key={e.ticker} className="inline-flex items-center gap-1.5">
                <TickerLink ticker={e.ticker} className="font-mono font-medium text-ink hover:text-accent">{displayTicker(e.ticker)}</TickerLink>
                <span className="font-mono text-[11.5px] text-ink-3">{formatYmd(e.date)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
