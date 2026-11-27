"use client";

/**
 * Signal grid cells and the detail panel (Nov 26 2026). Shared by Holdings
 * and Ideas. READ-ONLY: built from what is already loaded in the page
 * context (stocks + analyst snapshots); stores nothing.
 */

import React, { useEffect, useState } from "react";
import type { Stock } from "@/app/lib/types";
import { getSnapshotForTicker, type AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import type { NameFundamentals, SignalFundamentals } from "@/app/lib/signal-fundamentals-shared";
import { SIGNAL_COLUMNS, computeSignals, revisionArrow, type Signal, type SignalInput, type SignalKey, type SignalSet, type SignalState } from "@/app/lib/signals";

/** The FactSet fundamentals behind the grid (read-only cache route). */
export function useSignalFundamentals(): SignalFundamentals | null {
  const [data, setData] = useState<SignalFundamentals | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/signal-fundamentals").then((r) => (r.ok ? r.json() : null)).then((d: SignalFundamentals | null) => alive && setData(d && d.names ? d : null)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

const fundFor = (f: SignalFundamentals | null | undefined, ticker: string): NameFundamentals | undefined => {
  const t = ticker.toUpperCase();
  return f?.names?.[t] ?? f?.names?.[t.replace(/\.TO$/, "-T")] ?? f?.names?.[t.replace(/-T$/, ".TO")];
};

export function signalInputFor(stock: Stock | undefined, snaps: AnalystSnapshots | undefined, fundamentals?: SignalFundamentals | null): SignalInput {
  if (!stock) return {};
  const ff = fundFor(fundamentals, stock.ticker);
  const snap = getSnapshotForTicker(snaps, stock.ticker);
  const h = stock.healthData;
  const t = stock.technicals;
  return {
    price: stock.price ?? h?.currentPrice ?? t?.currentPrice ?? null,
    // FactSet first; the figures stored on the stock are the fallback.
    peg: ff?.peg ?? h?.pegRatio,
    fcfMargin: ff?.fcfMargin ?? h?.fcfMargin,
    roic: ff?.roic ?? h?.roic,
    revenueGrowth: ff?.revenueGrowth ?? h?.revenueGrowth,
    forwardPE: ff?.ntmPe ?? null,
    forwardPE5yAvg: ff?.forwardPE5yAvg ?? null,
    evEbitda: ff?.evEbitdaForHistory ?? null,
    evEbitda5yAvg: ff?.evEbitda5yAvg ?? null,
    peVsMarketPct: ff?.peVsMarketPct,
    peVsSectorPct: ff?.peVsSectorPct,
    interestCoverage: ff?.interestCoverage,
    netDebtEbitda: ff?.netDebtEbitda,
    noDebt: ff?.noDebt,
    avgTarget: snap?.factset?.averageTarget,
    analystCount: snap?.factset?.analystCount,
    revUp: snap?.factset?.revUp,
    revDown: snap?.factset?.revDown,
    streetAsOf: snap?.factset?.asOf ?? null,
    rbc: snap?.rbc ? { rating: snap.rbc.rating, target: snap.rbc.target, asOf: snap.rbc.asOf } : null,
    jpm: snap?.jpm ? { rating: snap.jpm.rating, target: snap.jpm.target, asOf: snap.jpm.asOf } : null,
    sma50: t?.sma50 ?? h?.fiftyDayAvg,
    sma200: t?.sma200 ?? h?.twoHundredDayAvg,
    rsi14: t?.rsi14,
    week52High: t?.week52High,
    marketEdgeOpinion: stock.marketEdge?.opinion ?? null,
    sia: stock.sia,
  };
}

/** Funds and ETFs are not read by company signals. */
export const signalsApply = (stock: Stock | undefined) => !stock?.instrumentType || stock.instrumentType === "stock";

export function signalsFor(stock: Stock | undefined, snaps: AnalystSnapshots | undefined, fundamentals?: SignalFundamentals | null): SignalSet | null {
  return stock && signalsApply(stock) ? computeSignals(signalInputFor(stock, snaps, fundamentals)) : null;
}

const CELL: Record<SignalState, { text: string; cls: string }> = {
  positive: { text: "Positive", cls: "bg-pos-soft text-pos border-pos/30" },
  neutral: { text: "Neutral", cls: "bg-surface-2 text-ink-2 border-line" },
  negative: { text: "Negative", cls: "bg-neg-soft text-neg border-neg/30" },
  pending: { text: "No data", cls: "bg-surface text-ink-3 border-line-soft border-dashed" },
};

export function SignalCell({ k, s, onOpen, open }: { k: SignalKey; s: Signal; onOpen: () => void; open: boolean }) {
  const c = CELL[s.state];
  return (
    <button type="button" onClick={onOpen} aria-expanded={open} title={s.summary} className={`inline-flex h-7 min-w-[78px] items-center justify-center gap-1 rounded-control border px-2 text-[12.5px] font-semibold ${c.cls} ${open ? "ring-2 ring-accent/40" : ""}`}>
      {c.text}
      {k === "analyst" && s.state !== "pending" && <span aria-hidden>{revisionArrow(s)}</span>}
    </button>
  );
}

/** The six cells for one row; `openKey` is the cell whose numbers are showing. */
export function SignalCells({ set, openKey, onOpen }: { set: SignalSet | null; openKey: SignalKey | null; onOpen: (k: SignalKey) => void }) {
  return (
    <>
      {SIGNAL_COLUMNS.map((c) => (
        <td key={c.key} className="border-b border-line-soft px-1.5 py-2 text-center align-middle">
          {set ? <SignalCell k={c.key} s={set[c.key]} open={openKey === c.key} onOpen={() => onOpen(c.key)} /> : <span className="text-[12.5px] text-ink-3">n/a</span>}
        </td>
      ))}
      <td className="border-b border-line-soft px-2 py-2 text-center align-middle text-[14px] font-semibold tabular-nums text-ink">{set ? `${set.positives} of ${set.withData}` : "—"}</td>
    </>
  );
}

export function SignalHead() {
  return (
    <>
      {SIGNAL_COLUMNS.map((c) => (
        <th key={c.key} className="border-b border-line px-1.5 py-2 text-center text-[11.5px] font-semibold uppercase tracking-wide text-ink-3" title={c.label}>{c.short}</th>
      ))}
      <th className="border-b border-line px-2 py-2 text-center text-[11.5px] font-semibold uppercase tracking-wide text-ink-3" title="How many of the signals with data read positive. A count, not a score.">Positive</th>
    </>
  );
}

const READ_CLS: Record<SignalState, string> = { positive: "text-pos", neutral: "text-ink-2", negative: "text-neg", pending: "text-ink-3" };

/** The numbers behind one signal. */
export function SignalDetail({ k, s }: { k: SignalKey; s: Signal }) {
  const col = SIGNAL_COLUMNS.find((c) => c.key === k)!;
  return (
    <div className="rounded-control border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-[14px] font-semibold text-ink">{col.label}</span>
        <span className={`text-[13.5px] font-semibold ${READ_CLS[s.state]}`}>{CELL[s.state].text}</span>
        <span className="text-[13px] text-ink-3">{s.summary}{s.asOf ? ` · as of ${s.asOf}` : ""}</span>
      </div>
      <table className="mt-2 w-full max-w-[640px] text-[13.5px]">
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.label}>
              <td className="py-1 pr-4 text-ink-2">{r.label}</td>
              <td className="py-1 pr-4 text-right tabular-nums text-ink">{r.value}</td>
              <td className={`py-1 text-right font-medium ${READ_CLS[r.read]}`}>{r.read === "pending" ? "—" : CELL[r.read].text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
