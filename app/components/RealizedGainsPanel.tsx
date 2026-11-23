"use client";

import React, { useEffect, useState } from "react";
import { displayTicker } from "@/app/lib/ticker";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import type { RealizedTally } from "@/app/lib/realized-gains";

/**
 * Realized gains / losses, year to date, per book — as % OF THE BOOK, never
 * dollars (GET /api/realized-gains). Read-only; a model-level estimate that
 * only covers sales from 2026-11-19 on, when the units-and-cost record began.
 */

type Resp = RealizedTally & { eventsOnFile?: number; error?: string };

const PROFILE_LABEL: Record<string, string> = { conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity", alpha: "Total Alpha", core: "Core", thematic: "Managed Alpha", stocks: "Individual Stocks" };
const bookName = (groupId: string, profile: string) => `${groupId === "pim" ? "PIM" : groupId} · ${PROFILE_LABEL[profile] ?? profile}`;
const pts = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const tone = (v: number) => (v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

export function RealizedGainsPanel() {
  const [open, toggle] = usePersistedOpen("aa.realizedGains.open", true);
  const [showSales, toggleSales] = usePersistedOpen("aa.realizedGains.sales", false);
  const [showOther, toggleOther] = usePersistedOpen("aa.realizedGains.uncounted", false);
  const [data, setData] = useState<Resp | null>(null);

  useEffect(() => {
    if (!open || data) return;
    let live = true;
    fetch("/api/realized-gains")
      .then((r) => r.json())
      .then((d: Resp) => live && setData(d))
      .catch(() => live && setData({ year: "", coversFrom: "", sales: [], uncounted: [], books: [], error: "Could not load." }));
    return () => {
      live = false;
    };
  }, [open, data]);

  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Realized gains and losses</span>
        <span className="m">Year to date · % of each book, never dollars · model-level estimate · {open ? "hide" : "show"}</span>
      </button>
      {open && (
        <>
          {!data ? (
            <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
          ) : data.error && !data.books.length ? (
            <p className="px-3.5 py-3 text-[12.5px] text-neg">{data.error}</p>
          ) : (
            <>
              <p className="px-3.5 pt-2.5 text-[12px] text-ink-3">
                Model-level estimate for {data.year}: each sale&apos;s gain or loss against its average cost, as a share of the book just before the sale. Only sales from {data.coversFrom} on are covered — units and cost were not recorded before then. Client results differ with each account&apos;s own cost base.
              </p>
              {!data.books.length ? (
                <p className="px-3.5 py-3 text-[12.5px] text-ink-2">No sales recorded yet since {data.coversFrom}. The tally fills in from the next sale.</p>
              ) : (
                <div className="tbl-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="pl-3.5">Book</th>
                        <th className="n">Sold at a gain</th>
                        <th className="n">Sold at a loss</th>
                        <th className="n">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.books.map((b) => (
                        <tr key={`${b.groupId}|${b.profile}`}>
                          <td className="pl-3.5">
                            <span className="font-medium">{bookName(b.groupId, b.profile)}</span>
                          </td>
                          <td className={`n ${tone(b.gainsPct)}`}>
                            {pts(b.gainsPct)} <span className="text-[11px] text-ink-3">({b.soldAtGain})</span>
                          </td>
                          <td className={`n ${tone(b.lossesPct)}`}>
                            {pts(b.lossesPct)} <span className="text-[11px] text-ink-3">({b.soldAtLoss})</span>
                          </td>
                          <td className={`n ${tone(b.netPct)}`}>{pts(b.netPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.sales.length > 0 && (
                <>
                  <button className="px-3.5 py-2 text-[12.5px] text-accent" onClick={toggleSales}>
                    {showSales ? "Hide" : "Show"} each sale ({data.sales.length})
                  </button>
                  {showSales && (
                    <div className="tbl-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="pl-3.5">Date</th>
                            <th>Book</th>
                            <th>Holding</th>
                            <th className="n">Share sold</th>
                            <th className="n">Avg cost C$</th>
                            <th className="n">Sale price C$</th>
                            <th className="n">Gain on cost</th>
                            <th className="n">% of book</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.sales.map((s, i) => (
                            <tr key={`${s.date}-${s.groupId}-${s.profile}-${s.symbol}-${i}`}>
                              <td className="pl-3.5">{s.date}</td>
                              <td>{bookName(s.groupId, s.profile)}</td>
                              <td>
                                <span className="font-medium">{displayTicker(s.symbol)}</span>
                                {s.bookValuedAtCost.length > 0 && <div className="text-[11px] text-ink-3">book partly valued at cost ({s.bookValuedAtCost.length})</div>}
                              </td>
                              <td className="n">{(s.shareSold * 100).toFixed(0)}%</td>
                              <td className="n">{s.avgCostCad.toFixed(2)}</td>
                              <td className="n">{s.salePriceCad.toFixed(2)}</td>
                              <td className={`n ${tone(s.gainOnCostPct)}`}>{pts(s.gainOnCostPct)}</td>
                              <td className={`n ${tone(s.pctOfBook)}`}>{pts(s.pctOfBook)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              {data.uncounted.length > 0 && (
                <>
                  <button className="px-3.5 py-2 text-[12.5px] text-accent" onClick={toggleOther}>
                    {showOther ? "Hide" : "Show"} reductions not counted ({data.uncounted.length})
                  </button>
                  {showOther && (
                    <div className="tbl-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="pl-3.5">Date</th>
                            <th>Book</th>
                            <th>Holding</th>
                            <th className="n">Reduced by</th>
                            <th>Why it is not counted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.uncounted.map((u, i) => (
                            <tr key={`${u.date}-${u.groupId}-${u.profile}-${u.symbol}-${i}`}>
                              <td className="pl-3.5">{u.date}</td>
                              <td>{bookName(u.groupId, u.profile)}</td>
                              <td>{displayTicker(u.symbol)}</td>
                              <td className="n">{(u.shareReduced * 100).toFixed(0)}%</td>
                              <td>
                                <span className="text-[12px] text-ink-3">{u.why}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              <div className="pb-1" />
            </>
          )}
        </>
      )}
    </section>
  );
}
