"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { PageHeading } from "@/app/components/PageHeading";
import { EmptyState } from "@/app/components/EmptyState";
import { AppIcon } from "@/app/components/AppIcon";
import TickerLink from "@/app/components/TickerLink";
import FavourMonitor from "@/app/components/FavourMonitor";
import { ContrarianChip, useContrarianBook } from "@/app/components/ContrarianTile";
import { displayTicker } from "@/app/lib/ticker";
import { addedByOptions, watchRows, type WatchlistPlan, type WatchRow } from "@/app/lib/watchlist-plan";

/**
 * /watchlist — the watchlist as a decision tool (Nov 2026, meeting item 8):
 * why we would own each name, the price we would pay, what would make us
 * drop it, and when / by whom / at what price it was added. Sorted with the
 * names DOWN THE MOST since added first — we buy quality when it is out of
 * favour. Every field is optional and typed in by the PM; nothing is filled
 * in automatically. Saves ONE stock's `watch` object through the existing
 * `updateStockFields` path. An alert is raised (Monitor + the end-of-day
 * email) when a name trades at or below its target buy price.
 */

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";
const INPUT = "h-7 w-full rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink";
const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const signed = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function Editor({ row, names, onSave, onCancel }: { row: WatchRow; names: string[]; onSave: (plan: WatchlistPlan) => void; onCancel: () => void }) {
  const [thesis, setThesis] = useState(row.plan.thesis ?? "");
  const [breakers, setBreakers] = useState(row.plan.breakers ?? "");
  const [target, setTarget] = useState(row.plan.targetBuyPrice != null ? String(row.plan.targetBuyPrice) : "");
  const [addedOn, setAddedOn] = useState(row.plan.addedOn ?? "");
  const [priceAtAdd, setPriceAtAdd] = useState(row.plan.priceAtAdd != null ? String(row.plan.priceAtAdd) : "");
  const [addedBy, setAddedBy] = useState(row.plan.addedBy ?? "");
  const num = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const save = () => {
    const plan: WatchlistPlan = {};
    if (thesis.trim()) plan.thesis = thesis.trim();
    if (breakers.trim()) plan.breakers = breakers.trim();
    if (num(target) != null) plan.targetBuyPrice = num(target);
    if (/^\d{4}-\d{2}-\d{2}$/.test(addedOn)) plan.addedOn = addedOn;
    if (num(priceAtAdd) != null) plan.priceAtAdd = num(priceAtAdd);
    if (addedBy.trim()) plan.addedBy = addedBy.trim();
    onSave(plan);
  };
  const listId = `added-by-${row.ticker}`;
  return (
    <div className="grid gap-3 bg-surface-2 p-3.5 md:grid-cols-2">
      <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
        Why we would own it (a few reasons)
        <textarea value={thesis} onChange={(e) => setThesis(e.target.value)} rows={4} className="rounded-control border border-line bg-surface p-2 text-[12.5px] text-ink" />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
        What would make us drop it
        <textarea value={breakers} onChange={(e) => setBreakers(e.target.value)} rows={4} className="rounded-control border border-line bg-surface p-2 text-[12.5px] text-ink" />
      </label>
      <div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Target buy price
          <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={row.price != null ? `now ${fmt(row.price)}` : ""} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Date added
          <input type="date" value={addedOn} onChange={(e) => setAddedOn(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Price when added
          <input inputMode="decimal" value={priceAtAdd} onChange={(e) => setPriceAtAdd(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Added by
          <input list={listId} value={addedBy} onChange={(e) => setAddedBy(e.target.value)} className={INPUT} />
          <datalist id={listId}>{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <button onClick={save} className={`${BTN} !border-accent-border !bg-accent-soft`}><span className="text-accent">Save</span></button>
        <button onClick={onCancel} className={BTN}>Cancel</button>
        {row.price != null && (
          <button
            onClick={() => { setAddedOn(today()); setPriceAtAdd(String(row.price)); }}
            className={BTN}
            title="Use today's date and the current price as the 'added' point — only for a name added today"
          >
            Added today at {fmt(row.price)}
          </button>
        )}
        <span className="text-[11.5px] text-ink-3">The target is your number — nothing sets it automatically. Leave the date blank if it is not known.</span>
      </div>
    </div>
  );
}

export default function WatchlistPage() {
  const { stocks, updateStockFields } = useStocks();
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const contrarian = useContrarianBook(); // read-only contrarian read-out; never part of the score

  const tickers = useMemo(() => stocks.filter((s) => s.bucket === "Watchlist").map((s) => s.ticker), [stocks]);
  const tickerKey = tickers.join(",");
  useEffect(() => {
    if (!tickerKey) return;
    let alive = true;
    fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: tickerKey.split(",") }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.prices) setPrices(d.prices); })
      .catch(() => {});
    return () => { alive = false; };
  }, [tickerKey]);

  const rows = useMemo(() => watchRows(stocks, prices), [stocks, prices]);
  const names = useMemo(() => addedByOptions(stocks), [stocks]);
  const atTarget = rows.filter((r) => r.atTarget).length;
  const planned = rows.filter((r) => r.plan.targetBuyPrice != null).length;

  return (
    <main className="min-h-screen overflow-x-hidden bg-ground text-ink">
      <PageHeading
        title="Watchlist"
        lede="Why we would own each name, the price we would pay, and what would make us drop it. Names down the most since they were added come first."
        actions={<Link href="/research" className={BTN}>Ranked research</Link>}
      />
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
          <span><span className="font-mono text-ink">{rows.length}</span> on the watchlist</span>
          <span><span className="font-mono text-ink">{planned}</span> with a target buy price</span>
          <span><span className={`font-mono ${atTarget ? "text-pos" : "text-ink"}`}>{atTarget}</span> at or below target</span>
          <span>An alert goes to Monitor and the end-of-day email when a name reaches its target.</span>
        </div>
        <section className="panel">
          <div className="panel-h">
            <span className="t">Watchlist plan</span>
            <span className="m font-mono">{rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <EmptyState className="!py-8" glyph={<AppIcon name="list" size={18} />} title="Nothing on the watchlist" body="Add names from Ranked research or the Portfolio page." />
          ) : (
            <div className="tbl-wrap">
              <table className="data-table min-w-[900px]">
                <thead>
                  <tr>
                    <th className="!pl-3.5">Ticker</th>
                    <th>Name</th>
                    <th className="n">Price</th>
                    <th className="n" title="Change since the price when it was added">Since added</th>
                    <th className="n">Target buy</th>
                    <th className="n" title="How far the price is above the target buy price">To target</th>
                    <th>Added</th>
                    <th>Why own it</th>
                    <th className="n !pr-3.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <React.Fragment key={r.ticker}>
                      <tr>
                        <td className="!pl-3.5">
                          <TickerLink ticker={r.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink>
                          {r.atTarget && <span className="ml-1.5 text-[11px] font-medium text-pos" title="Trading at or below the target buy price">At target</span>}
                          <ContrarianChip ticker={r.ticker} rows={contrarian} />
                        </td>
                        <td className="max-w-[200px] truncate" title={r.name}>{r.name || "—"}</td>
                        <td className="n font-mono">{fmt(r.price)}</td>
                        <td className="n"><span className={`font-mono ${r.sinceAddPct == null ? "text-ink-3" : r.sinceAddPct < 0 ? "text-neg" : "text-pos"}`}>{signed(r.sinceAddPct)}</span></td>
                        <td className="n font-mono">{fmt(r.plan.targetBuyPrice)}</td>
                        <td className="n"><span className={`font-mono ${r.aboveTargetPct == null ? "text-ink-3" : r.atTarget ? "text-pos" : "text-ink-2"}`}>{signed(r.aboveTargetPct)}</span></td>
                        <td><span className="text-[12px] text-ink-2">{r.plan.addedOn ?? "—"}{r.plan.addedBy ? ` · ${r.plan.addedBy}` : ""}</span></td>
                        <td className="max-w-[280px] truncate" title={[r.plan.thesis, r.plan.breakers ? `Drop it if: ${r.plan.breakers}` : ""].filter(Boolean).join("\n")}>
                          <span className="text-ink-2">{r.plan.thesis || "—"}</span>
                        </td>
                        <td className="!pr-3.5 !text-right">
                          <button onClick={() => setEditing(editing === r.ticker ? null : r.ticker)} className="text-[12px] text-accent hover:underline">
                            {editing === r.ticker ? "Close" : r.plan.thesis || r.plan.targetBuyPrice != null ? "Edit" : "Add plan"}
                          </button>
                        </td>
                      </tr>
                      {editing === r.ticker && (
                        <tr>
                          <td colSpan={9} className="!p-0">
                            <Editor
                              row={r}
                              names={names}
                              onCancel={() => setEditing(null)}
                              onSave={(plan) => { updateStockFields(r.ticker, { watch: plan }); setEditing(null); }}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex h-8 items-center px-3.5 text-[11.5px] text-ink-3">Sorted by change since added, most down first · prices in each stock&apos;s trading currency</div>
        </section>
        <FavourMonitor />
      </div>
    </main>
  );
}
