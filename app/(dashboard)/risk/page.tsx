"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";

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
type RiskCluster = { members: string[]; avgCorr: number; totalWeight: number };
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

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line bg-white p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

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
    <div className="mx-auto max-w-[1200px] px-4 py-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink">Risk <span className="ml-2 rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3 align-middle">read-only</span></h1>
        <div className="flex items-center gap-3 text-xs text-ink-3">
          {data && <span>computed {new Date(data.computedAt).toLocaleString()}</span>}
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-full bg-surface-2 px-3 py-1 text-ink-2 hover:text-ink disabled:opacity-50"
          >
            {refreshing ? "Recomputing…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        The book as ONE portfolio: which names drive volatility (not just weight), which holdings trade as a single
        position, how sector tilts look beta-adjusted, and what documented historical shocks would do to today&rsquo;s
        weights. Portfolio bucket only; 1 year of daily data.
      </p>

      {loading ? (
        <div className="py-16 text-center text-sm text-ink-3">Computing risk analytics… (first run fetches a year of history per holding)</div>
      ) : error && !data ? (
        <div className="rounded-card border border-line bg-white p-6 text-sm text-ink-2">Couldn&rsquo;t compute: {error}</div>
      ) : data ? (
        <>
          {staleNote && (
            <div className="mb-4 rounded-card border border-warn-border bg-warn-soft px-4 py-2 text-xs text-warn">
              Live recompute failed — showing the last good snapshot.
            </div>
          )}

          {/* ── Header stats ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="Portfolio ann. vol" value={data.portfolioAnnVol != null ? `${data.portfolioAnnVol}%` : "—"} sub="realized, 1y daily, correlation-aware" />
            <StatTile label="Weighted beta" value={data.weightedBeta.toFixed(2)} sub={`${data.betaScenario.label}: ${data.betaScenario.portfolioImpact}%`} />
            <StatTile label="Top-5 weight" value={pct(data.top5Weight)} sub="of the weighted book" />
            <StatTile label="Concentration (HHI)" value={data.hhi.toFixed(3)} sub={data.hhi > 0.1 ? "concentrated" : data.hhi > 0.06 ? "moderate" : "diversified"} />
            <StatTile label="Coverage" value={`${data.namesIncluded}`} sub={data.namesSkipped.length ? `no history: ${data.namesSkipped.join(", ")}` : "all names covered"} />
          </div>

          {/* ── Correlation clusters ── */}
          <div className="mt-6 rounded-card border border-line bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-ink">Correlation clusters — holdings that trade as one position</h2>
            <p className="mt-1 text-xs text-ink-2">Pairwise correlation ≥ 0.70 over the last year. A cluster&rsquo;s weight is your true position size in that trade.</p>
            {data.clusters.length === 0 ? (
              <div className="mt-3 text-xs text-ink-3">No clusters at the 0.70 threshold — the book&rsquo;s names are trading independently.</div>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {data.clusters.map((c, i) => (
                  <div key={i} className={`rounded-lg border p-3 ${c.totalWeight >= 0.2 ? "border-neg-border bg-neg-soft" : "border-line bg-surface-2"}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-ink">{c.totalWeight >= 0.2 ? "⚠ " : ""}Cluster {i + 1} · {pct(c.totalWeight)} of book</span>
                      <span className="text-[11px] text-ink-3">avg corr {c.avgCorr.toFixed(2)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {c.members.map((t) => (
                        <Link key={t} href={`/stock/${encodeURIComponent(t)}`} className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink border border-line hover:text-accent">
                          {displayTicker(t)}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Risk contribution ── */}
          <div className="mt-6 rounded-card border border-line bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-ink">Risk contribution — who actually drives portfolio volatility</h2>
            <p className="mt-1 text-xs text-ink-2">
              Covariance-based share of portfolio variance. <span className="font-semibold text-neg">Highlighted</span>:
              risk share ≥ 1.5× capital share — the positions that are bigger than they look.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="py-2 pr-3">Ticker</th>
                    <th className="py-2 pr-3">Sector</th>
                    <th className="py-2 pr-3 text-right">Weight</th>
                    <th className="py-2 pr-3 text-right">Risk share</th>
                    <th className="py-2 pr-3 text-right">Risk ÷ weight</th>
                    <th className="py-2 pr-3 text-right">Ann. vol</th>
                    <th className="py-2 pr-3 text-right">Max DD (1y)</th>
                    <th className="py-2 text-right">Beta</th>
                  </tr>
                </thead>
                <tbody>
                  {data.names.map((nm) => {
                    const hog = riskHogs.has(nm.ticker);
                    const ratio = nm.ctrPct != null && nm.weight > 0 ? nm.ctrPct / (nm.weight * 100) : null;
                    return (
                      <tr key={nm.ticker} className={`border-b border-line/60 ${hog ? "bg-neg-soft/60" : ""}`}>
                        <td className="py-2 pr-3">
                          <Link href={`/stock/${encodeURIComponent(nm.ticker)}`} className="font-mono font-semibold text-ink hover:text-accent">{displayTicker(nm.ticker)}</Link>
                        </td>
                        <td className="py-2 pr-3 text-xs text-ink-3">{nm.sector}</td>
                        <td className="py-2 pr-3 text-right font-mono text-ink-2">{pct(nm.weight)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${hog ? "font-semibold text-neg" : "text-ink"}`}>{nm.ctrPct != null ? `${nm.ctrPct.toFixed(1)}%` : "—"}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs text-ink-2">{ratio != null ? `${ratio.toFixed(1)}×` : "—"}</td>
                        <td className="py-2 pr-3 text-right font-mono text-ink-2">{nm.annVol != null ? `${nm.annVol}%` : "—"}</td>
                        <td className="py-2 pr-3 text-right font-mono text-neg">{nm.maxDrawdown != null ? `${nm.maxDrawdown}%` : "—"}</td>
                        <td className="py-2 text-right font-mono text-ink-2">{nm.beta.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Stress replays ── */}
          <div className="mt-6 rounded-card border border-line bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-ink">Stress replays — documented episodes applied to today&rsquo;s weights</h2>
            <p className="mt-1 text-xs text-ink-2">Sector-level shocks from each episode × current look-through weights. Approximations for orientation, not predictions.</p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {data.scenarios.map((sc) => (
                <div key={sc.key} className="rounded-lg border border-line bg-surface-2 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-ink">{sc.label}</span>
                    <span className={`font-mono text-lg font-semibold ${sc.portfolioImpact < 0 ? "text-neg" : "text-pos"}`}>
                      {sc.portfolioImpact > 0 ? "+" : ""}{sc.portfolioImpact}%
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-3">{sc.note} Index move: {sc.marketImpact}%.</div>
                  <div className="mt-2 text-[11px] text-ink-2">
                    Worst contributors:{" "}
                    {sc.worst.map((wc, i) => (
                      <span key={wc.ticker}>{i > 0 && ", "}<span className="font-mono">{displayTicker(wc.ticker)}</span> {wc.impact}pp</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Beta-weighted sector exposure ── */}
          <div className="mt-6 rounded-card border border-line bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-ink">Sector exposure — capital vs beta-adjusted, vs the S&amp;P</h2>
            <p className="mt-1 text-xs text-ink-2">Look-through (funds decomposed). Beta-wtd = Σ weight × beta within the sector — high-beta names make a sector bigger than its capital weight.</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full max-w-2xl border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="py-2 pr-3">Sector</th>
                    <th className="py-2 pr-3 text-right">Weight</th>
                    <th className="py-2 pr-3 text-right">Beta-wtd</th>
                    <th className="py-2 pr-3 text-right">S&amp;P weight</th>
                    <th className="py-2 text-right">Active tilt</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sectors.map((s) => {
                    const tilt = s.spWeight != null ? s.weight - s.spWeight : null;
                    return (
                      <tr key={s.sector} className="border-b border-line/60">
                        <td className="py-2 pr-3 text-ink">{s.sector}</td>
                        <td className="py-2 pr-3 text-right font-mono text-ink-2">{pct(s.weight)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-ink">{pct(s.betaWeighted)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-ink-3">{s.spWeight != null ? pct(s.spWeight) : "—"}</td>
                        <td className="py-2 text-right font-mono text-xs">
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
          </div>
        </>
      ) : null}
    </div>
  );
}
