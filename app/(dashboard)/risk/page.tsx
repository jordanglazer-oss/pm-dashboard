"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton, SkeletonTable } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";
import { StatStrip } from "@/app/components/StatStrip";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * /risk — the book-level risk lens (read-only). Renders /api/risk-analytics:
 * risk contribution vs weight, correlation clusters, beta-weighted sector
 * tilts vs the S&P, and historical stress replays. Changes nothing.
 */

type RiskName = {
  ticker: string; name: string; sector: string;
  weight: number; rawWeight: number; beta: number;
  annVol: number | null; maxDrawdown: number | null; ctrPct: number | null; bars: number;
};
type RiskCluster = { members: string[]; avgCorr: number; totalWeight: number; kind?: "stock" | "fund" };
type SectorExposure = { sector: string; weight: number; betaWeighted: number; spWeight: number | null };
type ScenarioResult = {
  key: string; label: string; note: string;
  portfolioImpact: number; marketImpact: number;
  worst: { ticker: string; impact: number }[];
};
type RiskData = {
  computedAt: string;
  namesIncluded: number;
  namesSkipped: string[];
  portfolioAnnVol: number | null;
  weightedBeta: number;
  top5Weight: number;
  hhi: number;
  names: RiskName[];
  clusters: RiskCluster[];
  sectors: SectorExposure[];
  scenarios: ScenarioResult[];
  betaScenario: { label: string; portfolioImpact: number };
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function RiskPage() {
  const [data, setData] = useState<RiskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleNote, setStaleNote] = useState(false);

  const load = async (refresh: boolean) => {
    try {
      if (refresh) setRefreshing(true);
      const r = await fetch(`/api/risk-analytics${refresh ? "?refresh=1" : ""}`);
      const j = await r.json();
      if (j?.ok && j.data) {
        setData(j.data as RiskData);
        setStaleNote(Boolean(j.stale));
        setError(null);
      } else {
        setError(j?.error || "failed to compute");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { void load(false); }, []);

  // Names whose share of risk meaningfully exceeds their share of capital.
  const riskHogs = useMemo(() => {
    if (!data) return new Set<string>();
    const out = new Set<string>();
    for (const nm of data.names) {
      if (nm.ctrPct != null && nm.ctrPct >= nm.weight * 100 * 1.5 && nm.ctrPct >= 3) out.add(nm.ticker);
    }
    return out;
  }, [data]);

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Toolbar: what this page is (meta), compute time, refresh. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12px] text-ink-3">
          Read-only · Portfolio bucket · 1y daily · which names drive volatility, which trade as one, sector tilts beta-adjusted, and what documented shocks would do to today&rsquo;s weights
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data && <span className="font-mono text-[11.5px] text-ink-3">computed {new Date(data.computedAt).toLocaleString()}</span>}
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50"
          >
            <AppIcon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Recomputing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        // The first run fetches a year of history per holding (15-30s), so the
        // shape of what's coming beats a bare "Loading…" string.
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-surface sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="-ml-px -mt-px border-l border-t border-line-soft px-3.5 py-2">
                <Skeleton className="h-2.5 w-24 bg-line-soft" />
                <Skeleton className="mt-2 h-4 w-16" />
              </div>
            ))}
          </div>
          <div className="panel p-3.5">
            <Skeleton className="h-3 w-72 bg-line-soft" />
            <div className="mt-4"><SkeletonTable rows={8} cols={8} /></div>
          </div>
          <p className="text-center text-[11.5px] text-ink-3">
            Computing risk analytics — the first run fetches a year of daily history per holding.
          </p>
        </div>
      ) : error && !data ? (
        <section className="panel">
          <EmptyState
            glyph={<AppIcon name="warn" size={18} />}
            title="Couldn't compute risk analytics"
            body={error}
            action={
              <button
                onClick={() => void load(true)}
                className="inline-flex h-7 items-center rounded-control bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2"
              >
                Try again
              </button>
            }
          />
        </section>
      ) : data ? (
        <>
          {staleNote && (
            <div className="flex items-center gap-2 text-[12px] text-warn">
              <span className="dot bg-warn" /> Live recompute failed — showing the last good snapshot.
            </div>
          )}

          {/* ── Header stats: one hairline strip ── */}
          <StatStrip
            cols={5}
            items={[
              { label: "Portfolio ann. vol", value: data.portfolioAnnVol != null ? `${data.portfolioAnnVol}%` : "—", title: "realized, 1y daily, correlation-aware" },
              { label: "Weighted beta", value: data.weightedBeta.toFixed(2), title: `${data.betaScenario.label}: ${data.betaScenario.portfolioImpact}%` },
              { label: "Top-5 weight", value: pct(data.top5Weight), title: "of the weighted book" },
              {
                label: "Concentration (HHI)",
                value: (
                  <>
                    {data.hhi.toFixed(3)}
                    <span className="ml-1.5 font-sans font-normal text-ink-3">
                      {data.hhi > 0.1 ? "concentrated" : data.hhi > 0.06 ? "moderate" : "diversified"}
                    </span>
                  </>
                ),
              },
              {
                label: "Coverage",
                value: `${data.namesIncluded}`,
                title: data.namesSkipped.length ? `no history: ${data.namesSkipped.join(", ")}` : "all names covered",
              },
            ]}
          />
          <div className="-mt-2 text-[11.5px] text-ink-3">
            realized 1y daily, correlation-aware · {data.betaScenario.label}: <span className="font-mono">{data.betaScenario.portfolioImpact}%</span>
            {data.namesSkipped.length > 0 ? <> · no history: {data.namesSkipped.join(", ")}</> : <> · all names covered</>}
          </div>

          {/* ── Two-up: risk contribution left; clusters + stress right ── */}
          <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            {/* ── Risk contribution ── */}
            <section className="panel">
              <div className="panel-h">
                <span className="t">Risk contribution</span>
                <span className="m">covariance share of portfolio variance · <span className="text-warn">warn</span> = risk share ≥ 1.5× capital share</span>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="pl-3.5">Ticker</th>
                      <th>Sector</th>
                      <th className="n">Weight</th>
                      <th className="n">Risk share</th>
                      <th className="n">Risk ÷ weight</th>
                      <th className="n">Ann. vol</th>
                      <th className="n">Max DD (1y)</th>
                      <th className="n">Beta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.names.map((nm) => {
                      const hog = riskHogs.has(nm.ticker);
                      const ratio = nm.ctrPct != null && nm.weight > 0 ? nm.ctrPct / (nm.weight * 100) : null;
                      return (
                        <tr key={nm.ticker}>
                          <td className="pl-3.5">
                            <Link href={`/stock/${encodeURIComponent(nm.ticker)}`} className="font-mono font-medium text-ink hover:text-accent">{displayTicker(nm.ticker)}</Link>
                          </td>
                          <td className="text-ink-2">{nm.sector}</td>
                          <td className="n text-ink-2">{pct(nm.weight)}</td>
                          <td className={`n ${hog ? "font-medium text-warn" : ""}`}>{nm.ctrPct != null ? `${nm.ctrPct.toFixed(1)}%` : "—"}</td>
                          <td className={`n ${hog ? "text-warn" : "text-ink-2"}`}>{ratio != null ? `${ratio.toFixed(1)}×` : "—"}</td>
                          <td className="n text-ink-2">{nm.annVol != null ? `${nm.annVol}%` : "—"}</td>
                          <td className="n text-neg">{nm.maxDrawdown != null ? `${nm.maxDrawdown}%` : "—"}</td>
                          <td className="n text-ink-2">{nm.beta.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex min-h-[32px] items-center px-3.5 text-[11.5px] text-ink-3">
                {data.names.length} names · {riskHogs.size} bigger than they look
              </div>
            </section>

            <div className="flex flex-col gap-3.5">
              {/* ── Correlation clusters ── */}
              <section className="panel">
                <div className="panel-h">
                  <span className="t">Correlation clusters</span>
                  <span className="m">pairwise ≥ 0.70 over 1y · a cluster&rsquo;s weight is the true position</span>
                </div>
                {data.clusters.length === 0 ? (
                  <div className="px-3.5 py-3 text-[12.5px] text-ink-3">No clusters at the 0.70 threshold — the book&rsquo;s names are trading independently.</div>
                ) : (
                  <div className="divide-y divide-line-soft">
                    {/* Fund clusters are the CORE ALLOCATION — broad ETFs correlate
                        with each other by construction, so their cluster is
                        expected structure, never flagged as concentration risk.
                        The warn treatment is reserved for single-name clusters. */}
                    {data.clusters.map((c, i) => {
                      const isFund = c.kind === "fund";
                      const hot = !isFund && c.totalWeight >= 0.2;
                      return (
                        <div key={i} className="px-3.5 py-2.5">
                          <div className="flex items-center gap-2 text-[12.5px]">
                            <span className={`dot ${hot ? "bg-warn" : isFund ? "bg-ink-faint" : "bg-ink-3"}`} />
                            <span className="font-medium text-ink">{isFund ? "Core funds" : `Cluster ${i + 1}`}</span>
                            <span className="font-mono text-ink-2">{pct(c.totalWeight)} of book</span>
                            {hot && <span className="text-warn">concentrated</span>}
                            <span className="ml-auto font-mono text-[11.5px] text-ink-3">avg corr {c.avgCorr.toFixed(2)}</span>
                          </div>
                          {isFund && (
                            <p className="mt-0.5 text-[11.5px] text-ink-3">
                              Broad funds — correlated by construction. Expected structure, not a concentration signal.
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1">
                            {c.members.map((t) => (
                              <Link key={t} href={`/stock/${encodeURIComponent(t)}`} className="font-mono text-[12px] font-medium text-ink hover:text-accent">
                                {displayTicker(t)}
                              </Link>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── Stress replays ── */}
              <section className="panel">
                <div className="panel-h">
                  <span className="t">Stress replays</span>
                  <span className="m">episode sector shocks × current look-through weights · orientation, not prediction</span>
                </div>
                <div className="divide-y divide-line-soft">
                  {data.scenarios.map((sc) => (
                    <div key={sc.key} className="px-3.5 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12.5px] font-medium text-ink">{sc.label}</span>
                        <span className={`ml-auto font-mono text-[13px] font-medium ${sc.portfolioImpact < 0 ? "text-neg" : "text-pos"}`}>
                          {sc.portfolioImpact > 0 ? "+" : ""}{sc.portfolioImpact}%
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-ink-3">{sc.note} Index move: <span className="font-mono">{sc.marketImpact}%</span>.</div>
                      <div className="mt-1 text-[11.5px] text-ink-2">
                        Worst:{" "}
                        {sc.worst.map((wc, i) => (
                          <span key={wc.ticker}>{i > 0 && ", "}<span className="font-mono">{displayTicker(wc.ticker)}</span> <span className="font-mono">{wc.impact}pp</span></span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          {/* ── Beta-weighted sector exposure ── */}
          <section className="panel">
            <div className="panel-h">
              <span className="t">Sector exposure</span>
              <span className="m">look-through · beta-wtd = Σ weight × beta within the sector · vs the S&amp;P</span>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table max-w-2xl">
                <thead>
                  <tr>
                    <th className="pl-3.5">Sector</th>
                    <th className="n">Weight</th>
                    <th className="n">Beta-wtd</th>
                    <th className="n">S&amp;P weight</th>
                    <th className="n">Active tilt</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sectors.map((s) => {
                    const tilt = s.spWeight != null ? s.weight - s.spWeight : null;
                    return (
                      <tr key={s.sector}>
                        <td className="pl-3.5 text-ink-2">{s.sector}</td>
                        <td className="n text-ink-2">{pct(s.weight)}</td>
                        <td className="n">{pct(s.betaWeighted)}</td>
                        <td className="n text-ink-3">{s.spWeight != null ? pct(s.spWeight) : "—"}</td>
                        <td className="n">
                          {tilt != null ? (
                            <span className={tilt > 0.02 ? "text-pos" : tilt < -0.02 ? "text-neg" : "text-ink-3"}>
                              {tilt > 0 ? "+" : ""}{(tilt * 100).toFixed(1)}pp
                            </span>
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
