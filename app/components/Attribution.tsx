"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PeriodKey, ReturnDecomposition, ContributionBreakdown } from "@/app/lib/attribution";

// Canonical model order, matching Positioning / Models tabs.
const MODEL_ORDER = ["conservative", "balanced", "growth", "allEquity", "alpha", "core"];
const orderRank = (p: string) => {
  const i = MODEL_ORDER.indexOf(p);
  return i < 0 ? MODEL_ORDER.length : i;
};

/**
 * Performance Attribution (Phase 04, view 1) — its own tab in the Portfolio
 * hub. Decomposes each model's return into Market (beta) + Currency +
 * Selection. Reads the read-only /api/attribution cache. Every estimate is
 * labelled. Plain ← / → switch models (mirrors Positioning; Shift+arrows stay
 * reserved for switching Portfolio tabs).
 */

type ContribDebug = { positions: number; noSymbol: number; noMatch: number; noPrice: number; noHistory: number; rows: number };
type ProfileAttribution = {
  profile: string;
  label: string;
  periods: ReturnDecomposition[];
  contributionsByPeriod: Partial<Record<PeriodKey, ContributionBreakdown>>;
  contributionsExcluded: number;
  contribDebug?: ContribDebug;
};
type AttributionData = {
  builtAt: string;
  equityBeta: number;
  usdEquityFractionPct: number;
  fxAvailable: boolean;
  profiles: ProfileAttribution[];
};

const PERIODS: PeriodKey[] = ["MTD", "QTD", "YTD", "1Y"];

function fmtPct(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
}
function toneClass(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "text-ink-3";
  return v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2";
}

