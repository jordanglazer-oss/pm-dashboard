"use client";

import React, { useEffect, useMemo, useState } from "react";
import TickerLink from "@/app/components/TickerLink";
import { displayTicker } from "@/app/lib/ticker";
import { useStocks } from "@/app/lib/StockContext";
import { FAVOUR_LABEL, type FavourGroup, type FavourRead, type FavourState } from "@/app/lib/favour";

/**
 * In favour / out of favour panel (Nov 2026, meeting item 10) — read-only.
 * Relative performance vs the S&P 500 over 1 / 3 / 6 / 12 months and the
 * distance from the 52-week high, for the stocks we own, the watchlist and
 * names on 2+ research lists. Data from GET /api/favour-monitor (12h cache).
 * The group filter persists in pm:ui-prefs.
 */

type Row = { ticker: string; name: string; group: FavourGroup; lists?: number; note: string } & FavourRead;
type Payload = { at: string; rows: Row[]; error?: string };
type Filter = "All" | FavourGroup;

const PREF = "favour.group";
const ORDER: FavourState[] = ["out", "recovering", "slipping", "in", "neutral", "thin"];
const TONE: Record<FavourState, string> = { in: "text-pos", recovering: "text-accent", neutral: "text-ink-2", slipping: "text-warn", out: "text-neg", thin: "text-ink-3" };
const pts = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);

export default function FavourMonitor() {
  const { uiPrefs, setUiPref } = useStocks();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const filter = ((uiPrefs[PREF] as Filter) || "All") as Filter;

  useEffect(() => {
    let alive = true;
    fetch("/api/favour-monitor", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Payload) => { if (alive) setData(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => filter === "All" || r.group === filter);
    return [...list].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.rel.m6 ?? 0) - (b.rel.m6 ?? 0));
  }, [data, filter]);
  const count = (s: FavourState) => rows.filter((r) => r.state === s).length;

  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">In favour / out of favour</span>
        <span className="m font-mono">{rows.length}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5 text-[11.5px] text-ink-3">
        <div className="seg" title="Which names">
          {(["All", "Portfolio", "Watchlist", "Ranked"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setUiPref(PREF, f)} className={filter === f ? "on" : ""} aria-pressed={filter === f}>{f === "Ranked" ? "On 2+ lists" : f}</button>
          ))}
        </div>
        <span><span className="font-mono text-ink">{count("out")}</span> out of favour</span>
        <span><span className="font-mono text-ink">{count("recovering")}</span> coming back</span>
        <span><span className="font-mono text-ink">{count("in")}</span> in favour</span>
        <span>Versus the S&amp;P 500 (price index), in points; prices only, no score.</span>
        {data?.at && <span>Read {new Date(data.at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span>}
        {data?.error && <span className="text-warn">{data.error}</span>}
      </div>
      {!data && !failed && <p className="px-3.5 pb-3.5 text-[12.5px] text-ink-3">Reading a year of prices for each name — the first load can take up to a minute.</p>}
      {failed && <p className="px-3.5 pb-3.5 text-[12.5px] text-neg">Could not load the read. Refresh to try again.</p>}
      {data && rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="data-table min-w-[860px]">
            <thead>
              <tr>
                <th className="!pl-3.5">Ticker</th>
                <th>Name</th>
                <th>Where</th>
                <th>Read</th>
                <th className="n" title="Return minus the S&P 500's, last month, in points">1m</th>
                <th className="n">3m</th>
                <th className="n">6m</th>
                <th className="n">12m</th>
                <th className="n" title="Last close versus the highest close of the past year">From high</th>
                <th className="!pr-3.5">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.group}-${r.ticker}`}>
                  <td className="!pl-3.5"><TickerLink ticker={r.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink></td>
                  <td className="max-w-[180px] truncate" title={r.name}>{r.name || "—"}</td>
                  <td><span className="text-[12px] text-ink-2">{r.group === "Ranked" ? `${r.lists} lists` : r.group}</span></td>
                  <td><span className={`text-[12px] font-medium ${TONE[r.state]}`}>{FAVOUR_LABEL[r.state]}</span></td>
                  <td className="n font-mono">{pts(r.rel.m1)}</td>
                  <td className="n font-mono">{pts(r.rel.m3)}</td>
                  <td className="n font-mono">{pts(r.rel.m6)}</td>
                  <td className="n font-mono">{pts(r.rel.m12)}</td>
                  <td className="n font-mono">{r.fromHighPct == null ? "—" : `${r.fromHighPct.toFixed(0)}%`}</td>
                  <td className="!pr-3.5 !whitespace-normal">
                    <span className="text-[12px] text-ink-2">{r.note ? <span className="text-ink">{r.note}. </span> : null}{r.reasons.join("; ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
