"use client";

import React, { useEffect, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { CockpitBand } from "@/app/components/CockpitBand";
import { AttentionPanel } from "@/app/components/AttentionPanel";
import { ChangeMonitor } from "@/app/components/ChangeMonitor";
import { ScoreCalibration } from "@/app/components/ScoreCalibration";
import { ForwardScorePanel } from "@/app/components/ForwardScorePanel";
import { regimeMultiplier, normalizeSector } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";


export default function DashboardPage() {
  const { scoredStocks, marketData, updateMarketData, uiPrefs, setUiPref } = useStocks();

  // Thesis-health verdicts (Phase 03) keyed by ticker — surfaced on the score
  // row so a name scoring well whose THESIS is eroding/broken reads differently.
  const [thesisVerdicts, setThesisVerdicts] = useState<Record<string, "eroding" | "broken">>({});
  useEffect(() => {
    let alive = true;
    fetch("/api/thesis-health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j?.thesisHealth?.holdings) return;
        const map: Record<string, "eroding" | "broken"> = {};
        for (const h of j.thesisHealth.holdings as Array<{ ticker: string; verdict: string }>) {
          if (h.verdict === "eroding" || h.verdict === "broken") map[h.ticker.toUpperCase()] = h.verdict;
        }
        setThesisVerdicts(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Consolidated regime — the single canonical label (pm:market-regime
  // composite, curve-aware). The scoring posture (marketData.riskRegime, which
  // actually drives score math) auto-suggests from this but stays PM-overridable.
  const [consolidatedRegime, setConsolidatedRegime] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/market-regime", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const label = j?.composite?.label;
        if (label === "Risk-On" || label === "Neutral" || label === "Risk-Off") setConsolidatedRegime(label);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The scoring posture that drives the multiplier math. Distinct from the
  // consolidated label above only when the PM has overridden the suggestion.
  const regime = marketData.riskRegime;

  // Portfolio β is now rendered inside PortfolioOverview next to the
  // Sector Exposure header — kept alongside other portfolio-level risk
  // context rather than in the market regime card.

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-5">

        {/* Cockpit band (#11): the per-PIM-model day returns + the full
            deterministic market-regime read, merged into one at-a-glance card.
            Every regime signal/horizon is preserved (RegimeStrip renders bare
            inside it); reads /api/market-regime (cached in pm:market-regime) and
            silently hides the regime row on fetch failure. */}
        <CockpitBand
          posture={regime}
          consolidatedRegime={consolidatedRegime}
          onApplyPosture={() => consolidatedRegime && updateMarketData({ riskRegime: consolidatedRegime })}
        />

        {/* Proactive "needs your attention" digest (Phase 07) — sits right
            under the cockpit; renders only when there's something actionable,
            so calm days stay clean. */}
        <AttentionPanel />

        {/* Change monitor moved into the Rankings cockpit's right sidebar
            (passed to PortfolioOverview below) alongside Sector Exposure. */}

        {/* ── Portfolio Overview ── */}
        <PortfolioOverview sidebar={<ChangeMonitor />} />

        {/* ── Forward regime score (Phase 05) — parallel forward-tilted score.
            Sits with the score/regime detail; off by default, toggle to reveal. */}
        <ForwardScorePanel />

        {/* ── Regime Detail — per-stock multiplier breakdown ── */}
        {(() => {
          const regimeCollapsed = (uiPrefs["dashboard.regimeMultiplier.collapsed"] ?? "1") === "1";
          const toggleRegimeCollapsed = () => setUiPref("dashboard.regimeMultiplier.collapsed", regimeCollapsed ? "0" : "1");
          return (
        <div id="regime-detail" className="scroll-mt-6">
          <section className="rounded-card border border-line bg-surface p-6 shadow-sm">
            <div className={`flex items-center gap-3 ${regimeCollapsed ? "" : "mb-4"}`}>
              <button
                onClick={toggleRegimeCollapsed}
                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                aria-expanded={!regimeCollapsed}
                aria-label={regimeCollapsed ? "Expand Regime Multiplier Detail" : "Collapse Regime Multiplier Detail"}
              >
                <svg className={`w-4 h-4 text-ink-3 transition-transform ${regimeCollapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h2 className="text-lg font-bold text-ink">Regime Multiplier Detail</h2>
              </button>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                regime === "Risk-Off" ? "bg-neg-soft text-neg"
                : regime === "Neutral" ? "bg-warn-soft text-warn"
                : "bg-pos-soft text-pos"
              }`}>{regime}</span>
            </div>
            {!regimeCollapsed && (<>
            <p className="text-xs text-ink-3 mb-4">
              Each stock&apos;s regime multiplier is determined by its sector tier (Growth / Cyclical / Defensive) and dampened by its quality score (growth + leverage + cash flow quality + moat, max 8). Higher quality → softer regime effect.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-line text-left">
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3">Ticker</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 hidden md:table-cell">Sector</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3">Tier</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Quality</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right hidden sm:table-cell">Base</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Adj.</th>
                    <th className="py-2 text-xs font-semibold text-ink-3 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {scoredStocks
                    .filter((s) => !s.instrumentType || s.instrumentType === "stock")
                    .sort((a, b) => {
                      const ma = regimeMultiplier(a.sector, regime, a.scores);
                      const mb = regimeMultiplier(b.sector, regime, b.scores);
                      return ma - mb; // most penalized first
                    })
                    .map((s) => {
                      const normalized = normalizeSector(s.sector);
                      const tier =
                        ["Technology", "Communication Services", "Consumer Discretionary"].includes(normalized) ? "Growth"
                        : ["Financials", "Industrials", "Materials", "Energy"].includes(normalized) ? "Cyclical"
                        : ["Utilities", "Consumer Staples", "Health Care"].includes(normalized) ? "Defensive"
                        : "Neutral";
                      const qualityKeys = ["growth", "leverageCoverage", "cashFlowQuality", "competitiveMoat"] as const;
                      const qualityScore = qualityKeys.reduce((sum, k) => sum + (s.scores[k] || 0), 0);
                      const baseMultiplier = regimeMultiplier(s.sector, regime); // no scores = base
                      const adjustedMultiplier = regimeMultiplier(s.sector, regime, s.scores);
                      const tierColor =
                        tier === "Growth" ? "text-accent bg-accent-soft"
                        : tier === "Cyclical" ? "text-warn bg-warn-soft"
                        : tier === "Defensive" ? "text-pos bg-pos-soft"
                        : "text-ink-3 bg-surface-2";
                      const multColor = adjustedMultiplier < 1
                        ? "text-neg" : adjustedMultiplier > 1
                        ? "text-pos" : "text-ink-3";
                      return (
                        <tr key={s.ticker} className="border-b border-line-soft hover:bg-surface-hover transition-colors">
                          <td className="py-2 pr-3 font-mono font-bold text-ink">
                            <span className="inline-flex items-center gap-1.5">
                              {displayTicker(s.ticker)}
                              {thesisVerdicts[s.ticker.toUpperCase()] && (
                                <span
                                  className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                                    thesisVerdicts[s.ticker.toUpperCase()] === "broken" ? "bg-neg-soft text-neg" : "bg-warn-soft text-warn"
                                  }`}
                                  title={`Thesis ${thesisVerdicts[s.ticker.toUpperCase()]} — see Thesis Watch`}
                                >
                                  {thesisVerdicts[s.ticker.toUpperCase()]}
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-ink-3 hidden md:table-cell">{normalized}</td>
                          <td className="py-2 pr-3">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tierColor}`}>{tier}</span>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-ink-2">{qualityScore}/8</td>
                          <td className="py-2 pr-3 text-right font-mono text-ink-3 hidden sm:table-cell">{baseMultiplier.toFixed(2)}x</td>
                          <td className={`py-2 pr-3 text-right font-mono font-semibold ${multColor}`}>{adjustedMultiplier.toFixed(3)}x</td>
                          <td className="py-2 text-right font-mono text-ink-3">
                            {Number(s.raw.toFixed(1))} → <span className="font-semibold text-ink">{Number(s.adjusted.toFixed(1))}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            </>)}
          </section>
        </div>
          );
        })()}

        {/* Score-calibration — "does the score actually predict returns?"
            Collapsed by default; computes on open (expensive Yahoo fetch,
            cached server-side in pm:score-calibration). */}
        <ScoreCalibration />
      </div>
    </main>
  );
}
