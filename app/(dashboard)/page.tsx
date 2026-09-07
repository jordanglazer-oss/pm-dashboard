"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { HoldingInspector } from "@/app/components/HoldingInspector";
import { AppIcon } from "@/app/components/AppIcon";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { CockpitBand } from "@/app/components/CockpitBand";
import { AttentionPanel } from "@/app/components/AttentionPanel";
import { ChangeMonitor } from "@/app/components/ChangeMonitor";
import { ScoreCalibration } from "@/app/components/ScoreCalibration";
import { ForwardScorePanel } from "@/app/components/ForwardScorePanel";
import { regimeMultiplier, normalizeSector } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";


export default function DashboardPage() {
  // Canvas "Reference:" row — reference analyses render on demand.
  const [openRefs, setOpenRefs] = useState<Set<string>>(new Set());
  const toggleRef = (k: string) =>
    setOpenRefs((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  const { scoredStocks, marketData, updateMarketData, uiPrefs, setUiPref, livePreviousCloses } = useStocks();
  // Docked inspector (canvas): the selected holding. Row selection is
  // transient by design (site rule exemption) — it is a working cursor.
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  // The cockpit (model day-returns + the regime strip + scoring posture) is
  // folded one click away: the regime is in the top bar and the model
  // returns sit in the Brief's decision strip, so here it is reference.
  const [cockpitOpen, toggleCockpit] = usePersistedOpen("holdings.cockpit", false);

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
    <main className="min-h-screen bg-ground text-ink overflow-x-hidden">
      <div className="flex flex-col gap-3.5">

        {/* Proactive "needs your attention" digest (Phase 07) — renders only
            when there's something actionable, so calm days stay clean. */}
        <AttentionPanel />

        {/* Holdings + docked inspector (canvas Main.dc.html). The inspector
            docks at lg+ beside the table AND the two-up band; below lg it
            renders above the table. */}
        <div className="flex flex-col gap-3.5 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <PortfolioOverview
              sidebar={<ChangeMonitor />}
              selectedTicker={selectedTicker}
              onSelectTicker={(t) => setSelectedTicker((cur) => (cur && cur.toUpperCase() === t.toUpperCase() ? null : t))}
            />
          </div>
          {selectedTicker && (
            <HoldingInspector
              ticker={selectedTicker}
              previousClose={livePreviousCloses[selectedTicker] ?? null}
              onClose={() => setSelectedTicker(null)}
            />
          )}
        </div>

        {/* Cockpit (#11): the per-PIM-model day returns + the full regime read
            + the scoring-posture control. Folded (persisted) — the regime is
            in the top bar and the model returns are in the Brief. */}
        <section className="panel">
          <button onClick={toggleCockpit} className="flex h-9 w-full items-center gap-2 px-3.5 text-left" aria-expanded={cockpitOpen}>
            <span className={`text-ink-3 transition-transform ${cockpitOpen ? "" : "-rotate-90"}`}><AppIcon name="chevD" size={14} strokeWidth={2} /></span>
            <span className="text-[13px] font-semibold text-ink">Models today &amp; regime</span>
            <span className="text-[11.5px] text-ink-3">
              scoring posture <span className="font-medium text-ink-2">{regime}</span>
              {consolidatedRegime && consolidatedRegime !== regime ? <span className="text-warn"> · engine suggests {consolidatedRegime}</span> : ""}
            </span>
          </button>
          {cockpitOpen && (
            <div className="border-t border-line-soft">
              <CockpitBand
                posture={regime}
                consolidatedRegime={consolidatedRegime}
                onApplyPosture={() => consolidatedRegime && updateMarketData({ riskRegime: consolidatedRegime })}
              />
            </div>
          )}
        </section>

        {/* ── Reference row (canvas): links reveal the reference analyses. ── */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px]">
          <span className="text-ink-3">Reference:</span>
          {([["regime", "Regime multiplier detail"], ["calibration", "Score calibration"], ["forward", "Forward-regime score"]] as const).map(([k, label], idx) => (
            <React.Fragment key={k}>
              {idx > 0 && <span className="text-ink-faint">·</span>}
              <button
                onClick={() => toggleRef(k)}
                className={`font-medium transition-colors ${openRefs.has(k) ? "text-accent-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {label}
              </button>
            </React.Fragment>
          ))}
          <span className="text-ink-faint">·</span>
          <Link href="/methodology" className="font-medium !text-ink-2 hover:!text-ink transition-colors">Methodology</Link>
        </div>

        {openRefs.has("forward") && <ForwardScorePanel />}

        {/* ── Regime Detail — per-stock multiplier breakdown ── */}
        {openRefs.has("regime") && (() => {
          const regimeCollapsed = (uiPrefs["dashboard.regimeMultiplier.collapsed"] ?? "0") === "1";
          const toggleRegimeCollapsed = () => setUiPref("dashboard.regimeMultiplier.collapsed", regimeCollapsed ? "0" : "1");
          return (
        <div id="regime-detail" className="scroll-mt-6">
          <section className="panel">
            <div className={`panel-h ${regimeCollapsed ? "border-b-0" : ""}`}>
              <button
                onClick={toggleRegimeCollapsed}
                className="flex items-center gap-2 text-left"
                aria-expanded={!regimeCollapsed}
                aria-label={regimeCollapsed ? "Expand Regime Multiplier Detail" : "Collapse Regime Multiplier Detail"}
              >
                <span className={`text-ink-3 transition-transform ${regimeCollapsed ? "-rotate-90" : ""}`}><AppIcon name="chevD" size={14} strokeWidth={2} /></span>
                <span className="t">Regime multiplier detail</span>
              </button>
              <span className="m inline-flex items-center gap-1.5"><span className={`dot ${regime === "Risk-Off" ? "bg-neg" : regime === "Neutral" ? "bg-warn" : "bg-pos"}`} />{regime}</span>
            </div>
            {!regimeCollapsed && (<div className="px-3.5 py-3">
            <p className="text-[12px] text-ink-3 mb-3">
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
                                  className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                                    thesisVerdicts[s.ticker.toUpperCase()] === "broken" ? "text-neg" : "text-warn"
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
            </div>)}
          </section>
        </div>
          );
        })()}

        {/* Score-calibration — "does the score actually predict returns?"
            Renders from the Reference row; computes on open (expensive Yahoo
            fetch, cached server-side in pm:score-calibration). */}
        {openRefs.has("calibration") && <ScoreCalibration />}
      </div>
    </main>
  );
}
