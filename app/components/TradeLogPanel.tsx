"use client";

/**
 * Performance › Trade log (Nov 2026): every buy, add, trim and sale for a
 * mandate from its SIA transaction log, with the realized gain on each sale
 * against average cost. READ-ONLY (GET /api/trade-log). The mandate and the
 * kind filter persist in pm:ui-prefs.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { tickerMatch } from "@/app/lib/rebalance";
import { Explain } from "@/app/components/Explain";
import TickerLink from "@/app/components/TickerLink";

type Row = { date: string; symbol: string; kind: "Bought" | "Added" | "Trimmed" | "Sold"; units: number; price: number; amount: number; avgCost: number | null; gainPct: number | null; gain: number | null; note?: string };
type Summary = { trades: number; bought: number; added: number; trimmed: number; sold: number; realized: number; proceeds: number; salesNotCounted: number };
type Data = { onFile: boolean; book?: string; bookLabel?: string; ownLog?: boolean; through?: string; mandates: { id: string; label: string }[]; years: string[]; year?: string; summary?: Summary; rows: Row[] };

const money = (v: number) => (v < 0 ? "−" : "") + "C$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const KINDS = ["All", "Bought", "Added", "Trimmed", "Sold"];
const SEL = "h-8 rounded-control border border-line bg-surface px-2 text-[13px] text-ink";

export function TradeLogPanel() {
  const { stocks, uiPrefs, setUiPref } = useStocks();
  const mandate = uiPrefs["perf.tradelog.mandate"] || "allEquity";
  const kind = KINDS.includes(uiPrefs["perf.tradelog.kind"] ?? "") ? uiPrefs["perf.tradelog.kind"] : "All";
  const [year, setYear] = useState<string>("");
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/trade-log?mandate=" + encodeURIComponent(mandate) + (year ? "&year=" + year : ""))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Data) => {
        if (!alive) return;
        setData(d);
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [mandate, year]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => kind === "All" || r.kind === kind), [data, kind]);
  const nameOf = (sym: string) => stocks.find((s) => tickerMatch(s.ticker, sym))?.name ?? "";
  const s = data?.summary;
  const costSold = s ? s.proceeds - s.realized : 0;

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5">
        <span className="t">Trade log</span>
        <span className="m">from the SIA transaction log{data?.through ? " · trades through " + data.through : ""}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select aria-label="Mandate" className={SEL} value={data?.book ?? mandate} onChange={(e) => setUiPref("perf.tradelog.mandate", e.target.value)}>
            {(data?.mandates?.length ? data.mandates : [{ id: mandate, label: mandate }]).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select aria-label="Year" className={SEL} value={data?.year ?? year} onChange={(e) => setYear(e.target.value)}>
            {(data?.years ?? []).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select aria-label="Kind of trade" className={SEL} value={kind} onChange={(e) => setUiPref("perf.tradelog.kind", e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>{k === "All" ? "All trades" : k}</option>
            ))}
          </select>
        </div>
      </div>
      {failed ? (
        <p className="px-3.5 py-3 text-[12.5px] text-neg">The trade log could not be loaded.</p>
      ) : !data ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
      ) : !data.onFile ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-2">No SIA transaction log is on file.</p>
      ) : (
        <>
          {data.ownLog === false && <p className="border-b border-line-soft bg-warn-soft px-3.5 py-2 text-[12.5px] text-ink">That mandate has no log of its own on file; showing the {data.bookLabel} log.</p>}
          {s && (
            <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-line-soft px-3.5 py-3 text-[12.5px]">
              <div><div className="text-ink-3">Trades in {data.year}</div><div className="text-[18px] font-semibold tabular-nums text-ink">{s.trades}</div></div>
              <div><div className="text-ink-3">Bought · Added</div><div className="text-[18px] font-semibold tabular-nums text-ink">{s.bought} · {s.added}</div></div>
              <div><div className="text-ink-3">Trimmed · Sold</div><div className="text-[18px] font-semibold tabular-nums text-ink">{s.trimmed} · {s.sold}</div></div>
              <div>
                <div className="text-ink-3">Realized gain / loss</div>
                <div className={"text-[18px] font-semibold tabular-nums " + (s.realized >= 0 ? "text-pos" : "text-neg")}>{money(s.realized)}</div>
                <div className="text-[11.5px] text-ink-3">{costSold > 0 ? ((s.realized / costSold) * 100).toFixed(1) + "% on the cost of what was sold" : ""}</div>
              </div>
              {s.salesNotCounted > 0 && <div className="text-neg"><div>Sales with no cost on file</div><div className="text-[18px] font-semibold tabular-nums">{s.salesNotCounted}</div></div>}
            </div>
          )}
          <div className="max-h-[560px] overflow-auto">
            <table className="data-table min-w-[820px]">
              <thead>
                <tr>
                  <th className="!pl-3.5">Date</th>
                  <th>Name</th>
                  <th>Trade</th>
                  <th className="n">Units</th>
                  <th className="n">Price C$</th>
                  <th className="n">Average cost C$</th>
                  <th className="n">Gain / loss</th>
                  <th className="n !pr-3.5">C$</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.date + "-" + r.symbol + "-" + i}>
                    <td className="!pl-3.5 whitespace-nowrap tabular-nums">{r.date}</td>
                    <td><TickerLink ticker={r.symbol} className="font-medium text-ink hover:underline">{nameOf(r.symbol) || r.symbol}</TickerLink> <span className="text-ink-3">{nameOf(r.symbol) ? r.symbol : ""}</span></td>
                    <td><span>{r.kind}</span></td>
                    <td className="n">{r.units.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                    <td className="n">{r.price.toFixed(2)}</td>
                    <td className="n">{r.avgCost != null ? r.avgCost.toFixed(2) : r.note ? <span className="text-neg" title={r.note}>not on file</span> : "—"}</td>
                    <td className="n"><span className={r.gainPct == null ? "text-ink-3" : r.gainPct >= 0 ? "text-pos" : "text-neg"}>{r.gainPct == null ? "—" : (r.gainPct >= 0 ? "+" : "−") + Math.abs(r.gainPct).toFixed(1) + "%"}</span></td>
                    <td className="n !pr-3.5"><span className={r.gain == null ? "text-ink-3" : r.gain >= 0 ? "text-pos" : "text-neg"}>{r.gain == null ? "—" : money(r.gain)}</span></td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={8} className="!pl-3.5 text-ink-3">No trades match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-3.5 py-2.5">
            <Explain prefKey="explain.performance.tradelog" label="How the trade log is built">
              <p>Every row is a line in the SIA transaction log for that mandate. Bought = a new position; Added = more of one we held; Trimmed = part sold; Sold = the whole position sold.</p>
              <p className="mt-1">Gain or loss on a sale = sale price against our average cost at that moment, in Canadian dollars (a US holding&apos;s figure includes the currency move). Dividends and fund distributions are not counted. Dollar amounts are the model account&apos;s, not any client&apos;s.</p>
              <p className="mt-1">A sale with no cost on file (a purchase logged at price 0, or sold before the log began) shows no gain and is not in the total.</p>
            </Explain>
          </div>
        </>
      )}
    </section>
  );
}
