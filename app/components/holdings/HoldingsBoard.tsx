"use client";

/**
 * Holdings (rebuilt, Nov 26 2026 team session): every current position on one
 * page — the signal grid, the street / RBC / J.P. Morgan targets, and "why we
 * own it" with its history, including positions since sold.
 *
 * READ-ONLY except the "why we own it" points (POST /api/why-we-own, one
 * holding at a time). No aggregate score is shown anywhere on this page.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { tickerMatch } from "@/app/lib/rebalance";
import { getSnapshotForTicker } from "@/app/lib/analyst-snapshots";
import type { SignalKey } from "@/app/lib/signals";
import { whyKey } from "@/app/lib/why-we-own";
import { Explain } from "@/app/components/Explain";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { Card, Empty, Page } from "@/app/components/redesign/ui";
import { SignalCells, SignalDetail, SignalHead, signalsFor, useSignalFundamentals } from "@/app/components/signals/SignalGrid";
import { WhyPanel, useWhyStore } from "@/app/components/holdings/WhyWeOwn";

const TH = "border-b border-line px-2 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-3";
const TD = "border-b border-line-soft px-2 py-2 align-middle text-[13.5px]";
const money = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const RATING: Record<string, string> = { outperform: "Outperform", neutral: "Neutral", underperform: "Underperform", "not-covered": "Not covered" };

type SortKey = "weight" | "name" | "positives";

export default function HoldingsBoard() {
  const { stocks, pimModels, analystSnapshots, loading } = useStocks() as ReturnType<typeof useStocks> & { loading?: boolean };
  const why = useWhyStore();
  const fundamentals = useSignalFundamentals();
  const [open, setOpen] = useState<{ symbol: string; signal: SignalKey | null } | null>(null);
  const [sort, setSort] = useState<SortKey>("weight");
  const [closedOpen, toggleClosed] = usePersistedOpen("holdings.closed", false);

  const group = pimModels.groups.find((g) => g.id === "pim") ?? pimModels.groups[0];
  const rows = useMemo(() => {
    const list = (group?.holdings ?? []).map((h) => {
      const stock = stocks.find((s) => tickerMatch(s.ticker, h.symbol));
      const isStock = !stock?.instrumentType || stock.instrumentType === "stock";
      return { h, stock, isStock: Boolean(stock) && isStock, set: signalsFor(stock, analystSnapshots, fundamentals), snap: stock ? getSnapshotForTicker(analystSnapshots, stock.ticker) : undefined };
    });
    const by = (a: (typeof list)[number], b: (typeof list)[number]) =>
      sort === "name" ? (a.h.name || a.h.symbol).localeCompare(b.h.name || b.h.symbol) : sort === "positives" ? (b.set?.positives ?? -1) - (a.set?.positives ?? -1) || b.h.weightInClass - a.h.weightInClass : b.h.weightInClass - a.h.weightInClass;
    return { stocks: list.filter((r) => r.isStock && r.h.assetClass === "equity").sort(by), funds: list.filter((r) => !(r.isStock && r.h.assetClass === "equity")).sort(by) };
  }, [group, stocks, analystSnapshots, sort, fundamentals]);

  const heldKeys = useMemo(() => new Set((group?.holdings ?? []).map((h) => whyKey(h.symbol))), [group]);
  const closed = useMemo(() => Object.entries(why.store?.entries ?? {}).filter(([k]) => !heldKeys.has(k)), [why.store, heldKeys]);

  const table = (list: typeof rows.stocks, withSignals: boolean) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth: withSignals ? 1180 : 760 }}>
        <thead>
          <tr>
            <th className={TH}>Holding</th>
            <th className={`${TH} text-right`} title="Weight inside its asset class in the model">Weight</th>
            {withSignals && <SignalHead />}
            <th className={`${TH} text-right`}>Street target</th>
            <th className={TH}>RBC</th>
            <th className={TH}>J.P. Morgan</th>
            <th className={TH}>Why we own it</th>
          </tr>
        </thead>
        <tbody>
          {list.map(({ h, stock, set, snap }) => {
            const isOpen = open?.symbol === h.symbol;
            const entry = why.store?.entries[whyKey(h.symbol)];
            const house = (e: { rating?: string; target?: number } | undefined) => (e?.rating ? `${RATING[e.rating] ?? e.rating}${e.target ? ` · ${money(e.target)}` : ""}` : "—");
            return (
              <React.Fragment key={h.symbol}>
                <tr className={isOpen ? "bg-surface-2" : undefined}>
                  <td className={TD}>
                    <Link href={`/stock/${encodeURIComponent(h.symbol.toLowerCase())}`} className="font-semibold !text-ink hover:underline">{h.name || h.symbol}</Link>
                    <div className="text-[12px] tabular-nums text-ink-3">{h.symbol}{stock?.sector ? ` · ${stock.sector}` : ""}</div>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{(h.weightInClass * 100).toFixed(1)}%</td>
                  {withSignals && <SignalCells set={set} openKey={isOpen ? open!.signal : null} onOpen={(k) => setOpen(isOpen && open!.signal === k ? null : { symbol: h.symbol, signal: k })} />}
                  <td className={`${TD} text-right tabular-nums`}>{money(snap?.factset?.averageTarget)}</td>
                  <td className={TD}>{house(snap?.rbc)}</td>
                  <td className={TD}>{house(snap?.jpm)}</td>
                  <td className={TD}>
                    <button type="button" onClick={() => setOpen(isOpen && open!.signal === null ? null : { symbol: h.symbol, signal: null })} aria-expanded={isOpen && open!.signal === null} className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-hover">
                      {!why.store ? "…" : entry ? (entry.status === "approved" ? `${entry.points.length} points` : "Draft: review") : "Not written"}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={withSignals ? 13 : 6} className="border-b border-line bg-surface-2 px-4 py-3">
                      {open!.signal && set ? (
                        <SignalDetail k={open!.signal} s={set[open!.signal]} />
                      ) : (
                        <div className="max-w-[760px]">
                          <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Why we own {h.name || h.symbol}</div>
                          <WhyPanel symbol={h.symbol} why={why} fullHref={`/stock/${encodeURIComponent(h.symbol.toLowerCase())}`} fullLabel="Open the stock / fund page" />
                        </div>
                      )}
                    </td>
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

  return (
    <Page title="Holdings" lede="Every current position: signals, targets and why we own it." right={<>{sortBtn("weight", "By weight")}{sortBtn("positives", "By positive signals")}{sortBtn("name", "A to Z")}</>}>
      <Card title="Individual stocks" sub={`${rows.stocks.length} positions · click a signal for its numbers${fundamentals?.at ? ` · FactSet fundamentals ${fundamentals.at.slice(0, 10)}` : ""}`} pad={false}>
        {fundamentals?.error && <div className="border-b border-line-soft bg-warn-soft px-5 py-2 text-[13px] text-ink">FactSet fundamentals could not be refreshed ({fundamentals.error}). {fundamentals.at ? `Showing the copy from ${fundamentals.at.slice(0, 10)}.` : "Fundamentals read from the figures stored on each stock."}</div>}
        {rows.stocks.length ? table(rows.stocks, true) : <div className="px-5 py-3"><Empty>{loading ? "Loading…" : "No individual stocks in the model."}</Empty></div>}
        <div className="px-5 py-3">
          <Explain prefKey="explain.holdings.signals" label="How the signals are read">
            <p>Six separate reads, each Positive, Neutral or Negative. There is no combined score; &ldquo;Positive&rdquo; counts how many of the signals with data read positive.</p>
            <p className="mt-1">Fundamentals: valuation and quality measures, positive when at least two more read well than read poorly. Analysts: the 30-day trend in estimate revisions (arrow). Upside: average street target against the price, positive above 10%. House: positive only when RBC and J.P. Morgan both rate it positively. Technicals: price against its 50 and 200-day averages, RSI, distance from the 52-week high, Market Edge. Rel. str.: the SIA ranking.</p>
            <p className="mt-1">Fundamentals come from FactSet, refreshed about once a day: P/E against the median of the S&amp;P 500 and TSX 60 and of the company&apos;s sector, net debt to EBITDA, interest coverage, free cash flow margin, return on capital, revenue growth, PEG, and the multiple against its own 5-year average where a FactSet analyst round-up is on file. Banks and insurers get no debt-based measures. FactSet does not supply an average analyst rating on our plan.</p>
            <p className="mt-1">&ldquo;No data&rdquo; means the source is not on file; it is never counted as neutral. The thresholds are starting values in one settings file and have not been confirmed by the team.</p>
          </Explain>
        </div>
      </Card>

      <Card title="Funds and ETFs" sub={`${rows.funds.length} positions · company signals do not apply`} pad={false}>
        {rows.funds.length ? table(rows.funds, false) : <div className="px-5 py-3"><Empty>No funds in the model.</Empty></div>}
      </Card>

      <Card title="Positions since sold" sub={`${closed.length} with reasons on file`} right={<button type="button" onClick={toggleClosed} aria-expanded={closedOpen} className="h-8 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-hover">{closedOpen ? "Hide" : "Show"}</button>}>
        {!closedOpen ? null : closed.length ? (
          <div className="flex flex-col gap-4">
            {closed.map(([k]) => (
              <div key={k}>
                <div className="mb-1 text-[14px] font-semibold text-ink">{k}</div>
                <WhyPanel symbol={k} why={why} />
              </div>
            ))}
          </div>
        ) : (
          <Empty>None yet. When a position leaves the model, its reasons stay here.</Empty>
        )}
        <div className="mt-2 text-[13px] text-ink-3">Earlier theses for sold names are still on the <Link href="/thesis" className="font-semibold !text-accent underline">Thesis page</Link>.</div>
      </Card>
    </Page>
  );
}
