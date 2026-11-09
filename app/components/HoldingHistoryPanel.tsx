"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { HoldingHistory } from "@/app/lib/holding-history-shared";

/**
 * Each PIM holding's return since first purchase, and every later buy / sell
 * decision with how it has done since (GET /api/holding-history).
 */

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = (v: number | null | undefined) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");
const w = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);
const KIND_LABEL = { bought: "Bought", "raised target": "Raised target", "cut target": "Cut target", rebalanced: "Rebalanced", "sold out": "Sold out" } as const;

export function HoldingHistoryPanel() {
  const [data, setData] = useState<{ holdings: HoldingHistory[]; trackingStart: string | null; error?: string } | null>(null);
  const [open, toggle] = usePersistedOpen("aa.holdingHistory.open", true);
  const [showSold, toggleSold] = usePersistedOpen("aa.holdingHistory.sold", false);
  const [showRebal, toggleRebal] = usePersistedOpen("aa.holdingHistory.rebalances", false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open || data) return;
    let live = true;
    fetch("/api/holding-history")
      .then((r) => r.json())
      .then((d) => live && setData(d))
      .catch(() => live && setData({ holdings: [], trackingStart: null, error: "Could not load." }));
    return () => {
      live = false;
    };
  }, [open, data]);

  const rows = (data?.holdings ?? []).filter((h) => h.held || showSold);
  const soldCount = (data?.holdings ?? []).filter((h) => !h.held).length;
  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Holdings since first purchase</span>
        <span className="m">PIM model · each buy and sell decision since · {open ? "hide" : "show"}</span>
      </button>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-[12.5px] text-ink-3">
            <span>Price return is from the recorded fill; total return adds dividends (adjusted closes). A name with no buy on file starts at tracking start{data?.trackingStart ? ` (${data.trackingStart})` : ""}.</span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showSold} onChange={toggleSold} /> Show names sold out ({soldCount})
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showRebal} onChange={toggleRebal} /> Include rebalance-only trades
            </label>
          </div>
          {!data ? (
            <div className="px-3.5 pb-3 text-[12.5px] text-ink-3">Loading prices since each first purchase…</div>
          ) : data.error && !rows.length ? (
            <div className="px-3.5 pb-3 text-[12.5px] text-neg">{data.error}</div>
          ) : (
            <div className="tbl-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Holding</th>
                    <th>First bought</th>
                    <th className="n">First price</th>
                    <th className="n">Price now</th>
                    <th className="n">Since first (price)</th>
                    <th className="n">Since first (total)</th>
                    <th className="n">Weight now</th>
                    <th className="n">Decisions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => {
                    const ds = h.decisions.filter((d) => showRebal || d.kind !== "rebalanced");
                    const isOpen = expanded === h.symbol;
                    return (
                      <React.Fragment key={h.symbol}>
                        <tr className="cursor-pointer" onClick={() => setExpanded(isOpen ? null : h.symbol)}>
                          <td className="pl-3.5">
                            <Link href={`/stock/${encodeURIComponent(h.symbol)}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-ink hover:text-accent">
                              {displayTicker(h.symbol)}
                            </Link>
                            {h.name && <span className="ml-2 text-[12px] text-ink-3">{h.name}</span>}
                            {!h.held && <span className="ml-2 text-[11.5px] text-ink-3">sold {h.exitDate}</span>}
                          </td>
                          <td className="font-mono text-ink-2">
                            {h.firstDate}
                            {!h.firstFromLog && <span className="ml-1 text-[11px] text-ink-faint">(tracking start)</span>}
                          </td>
                          <td className="n">{h.firstPrice != null ? h.firstPrice.toFixed(2) : "—"}</td>
                          <td className="n">{h.price != null ? h.price.toFixed(2) : "—"}</td>
                          <td className={`n ${tone(h.sinceFirstPricePct)}`}>{fmt(h.sinceFirstPricePct)}</td>
                          <td className={`n ${tone(h.sinceFirstTotalPct)}`}>{fmt(h.sinceFirstTotalPct)}</td>
                          <td className="n">{w(h.currentWeight)}</td>
                          <td className="n">
                            {ds.length} {isOpen ? "▴" : "▾"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={8} className="!whitespace-normal">
                              <div className="rounded-control bg-surface-2 px-3 py-2">
                              {ds.length === 0 ? (
                                <span className="text-[12.5px] text-ink-3">No {showRebal ? "" : "target-changing "}trades on file.</span>
                              ) : (
                                <table className="w-full text-[12.5px]">
                                  <thead>
                                    <tr className="text-ink-3">
                                      <th className="py-1 text-left font-normal">Date</th>
                                      <th className="text-left font-normal">Decision</th>
                                      <th className="text-right font-normal">Fill</th>
                                      <th className="text-right font-normal">Target after</th>
                                      <th className="text-right font-normal">Since (price)</th>
                                      <th className="text-right font-normal">Since (total)</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ds.map((d, i) => (
                                      <tr key={i}>
                                        <td className="py-0.5 font-mono">{d.date}</td>
                                        <td>
                                          {KIND_LABEL[d.kind]}
                                          {d.pending && <span className="ml-1 text-ink-3">(pending NAV)</span>}
                                          {d.notes && <span className="ml-1 text-ink-3">— {d.notes}</span>}
                                        </td>
                                        <td className="text-right">{d.price != null ? d.price.toFixed(2) : "—"}</td>
                                        <td className="text-right">{w(d.target)}</td>
                                        <td className={`text-right ${tone(d.sincePricePct)}`}>{fmt(d.sincePricePct)}</td>
                                        <td className={`text-right ${tone(d.sinceTotalPct)}`}>{fmt(d.sinceTotalPct)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
