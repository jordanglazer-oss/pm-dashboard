"use client";

import React, { useEffect, useState } from "react";
import { PageHeading } from "@/app/components/PageHeading";
import { PmMonthlyDraft } from "@/app/components/PmMonthlyDraft";
import { Skeleton } from "@/app/components/Skeleton";
import { displayTicker } from "@/app/lib/ticker";
import type { MonthFacts, MonthMover } from "@/app/lib/pm-monthly-shared";

/**
 * /pm-monthly — the PM Monthly workbench: the client-update draft (English +
 * French, house style, Word downloads) on top, and below it the month's facts
 * it is written from — model and index returns, contributors and detractors,
 * activity, outlook inputs.
 */

const fmt = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");
const PROFILE_LABEL: Record<string, string> = {
  conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity", alpha: "Alpha (stocks + Thematic)", core: "Core", thematic: "Thematic",
};

function prevMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function Movers({ title, rows }: { title: string; rows: MonthMover[] }) {
  return (
    <section className="panel">
      <div className="panel-h"><span className="t">{title}</span><span className="m">contribution in pts of the equity class</span></div>
      {rows.length === 0 ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">None.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr><th className="pl-3.5">Holding</th><th>Bucket</th><th className="n">Weight</th><th className="n">Return (C$)</th><th className="n">Contribution</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.symbol}>
                  <td className="pl-3.5"><span className="font-mono font-medium">{displayTicker(m.symbol)}</span>{m.name && <span className="ml-2 text-[12px] text-ink-3">{m.name}</span>}</td>
                  <td className="capitalize text-ink-2">{m.bucket}</td>
                  <td className="n">{(m.weightInClass * 100).toFixed(1)}%</td>
                  <td className={`n ${tone(m.returnPct)}`}>{fmt(m.returnPct, 1)}</td>
                  <td className={`n ${tone(m.contributionPts)}`}>{m.contributionPts > 0 ? "+" : ""}{m.contributionPts.toFixed(2)} pts</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function PmMonthlyPage() {
  const [month, setMonth] = useState(prevMonth());
  const [facts, setFacts] = useState<MonthFacts | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      setFacts(null);
      setErr(null);
      fetch(`/api/pm-monthly/facts?month=${month}`)
        .then((r) => r.json())
        .then((d) => {
          if (!live) return;
          if (d?.facts) setFacts(d.facts);
          else setErr(d?.error ?? "Could not load.");
        })
        .catch(() => live && setErr("Could not load."));
    });
    return () => {
      live = false;
    };
  }, [month]);

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading
        lede="The month's client update: draft it in English and French from the facts below and your notes, edit, save, and download as Word."
        actions={<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />}
      />
      <PmMonthlyDraft month={month} />
      {err && <p className="text-[13px] text-neg">{err}</p>}
      {!facts && !err && <Skeleton className="h-48 w-full" />}
      {facts && (
        <>
          {facts.partialMonth && <p className="text-[12.5px] text-warn">Month in progress — figures through {facts.through}.</p>}
          <div className="grid gap-3.5 md:grid-cols-2">
            <section className="panel">
              <div className="panel-h"><span className="t">Our models</span><span className="m">{facts.month}</span></div>
              <table className="data-table">
                <tbody>
                  {facts.modelReturns.map((m) => (
                    <tr key={m.profile}>
                      <td className="pl-3.5">{PROFILE_LABEL[m.profile] ?? m.profile}{m.partial && <span className="ml-1 text-[11px] text-ink-3">(since tracking began)</span>}</td>
                      <td className={`n ${tone(m.returnPct)}`}>{fmt(m.returnPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panel">
              <div className="panel-h"><span className="t">Markets</span><span className="m">{facts.month}</span></div>
              <table className="data-table">
                <tbody>
                  {facts.indexReturns.map((m) => (
                    <tr key={m.label}><td className="pl-3.5">{m.label}</td><td className={`n ${tone(m.returnPct)}`}>{fmt(m.returnPct)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <div className="grid gap-3.5 md:grid-cols-2">
            <Movers title="Top contributors" rows={facts.contributors} />
            <Movers title="Top detractors" rows={facts.detractors} />
          </div>
          <section className="panel">
            <div className="panel-h"><span className="t">Activity</span><span className="m">{facts.activity.trades.length} decisions · {facts.activity.rebalanceDays.length} rebalance day(s)</span></div>
            <div className="flex flex-col gap-1.5 px-3.5 py-3 text-[12.5px] text-ink-2">
              {facts.activity.trades.map((t, i) => (
                <div key={i}><span className="font-mono text-ink-3">{t.date}</span> · <span className="capitalize">{t.kind}</span> <span className="font-mono">{displayTicker(t.symbol)}</span>{t.name ? ` (${t.name})` : ""}{t.target != null ? ` → ${(t.target * 100).toFixed(2)}%` : ""}{t.notes ? ` — ${t.notes}` : ""}</div>
              ))}
              {facts.activity.modelChanges.map((c, i) => (
                <div key={`m${i}`}><span className="font-mono text-ink-3">{c.date}</span> · Model change: {c.note}</div>
              ))}
              {facts.activity.journal.map((j, i) => (
                <div key={`j${i}`} className="text-ink-3"><span className="font-mono">{j.date}</span> · Journal{j.ticker ? ` ${j.ticker}` : ""}: {j.rationale}</div>
              ))}
              {!facts.activity.trades.length && !facts.activity.modelChanges.length && !facts.activity.journal.length && <span className="text-ink-3">No decisions logged this month.</span>}
            </div>
          </section>
          <section className="panel">
            <div className="panel-h"><span className="t">Outlook inputs</span><span className="m">latest brief{facts.outlook.briefDate ? ` (${facts.outlook.briefDate})` : ""}</span></div>
            <div className="flex flex-col gap-1.5 px-3.5 py-3 text-[12.5px] text-ink-2">
              <div>Regime: {facts.outlook.regime ?? "—"}</div>
              {facts.outlook.bottomLine && <div>Bottom line: {facts.outlook.bottomLine}</div>}
              {facts.outlook.tactical && <div>Tactical: {facts.outlook.tactical}</div>}
              {facts.outlook.cyclical && <div>Cyclical: {facts.outlook.cyclical}</div>}
            </div>
          </section>
          <p className="text-[11.5px] text-ink-3">{facts.method}</p>
        </>
      )}
    </main>
  );
}
