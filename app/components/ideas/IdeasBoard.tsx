"use client";

/**
 * Ideas (rebuilt, Nov 26 2026): ONE list — watchlist, Suggested and every
 * research list — with source tags, the number of lists a name is on and the
 * same signal grid as Holdings. No sector filter; no limit on names.
 *
 * READ-ONLY apart from the pins (pm:ui-prefs `ideas.pinned`). Names off every
 * list for 90+ days move to the archive view below; nothing is deleted.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { Stock } from "@/app/lib/types";
import { rankResearch } from "@/app/lib/research-ranked";
import type { RankedHistory } from "@/app/lib/ranked-source-history";
import type { ResearchState } from "@/app/lib/defaults";
import { buildIdeas } from "@/app/lib/ideas";
import { SIGNAL_CONFIG } from "@/app/lib/signal-config";
import type { SignalKey } from "@/app/lib/signals";
import { Explain } from "@/app/components/Explain";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { useGet } from "@/app/components/redesign/data";
import { Card, Empty, Page, todayET } from "@/app/components/redesign/ui";
import { SignalCells, SignalDetail, SignalHead, signalsFor, useSignalFundamentals } from "@/app/components/signals/SignalGrid";

const TH = "border-b border-line px-2 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-3";
const TD = "border-b border-line-soft px-2 py-2 align-middle text-[13.5px]";
type SortKey = "positives" | "lists" | "name";
const rootOf = (t: string) => t.trim().toUpperCase().replace(/(-T|\.TO|\.U|-U\.TO)$/i, "");

export default function IdeasBoard() {
  const { stocks, analystSnapshots, uiPrefs, setUiPref } = useStocks();
  const research = useGet<Partial<ResearchState>>("/api/kv/research", (raw) => (raw as { research?: Partial<ResearchState> })?.research ?? null);
  const suggested = useGet<Stock[]>("/api/kv/stocks-suggested", (raw) => (raw as { stocks?: Stock[] })?.stocks ?? null);
  const history = useGet<RankedHistory>("/api/ranked-source-history", (raw) => ((raw as { history?: RankedHistory })?.history ?? (raw as RankedHistory)) || null);
  const fundamentals = useSignalFundamentals();
  const movers = useGet<{ date: string | null; movers: { ticker: string; wChg?: number; smax?: number | null; sector?: string | null }[] }>("/api/sia-universe");
  const [sort, setSort] = useState<SortKey>("positives");
  const [open, setOpen] = useState<{ key: string; signal: SignalKey } | null>(null);
  const [archiveOpen, toggleArchive] = usePersistedOpen("ideas.archive", false);

  const pinned = useMemo(() => (uiPrefs["ideas.pinned"] ?? "").split(",").map((s) => s.trim()).filter(Boolean), [uiPrefs]);
  const togglePin = (key: string) => setUiPref("ideas.pinned", (pinned.includes(key) ? pinned.filter((p) => p !== key) : [...pinned, key]).join(","));

  const ideas = useMemo(() => {
    const ranked = rankResearch(research.data ?? {}, stocks);
    return buildIdeas({ ranked, watchlist: stocks.filter((s) => s.bucket === "Watchlist"), suggested: suggested.data ?? [], history: history.data?.tickers ? history.data : null, pinned, today: todayET(), dropAfterDays: SIGNAL_CONFIG.ideas.dropAfterDays, movers: movers.data?.movers ?? [], held: stocks.filter((s) => s.bucket === "Portfolio").map((s) => s.ticker) });
  }, [research.data, stocks, suggested.data, history.data, pinned, movers.data]);

  const rows = useMemo(() => {
    const pool = [...stocks, ...(suggested.data ?? [])];
    const withSignals = ideas.map((i) => {
      const stock = pool.find((s) => rootOf(s.ticker) === i.key);
      return { i, stock, set: signalsFor(stock, analystSnapshots, fundamentals) };
    });
    const by = (a: (typeof withSignals)[number], b: (typeof withSignals)[number]) =>
      sort === "name" ? a.i.name.localeCompare(b.i.name) : sort === "lists" ? b.i.listCount - a.i.listCount || (b.set?.positives ?? -1) - (a.set?.positives ?? -1) : (b.set?.positives ?? -1) - (a.set?.positives ?? -1) || b.i.listCount - a.i.listCount;
    return { active: withSignals.filter((r) => !r.i.stale).sort(by), archived: withSignals.filter((r) => r.i.stale).sort(by) };
  }, [ideas, stocks, suggested.data, analystSnapshots, sort, fundamentals]);

  const table = (list: typeof rows.active) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            <th className={TH}>Name</th>
            <th className={TH}>Where it came from</th>
            <th className={`${TH} text-center`} title="Bullish research lists it is on now">Lists</th>
            <SignalHead />
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {list.map(({ i, stock, set }) => {
            const isOpen = open?.key === i.key;
            return (
              <React.Fragment key={i.key}>
                <tr className={isOpen ? "bg-surface-2" : undefined}>
                  <td className={TD}>
                    {stock ? <Link href={`/stock/${encodeURIComponent(stock.ticker.toLowerCase())}`} className="font-semibold !text-ink hover:underline">{i.name}</Link> : <span className="font-semibold text-ink">{i.name}</span>}
                    <div className="text-[12px] tabular-nums text-ink-3">{i.ticker}{i.sector ? ` · ${i.sector}` : ""}</div>
                  </td>
                  <td className={TD}>
                    <div className="flex max-w-[330px] flex-wrap gap-1">
                      {i.sources.map((s) => <span key={s} className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${s === "Watchlist" ? "border-accent/40 bg-accent/10 text-ink" : s === "SIA mover" ? "border-pos/30 bg-pos-soft text-pos" : "border-line bg-surface-2 text-ink-2"}`}>{s}</span>)}
                      {i.bearish.map((s) => <span key={`b-${s}`} className="whitespace-nowrap rounded-full border border-neg/30 bg-neg-soft px-2 py-0.5 text-[11.5px] font-medium text-neg" title="On a bearish list">{s}</span>)}
                    </div>
                  </td>
                  <td className={`${TD} text-center text-[14px] font-semibold tabular-nums`}>{i.listCount}</td>
                  <SignalCells set={set} openKey={isOpen ? open!.signal : null} onOpen={(k) => setOpen(isOpen && open!.signal === k ? null : { key: i.key, signal: k })} />
                  <td className={`${TD} text-right`}>
                    <button type="button" onClick={() => togglePin(i.key)} aria-pressed={i.pinned} title={i.pinned ? "Pinned: stays in the list" : "Pin to keep it in the list"} className={`h-7 rounded-control border px-2.5 text-[12.5px] font-medium ${i.pinned ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>{i.pinned ? "Pinned" : "Pin"}</button>
                  </td>
                </tr>
                {isOpen && set && (
                  <tr>
                    <td colSpan={9} className="border-b border-line bg-surface-2 px-4 py-3"><SignalDetail k={open!.signal} s={set[open!.signal]} /></td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const sortBtn = (k: SortKey, label: string) => (
    <button key={k} type="button" onClick={() => setSort(k)} className={`h-8 rounded-control border px-3 text-[13px] font-semibold ${sort === k ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>{label}</button>
  );
  const loading = research.loading || suggested.loading;

  return (
    <Page title="Ideas" lede="One list: every name we don't own, from every source." right={<>{sortBtn("positives", "By positive signals")}{sortBtn("lists", "By number of lists")}{sortBtn("name", "A to Z")}</>}>
      <Card title="Active ideas" sub={`${rows.active.length} names · no sector filter`} pad={false}>
        {rows.active.length ? table(rows.active) : <div className="px-5 py-3"><Empty>{loading ? "Loading…" : "No ideas on file yet."}</Empty></div>}
        <div className="flex flex-col gap-1.5 px-5 py-3">
          <div className="text-[13px] text-ink-2">Add a name by hand: use <span className="font-semibold">+ Add</span> at the top right and choose Watchlist. Target buy price and notes are on the <Link href="/watchlist" className="font-semibold !text-accent underline">watchlist page</Link>.</div>
          <Explain prefKey="explain.ideas.rules" label="How this list is built">
            <p>Sources: our watchlist, the Suggested names, and every research list on file (Fundstrat, RBC, J.P. Morgan, Seeking Alpha, Veritas, Equate). &ldquo;Lists&rdquo; counts the bullish lists a name is on now; a red tag marks a bearish list and is never counted.</p>
            <p className="mt-1">&ldquo;SIA mover&rdquo; = gaining relative strength in the latest SIA export{movers.data?.date ? ` (${movers.data.date})` : ""}. The SIA ranking itself is the Rel. strength signal, and the Market Edge opinion is inside Technicals. Market Edge lists and Ophir Gottlieb are not yet separate sources (source pending).</p>
            <p className="mt-1">A name off every list for more than {SIGNAL_CONFIG.ideas.dropAfterDays} days moves to the archive below unless it is pinned. Signals without a stock record on file read &ldquo;n/a&rdquo;.</p>
          </Explain>
        </div>
      </Card>

      <Card title="Archive" sub={`${rows.archived.length} names off every list for over ${SIGNAL_CONFIG.ideas.dropAfterDays} days`} right={<button type="button" onClick={toggleArchive} aria-expanded={archiveOpen} className="h-8 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-hover">{archiveOpen ? "Hide" : "Show"}</button>} pad={false}>
        {archiveOpen && (rows.archived.length ? table(rows.archived) : <div className="px-5 py-3"><Empty>Nothing archived.</Empty></div>)}
      </Card>
    </Page>
  );
}
