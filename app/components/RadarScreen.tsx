"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import { useTableSort, currencyOf } from "@/app/lib/useTableSort";
import type { ScoreKey } from "@/app/lib/types";
import type { RadarName, RadarPayload } from "@/app/lib/radar";

/** A promoted name starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const GROUP_ORDER = ["quality", "growth", "valuation", "momentum"] as const;
const GROUP_SHORT: Record<string, string> = {
  quality: "Qual", growth: "Grow", valuation: "Val", momentum: "Mom",
};

/**
 * Radar — the proactive counterpart to the Suggested Watchlist. Where
 * Suggested aggregates what the research LISTS are nominating (reactive by
 * construction — every name was already published somewhere), Radar is
 * computed entirely in-house: the weekly FactSet factor universe (~540 S&P 500
 * + TSX 60 names, sector-neutral z-scores on most-recent financials) re-ranked
 * under the CURRENT market regime's factor tilts. Kept separate on purpose;
 * may merge into Suggested once the read has earned trust.
 */
export function RadarScreen({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { stocks, addStock } = useStocks();
  const [data, setData] = useState<RadarPayload | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [ccy, setCcy] = useState<"All" | "CAD" | "USD">("All");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/radar", { cache: "no-store" });
      if (r.ok) {
        const d: RadarPayload = await r.json();
        setData(d);
        onCountChange?.(d.names?.length ?? 0);
        // Company names for display — one chunked call for the 50 shown.
        const tickers = (d.names ?? []).map((n) => n.ticker);
        if (tickers.length) {
          try {
            const nr = await fetch(`/api/company-name?tickers=${encodeURIComponent(tickers.join(","))}`, { cache: "no-store" });
            if (nr.ok) {
              const nd = await nr.json();
              if (nd?.names) setNames(nd.names);
            }
          } catch { /* names are cosmetic */ }
        }
      }
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  const held = useCallback(
    (t: string) => stocks.some((s) => s.ticker.toUpperCase().replace(/-T$/, ".TO") === t.toUpperCase().replace(/-T$/, ".TO")),
    [stocks],
  );

  const promote = async (n: RadarName) => {
    setAdding(n.ticker);
    try {
      addStock({
        ticker: n.ticker.toUpperCase(),
        name: names[n.ticker] || n.ticker,
        bucket: "Watchlist",
        instrumentType: "stock",
        sector: n.sector || "",
        beta: 1.0,
        weights: { portfolio: 0 },
        scores: { ...ZERO_SCORES },
        notes: `From Radar — regime fit P${n.regimeFit} (${data?.regime?.label ?? "Neutral"}), quant P${n.quant}`,
      });
    } finally {
      setAdding(null);
    }
  };

  const all = data?.names ?? [];
  const filtered = ccy === "All" ? all : all.filter((n) => currencyOf(n.ticker) === ccy);
  const cadCount = all.filter((n) => currencyOf(n.ticker) === "CAD").length;
  const usdCount = all.length - cadCount;

  const { sorted, toggle, arrow } = useTableSort(
    filtered,
    {
      ticker: (n) => n.ticker,
      sector: (n) => n.sector,
      fit: (n) => n.regimeFit,
      quant: (n) => n.quant,
      conf: (n) => n.confidence,
    },
    "fit",
  );

  const regimeLabel = data?.regime?.label ?? "Neutral";
  const regimeTone =
    regimeLabel === "Risk-On" ? "bg-pos-soft text-pos ring-pos-border"
    : regimeLabel === "Risk-Off" ? "bg-neg-soft text-neg ring-neg-border"
    : "bg-surface-2 text-ink-2 ring-line";
  const weightsLine = data?.weights
    ? GROUP_ORDER.map((g) => `${GROUP_SHORT[g]} ${Math.round((data.weights[g] ?? 0) * 100)}%`).join(" · ")
    : "";

  const th = "pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";
  const thSort = `${th} cursor-pointer select-none hover:text-ink`;

  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">
            Radar
            <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${regimeTone}`}>
              {regimeLabel}
            </span>
          </h2>
          <p className="text-xs text-ink-3">
            {data?.builtAt
              ? `Own factor model over the S&P 500 + TSX 60, tilted for the current regime (${weightsLine}) · universe built ${new Date(data.builtAt).toLocaleDateString()}`
              : "Self-computed screen — populates after the weekly factor-universe build."}
          </p>
        </div>
        <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5 text-xs">
          {(["All", "CAD", "USD"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCcy(c)}
              className={`rounded-[6px] px-2.5 py-1 font-semibold transition-colors ${ccy === c ? "bg-accent text-white" : "text-ink-2 hover:text-ink"}`}
            >
              {c}
              {c !== "All" && (
                <span className={`ml-1 font-normal ${ccy === c ? "text-white/70" : "text-ink-3"}`}>
                  {c === "CAD" ? cadCount : usdCount}
                </span>
              )}
            </button>
          ))}
        </span>
      </div>

      {/* Sector heat strip — where the market's momentum is, from the same
          universe (median 12-1m momentum per GICS sector). */}
      {(data?.sectors?.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {data!.sectors.map((s) => {
            const v = s.medMom12;
            const tone =
              v == null ? "bg-surface-2 text-ink-3 ring-line"
              : v >= 0 ? "bg-pos-soft text-pos ring-pos-border"
              : "bg-neg-soft text-neg ring-neg-border";
            return (
              <span
                key={s.sector}
                title={`Median 12-1m momentum ${v == null ? "n/a" : `${v.toFixed(1)}%`} · 6-1m ${s.medMom6 == null ? "n/a" : `${s.medMom6.toFixed(1)}%`} · ${s.n} names`}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${tone}`}
              >
                {s.sector}
                {v != null && (
                  <span className="ml-1 font-mono font-normal">{v > 0 ? "+" : ""}{v.toFixed(0)}%</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-xs text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-8 text-center text-xs text-ink-3">
          {data?.hint ?? "No names to show — every screened name is already tracked."}
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={thSort} onClick={() => toggle("ticker")}>Ticker{arrow("ticker")}</th>
                <th className={th}>Name</th>
                <th className={thSort} onClick={() => toggle("sector")}>Sector{arrow("sector")}</th>
                <th className={`${thSort} text-right`} onClick={() => toggle("fit")} title="Percentile under the current regime's factor tilts">Regime fit{arrow("fit")}</th>
                <th className={`${thSort} text-right`} onClick={() => toggle("quant")} title="Baseline quant percentile (untitled weights)">Quant{arrow("quant")}</th>
                {GROUP_ORDER.map((g) => (
                  <th key={g} className={`${th} text-right`} title={`Mean sector-neutral z, ${g}`}>{GROUP_SHORT[g]}</th>
                ))}
                <th className={`${thSort} text-right`} onClick={() => toggle("conf")} title="Data coverage × cross-group agreement">Conf{arrow("conf")}</th>
                <th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((n) => (
                <tr key={n.ticker} className="border-b border-line-soft hover:bg-surface-hover">
                  <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-ink">
                    {displayTicker(n.ticker)}
                    {n.distress === "grey" && (
                      <span
                        title={`Altman-style Z ${n.altmanZ ?? "?"} — grey zone; balance sheet warrants a look`}
                        className="ml-1.5 rounded-full bg-warn-soft px-1.5 py-px text-[9px] font-bold uppercase text-warn ring-1 ring-warn-border"
                      >
                        Z
                      </span>
                    )}
                  </td>
                  <td className="max-w-[200px] truncate py-2.5 pr-3 text-ink">{names[n.ticker] || "—"}</td>
                  <td className="py-2.5 pr-3 text-xs text-ink-2">{n.sector}</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-semibold tabular-nums text-ink">{n.regimeFit}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-ink-2">{n.quant}</td>
                  {GROUP_ORDER.map((g) => {
                    const z = n.groups[g];
                    return (
                      <td key={g} className={`py-2.5 pr-3 text-right font-mono text-xs tabular-nums ${z == null ? "text-ink-faint" : z >= 0 ? "text-pos" : "text-neg"}`}>
                        {z == null ? "—" : `${z > 0 ? "+" : ""}${z.toFixed(1)}`}
                      </td>
                    );
                  })}
                  <td className="py-2.5 pr-3 text-right font-mono text-xs tabular-nums text-ink-3">{n.confidence}</td>
                  <td className="py-2.5 text-right">
                    {held(n.ticker) ? (
                      <span className="text-[11px] font-semibold text-ink-faint">Tracked</span>
                    ) : (
                      <button
                        onClick={() => promote(n)}
                        disabled={adding === n.ticker}
                        className="rounded bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent disabled:opacity-50"
                      >
                        {adding === n.ticker ? "…" : "+ Watchlist"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
