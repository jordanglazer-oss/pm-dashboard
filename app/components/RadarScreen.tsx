"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
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

  const { sorted, key: sortKey, dir: sortDir, toggle } = useTableSort(
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
  const regimeDot = regimeLabel === "Risk-On" ? "bg-pos" : regimeLabel === "Risk-Off" ? "bg-neg" : "bg-ink-faint";
  const weightsLine = data?.weights
    ? GROUP_ORDER.map((g) => `${GROUP_SHORT[g]} ${Math.round((data.weights[g] ?? 0) * 100)}%`).join(" · ")
    : "";
  const SORT_LABEL: Record<string, string> = { ticker: "ticker", sector: "sector", fit: "regime fit", quant: "quant", conf: "confidence" };

  const Th = ({ id, label, className = "", title }: { id?: string; label: string; className?: string; title?: string }) => (
    <th className={className} title={title}>
      {id ? (
        <button type="button" onClick={() => toggle(id)} className={`inline-flex items-center gap-0.5 hover:text-ink ${sortKey === id ? "text-ink-2" : ""}`}>
          {label}
          {sortKey === id && <AppIcon name={sortDir === "asc" ? "chevU" : "chevD"} size={11} strokeWidth={2} />}
        </button>
      ) : label}
    </th>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-2 text-[12.5px] text-ink">
          <span className={`dot ${regimeDot}`} />
          {regimeLabel} tilt
        </span>
        <span className="text-[11.5px] text-ink-3">
          {data?.builtAt
            ? `own factor model over the S&P 500 + TSX 60, tilted for the current regime (${weightsLine}) · universe built ${new Date(data.builtAt).toLocaleDateString()}`
            : "self-computed screen — populates after the weekly factor-universe build"}
        </span>
        <div className="seg ml-auto" role="group" aria-label="Currency">
          {(["All", "CAD", "USD"] as const).map((c) => (
            <button key={c} onClick={() => setCcy(c)} className={ccy === c ? "on" : ""}>
              {c}
              {c !== "All" && <span className="c">{c === "CAD" ? cadCount : usdCount}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Sector heat strip — where the market's momentum is, from the same
          universe (median 12-1m momentum per GICS sector). */}
      {(data?.sectors?.length ?? 0) > 0 && (
        <div className="panel flex items-stretch overflow-x-auto">
          {data!.sectors.map((s, i) => {
            const v = s.medMom12;
            const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
            return (
              <div
                key={s.sector}
                title={`Median 12-1m momentum ${v == null ? "n/a" : `${v.toFixed(1)}%`} · 6-1m ${s.medMom6 == null ? "n/a" : `${s.medMom6.toFixed(1)}%`} · ${s.n} names`}
                className={`flex min-w-0 flex-1 flex-col px-3 py-2 ${i < data!.sectors.length - 1 ? "border-r border-line-soft" : ""}`}
              >
                <span className="truncate text-[11px] text-ink-3">{s.sector}</span>
                <span className={`mt-0.5 font-mono text-[13px] font-medium tabular-nums ${cls}`}>{v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}</span>
              </div>
            );
          })}
        </div>
      )}

      <section className="panel">
        <div className="panel-h">
          <span className="t">Radar</span>
          <span className="m">top regime-fit names not yet tracked · sorted by {SORT_LABEL[sortKey] ?? sortKey}</span>
        </div>
        {loading ? (
          <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState
            className="!py-8"
            glyph={<AppIcon name="spark" size={18} />}
            title="Nothing on the radar"
            body={data?.hint ?? "No names to show — every screened name is already tracked."}
          />
        ) : (
          <div className="tbl-wrap">
            <table className="data-table min-w-[760px]">
              <thead>
                <tr>
                  <Th id="ticker" label="Ticker" className="pl-3.5" />
                  <Th label="Name" />
                  <Th id="sector" label="Sector" />
                  <Th id="fit" label="Regime fit" className="n" title="Percentile under the current regime's factor tilts" />
                  <Th id="quant" label="Quant" className="n" title="Baseline quant percentile (untilted weights)" />
                  {GROUP_ORDER.map((g) => (
                    <Th key={g} label={GROUP_SHORT[g]} className="n" title={`Mean sector-neutral z, ${g}`} />
                  ))}
                  <Th id="conf" label="Conf" className="n" title="Data coverage × cross-group agreement" />
                  <th className="pr-3.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((n) => (
                  <tr key={n.ticker}>
                    <td className="pl-3.5">
                      <TickerLink ticker={n.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(n.ticker)}</TickerLink>
                      {n.distress === "grey" && (
                        <span
                          title={`Altman-style Z ${n.altmanZ ?? "?"} — grey zone; balance sheet warrants a look`}
                          className="ml-2 inline-flex items-center gap-1 text-[11px] text-warn"
                        >
                          <span className="dot bg-warn" />Z grey
                        </span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate text-[12px] text-ink-3">{names[n.ticker] || "—"}</td>
                    <td className="text-[12px] text-ink-2">{n.sector}</td>
                    <td className="n font-medium">{n.regimeFit}</td>
                    <td className="n text-ink-2">{n.quant}</td>
                    {GROUP_ORDER.map((g) => {
                      const z = n.groups[g];
                      return (
                        <td key={g} className={`n ${z == null ? "text-ink-faint" : z >= 0 ? "text-pos" : "text-neg"}`}>
                          {z == null ? "—" : `${z > 0 ? "+" : ""}${z.toFixed(1)}`}
                        </td>
                      );
                    })}
                    <td className="n text-ink-3">{n.confidence}</td>
                    <td className="pr-3.5 text-right">
                      {held(n.ticker) ? (
                        <span className="text-[11.5px] text-ink-faint">Tracked</span>
                      ) : (
                        <button
                          onClick={() => promote(n)}
                          disabled={adding === n.ticker}
                          className="inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                        >
                          <AppIcon name="plus" size={11} strokeWidth={2.25} />{adding === n.ticker ? "…" : "Watchlist"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && sorted.length > 0 && (
          <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
            {sorted.length} of {all.length} · {cadCount} CAD · {usdCount} USD
          </div>
        )}
      </section>
    </div>
  );
}