export function Attribution() {
  const searchParams = useSearchParams();
  const urlVersion = searchParams.get("version");
  const [data, setData] = useState<AttributionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [profileIdx, setProfileIdx] = useState(0);
  const [period, setPeriod] = useState<PeriodKey>("YTD");
  const [benchIdx, setBenchIdx] = useState(0);
  const didInit = useRef(false);

  const applyResponse = useCallback(
    (j: { attribution?: AttributionData }) => {
      if (j?.attribution?.profiles?.length) {
        // Canonical model order (matches the other tabs).
        const profs = j.attribution.profiles
          .slice()
          .sort((a, b) => orderRank(a.profile) - orderRank(b.profile));
        setData({ ...j.attribution, profiles: profs });
        setError(false);
        if (!didInit.current) {
          didInit.current = true;
          const byUrl = urlVersion ? profs.findIndex((p) => p.profile === urlVersion) : -1;
          const bal = profs.findIndex((p) => p.profile === "balanced");
          setProfileIdx(byUrl >= 0 ? byUrl : bal >= 0 ? bal : 0);
        } else {
          setProfileIdx((idx) => Math.min(idx, profs.length - 1));
        }
      } else {
        setError(true);
      }
    },
    [urlVersion],
  );

  useEffect(() => {
    let alive = true;
    fetch("/api/attribution", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => alive && applyResponse(j))
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [applyResponse]);

  const refresh = () => {
    setRefreshing(true);
    fetch("/api/attribution?refresh=1", { cache: "no-store" })
      .then((r) => r.json())
      .then(applyResponse)
      .catch(() => setError(true))
      .finally(() => setRefreshing(false));
  };

  // Plain ← / → cycle models (mirrors Positioning). Shift+arrows are reserved
  // for switching Portfolio tabs; ignore while typing in a field.
  const profileCount = data?.profiles.length ?? 0;
  useEffect(() => {
    if (profileCount <= 1) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      setProfileIdx((idx) =>
        e.key === "ArrowRight" ? (idx + 1) % profileCount : (idx - 1 + profileCount) % profileCount,
      );
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileCount]);

  const decomp = useMemo<ReturnDecomposition | null>(() => {
    const prof = data?.profiles[profileIdx];
    return prof?.periods.find((p) => p.period === period) ?? null;
  }, [data, profileIdx, period]);

  const bench = decomp?.benchmarks[benchIdx] ?? null;

  const profileData = data?.profiles[profileIdx] ?? null;
  const contrib = profileData?.contributionsByPeriod?.[period] ?? null;
  const [showAllHoldings, setShowAllHoldings] = useState(false);

  // Rows for the current selection. Market + Selection follow the chosen
  // benchmark; Currency is benchmark-independent.
  const rows = useMemo(() => {
    if (!decomp || !bench) return [];
    return [
      {
        key: "Market (beta)",
        value: bench.marketContributionPct,
        bar: "bg-accent",
        desc: "What you'd have earned just by being in the market — not from which stocks you picked.",
        note: `your beta ${decomp.portfolioBeta.toFixed(2)} × the ${bench.label}'s ${fmtPct(bench.benchmarkReturnPct)}`,
      },
      {
        key: "Currency (USD/CAD)",
        value: decomp.currencyContributionPct,
        bar: "bg-violet",
        desc: "The part of your return that's purely the US dollar moving against the loonie.",
        note: `${decomp.usdSleeveWeightPct.toFixed(0)}% of the book is USD × the ${fmtPct(decomp.usdcadReturnPct)} USD/CAD move`,
      },
      {
        key: "Selection (alpha)",
        value: bench.selectionPct,
        bar: "bg-ink",
        desc: "What your stock-picking added or lost beyond market + currency — your actual edge.",
        note: "total return minus market minus currency",
      },
    ];
  }, [decomp, bench]);

  const maxAbs = useMemo(() => {
    const vals = rows.map((r) => (r.value == null ? 0 : Math.abs(r.value)));
    const t = decomp?.portfolioReturnPct == null ? 0 : Math.abs(decomp.portfolioReturnPct);
    return Math.max(0.01, ...vals, t);
  }, [rows, decomp]);

  return (
    <div className="flex flex-col gap-4 rounded-card border border-line bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink">Return attribution</h2>
          <p className="text-[12px] text-ink-3">Where your return came from · estimates</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && data.profiles.length > 1 && (
            <span className="hidden text-[11px] text-ink-faint sm:inline">← → switch model</span>
          )}
          {loading ? (
            <span className="text-[11px] text-ink-3">Loading…</span>
          ) : data ? (
            <span className="text-[11px] text-ink-3">
              as of {new Date(data.builtAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          ) : null}
          <button
            onClick={refresh}
            disabled={refreshing || loading}
            className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-[11px] font-semibold text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            title="Recompute with the latest prices, positions and FX"
          >
            <svg className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && !loading && (
        <p className="text-sm text-ink-3 py-2">
          Attribution needs daily portfolio values and price data — nothing to decompose yet.
        </p>
      )}

      {data && decomp && (
        <div className="flex flex-col gap-4">
          {/* selectors */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 max-w-full overflow-x-auto">
              {data.profiles.map((p, i) => (
                <button
                  key={p.profile}
                  onClick={() => setProfileIdx(i)}
                  className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors ${
                    i === profileIdx ? "bg-ink text-white" : "border border-line text-ink-3 hover:bg-surface-2"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                    p === period ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* total */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Total return</span>
              <span className={`font-mono text-2xl font-bold tabular-nums ${toneClass(decomp.portfolioReturnPct)}`}>
                {fmtPct(decomp.portfolioReturnPct)}
              </span>
              {decomp.benchmarks.length > 1 && (
                <div className="ml-auto flex gap-1">
                  {decomp.benchmarks.map((b, i) => (
                    <button
                      key={b.label}
                      onClick={() => setBenchIdx(i)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        i === benchIdx ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-2"
                      }`}
                      title={`Split your return vs ${b.label}`}
                    >
                      {b.label === "S&P 500" ? "vs S&P 500" : "vs TSX"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-[11.5px] text-ink-3">
              Your {data.profiles[profileIdx]?.label} model&apos;s actual {period} return (in CAD), split below into the three things that drove it. Toggle the benchmark on the right.
            </p>
          </div>

          {/* decomposition rows */}
          <div className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-3">
                <span className="w-[128px] shrink-0 text-[13px] text-ink-2">{r.key}</span>
                <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${r.bar}`}
                    style={{ width: `${r.value == null ? 0 : (Math.abs(r.value) / maxAbs) * 100}%` }}
                  />
                </div>
                <span className={`w-[64px] shrink-0 text-right font-mono text-[13px] tabular-nums ${toneClass(r.value)}`}>
                  {fmtPct(r.value)}
                </span>
              </div>
            ))}
          </div>

          {/* per-row explanation — plain-English description + the math */}
          <div className="flex flex-col gap-2 rounded-control bg-surface-2/60 px-3 py-2.5">
            {rows.map((r) => (
              <div key={r.key} className="flex items-start gap-2 text-[11.5px]">
                <span className={`mt-1 h-1.5 w-1.5 rounded-full ${r.bar} shrink-0`} aria-hidden />
                <span>
                  <span className="font-semibold text-ink">{r.key}</span>
                  <span className="text-ink-2"> — {r.desc}</span>
                  <span className="text-ink-faint"> ({r.note})</span>
                </span>
              </div>
            ))}
          </div>

          <p className="text-[10.5px] leading-4 text-ink-faint">
            Estimates. Market = portfolio beta × benchmark return; Currency = USD-sleeve weight × USD/CAD move;
            Selection = total minus those. Full sector allocation/selection attribution arrives once we store per-holding price history.
          </p>

          {/* View 2 — PERIOD-based contribution breakdown (matches the selected period) */}
          {contrib && contrib.holdings.length > 0 && (
            <div className="mt-1 flex flex-col gap-3 border-t border-line-soft pt-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Contribution to return</h3>
                  <span className="text-[11px] text-ink-faint">{period}</span>
                  <span className="ml-auto flex items-baseline gap-1.5">
                    <span className="text-[10.5px] uppercase tracking-wide text-ink-faint">total</span>
                    <span className={`font-mono text-sm font-bold tabular-nums ${toneClass(contrib.totalContributionPct)}`}>
                      {fmtPct(contrib.totalContributionPct)}
                    </span>
                  </span>
                </div>
                <p className="text-[11.5px] text-ink-3">
                  Percentage points each name added to (or subtracted from) your model&apos;s <span className="font-semibold text-ink-2">{period}</span> return — its weight × its own {period} price move (in CAD). These sum to <span className="font-semibold text-ink-2">{fmtPct(contrib.totalContributionPct)}</span>, reconciling with the {period} figure up top.
                  {(profileData?.contributionsExcluded ?? 0) > 0
                    ? ` ${profileData!.contributionsExcluded} position${profileData!.contributionsExcluded === 1 ? "" : "s"} without price history for this period excluded.`
                    : ""}
                </p>
              </div>

              {/* winners + detractors, side by side */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {[
                  { title: "Top contributors", rows: contrib.holdings.filter((h) => h.contributionPct > 0).slice(0, 5) },
                  { title: "Top detractors", rows: [...contrib.holdings].filter((h) => h.contributionPct < 0).sort((a, b) => a.contributionPct - b.contributionPct).slice(0, 5) },
                ].map((col) => (
                  <div key={col.title} className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-semibold text-ink-3">{col.title}</span>
                    {col.rows.length === 0 ? (
                      <span className="text-[12px] text-ink-faint">—</span>
                    ) : (
                      col.rows.map((h) => (
                        <div key={h.ticker} className="flex items-center gap-2 text-[13px]">
                          <span className="font-mono font-semibold text-ink w-[64px] shrink-0 truncate">{h.ticker}</span>
                          <span className="text-[11px] text-ink-faint truncate flex-1">{h.sector}</span>
                          <span className={`font-mono text-[12.5px] tabular-nums shrink-0 ${toneClass(h.contributionPct)}`}>{fmtPct(h.contributionPct)}</span>
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>

              {/* by currency + by sector */}
              <div className="grid grid-cols-1 gap-4 rounded-control bg-surface-2/60 px-3 py-2.5 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">By currency</span>
                  {contrib.byCurrency.map((c) => (
                    <div key={c.key} className="flex items-center gap-2 text-[12.5px]">
                      <span className="text-ink-2 w-[40px]">{c.key}</span>
                      <span className={`font-mono tabular-nums ${toneClass(c.contributionPct)}`}>{fmtPct(c.contributionPct)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">By sector</span>
                  {(showAllHoldings ? contrib.bySector : contrib.bySector.slice(0, 4)).map((s) => (
                    <div key={s.key} className="flex items-center gap-2 text-[12.5px]">
                      <span className="text-ink-2 flex-1 truncate">{s.key}</span>
                      <span className={`font-mono tabular-nums shrink-0 ${toneClass(s.contributionPct)}`}>{fmtPct(s.contributionPct)}</span>
                    </div>
                  ))}
                  {contrib.bySector.length > 4 && (
                    <button
                      onClick={() => setShowAllHoldings((v) => !v)}
                      className="mt-0.5 self-start text-[11px] font-semibold text-accent hover:text-accent-ink transition-colors"
                    >
                      {showAllHoldings ? "Show less" : `Show ${contrib.bySector.length - 4} more`}
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[10.5px] leading-4 text-ink-faint">
                Contribution = each holding&apos;s current weight × its {period} price move (in CAD). Period-based, so it reconciles with the {period} return above.
              </p>
            </div>
          )}

          {/* Empty-state: explain WHY the contribution breakdown is absent. */}
          {(!contrib || contrib.holdings.length === 0) && profileData && (
            <div className="mt-1 flex flex-col gap-1 border-t border-line-soft pt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Contribution to return</h3>
              <p className="text-[12.5px] text-ink-3">
                {(profileData.contribDebug?.positions ?? 0) === 0
                  ? `No saved account positions for the ${profileData.label} model — this breakdown reads position cost basis. Try another model with ← / →.`
                  : `Couldn't match this model's positions to priced holdings.`}
              </p>
              {profileData.contribDebug && profileData.contribDebug.positions > 0 && (
                <p className="text-[11px] text-ink-faint">
                  {profileData.contribDebug.positions} positions · {profileData.contribDebug.noMatch} not matched to a tracked stock ·{" "}
                  {profileData.contribDebug.noPrice} no live price · {profileData.contribDebug.noHistory} no price history · {profileData.contribDebug.rows} usable
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
