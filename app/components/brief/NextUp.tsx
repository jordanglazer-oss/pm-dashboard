"use client";

import React from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Card, Empty, Pill, TickerLink, relDays, weekday } from "./summary-ui";

/**
 * "Next up" — earnings and macro merged into ONE chronological list, so the
 * next few sessions read as a single sequence rather than two calendars the
 * PM has to interleave in their head. The full per-source detail lives in the
 * Calendar rail below.
 */

type Item =
  | { kind: "earnings"; date: string; daysAway: number; ticker: string; name?: string; bucket: "Portfolio" | "Watchlist" | "Suggested"; weightPct: number | null; impliedMovePct: number | null }
  | { kind: "econ" | "fomc"; date: string; daysAway: number; title: string; importance: "high" | "medium" };

const DOT: Record<string, string> = {
  Portfolio: "bg-accent",
  Watchlist: "bg-violet",
  Suggested: "bg-ink-faint",
  econ: "bg-ink",
  fomc: "bg-violet",
};

export function NextUpCard({ s, limit = 7 }: { s: DailySummary; limit?: number }) {
  const c = s.calendar;
  if (!c) {
    return (
      <Card>
        <Head counts={null} />
        <Empty>Calendar unavailable.</Empty>
      </Card>
    );
  }

  const items: Item[] = [
    ...c.earnings.map((e) => ({
      kind: "earnings" as const,
      date: e.date,
      daysAway: e.daysAway,
      ticker: e.ticker,
      name: e.name,
      bucket: e.bucket,
      weightPct: e.weightPct,
      impliedMovePct: e.impliedMovePct,
    })),
    ...c.econ.map((e) => ({ kind: e.kind, date: e.date, daysAway: e.daysAway, title: e.title, importance: e.importance })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);

  const counts = {
    Portfolio: c.earnings.filter((e) => e.bucket === "Portfolio").length,
    Watchlist: c.earnings.filter((e) => e.bucket === "Watchlist").length,
    Suggested: c.earnings.filter((e) => e.bucket === "Suggested").length,
  };

  const byDate = new Map<string, Item[]>();
  for (const it of items) {
    const arr = byDate.get(it.date) ?? [];
    arr.push(it);
    byDate.set(it.date, arr);
  }

  const print = c.postPrints[0];

  return (
    <Card>
      <Head counts={counts} />
      {items.length === 0 ? (
        <Empty>Nothing scheduled in the next {c.windowDays} days.</Empty>
      ) : (
        <div>
          {[...byDate.entries()].map(([date, list]) => (
            <div key={date}>
              <div className="flex items-baseline gap-2 border-b border-line-soft bg-surface-2 px-4 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{weekday(date)}</span>
                <span className="text-[10px] text-ink-faint">{relDays(list[0].daysAway)}</span>
              </div>
              <ul>
                {list.map((it, i) => (
                  <li key={`${date}-${i}`} className="flex items-center gap-2 border-b border-line-soft px-4 py-[5px] text-[12px] last:border-b-0">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${it.kind === "earnings" ? DOT[it.bucket] : DOT[it.kind]}`} />
                    {it.kind === "earnings" ? (
                      <>
                        <TickerLink ticker={it.ticker} />
                        <span className="min-w-0 truncate text-ink-2">{it.name ?? ""}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">
                          {it.weightPct != null && <span title="Portfolio weight">{it.weightPct.toFixed(1)}%</span>}
                          {it.weightPct != null && it.impliedMovePct != null && " · "}
                          {it.impliedMovePct != null && <span title="Implied move">±{it.impliedMovePct.toFixed(1)}%</span>}
                          {it.weightPct == null && it.impliedMovePct == null && it.bucket.toLowerCase()}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={`truncate ${it.importance === "high" ? "font-semibold text-ink" : "text-ink"}`}>{it.title}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">{it.kind === "fomc" ? "FOMC" : "macro"}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {print && (
        <div className="border-t border-line bg-warn-soft px-4 py-2">
          <div className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
            <TickerLink ticker={print.ticker} />
            <span className="text-ink-2">reported {weekday(print.date)}</span>
            {print.results.slice(0, 2).map((r, i) => (
              <span key={i} className="font-mono text-ink-2">
                {r.label} <b className="text-ink">{r.actual ?? "—"}</b>
                {r.consensus && <span className="text-ink-3"> vs {r.consensus}</span>}
              </span>
            ))}
            {s.calendar && s.calendar.postPrints.length > 1 && (
              <span className="ml-auto text-[10.5px] text-ink-3">+{s.calendar.postPrints.length - 1} more in Calendar</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Head({ counts }: { counts: { Portfolio: number; Watchlist: number; Suggested: number } | null }) {
  return (
    <header className="flex items-baseline gap-2 border-b border-line-soft px-4 pt-2.5 pb-1.5">
      <h3 className="text-[13px] font-bold tracking-tight text-ink">Next up</h3>
      <span className="text-[11px] text-ink-3">· earnings and macro</span>
      {counts && (
        <span className="ml-auto flex shrink-0 gap-1">
          <Pill tone="accent">{counts.Portfolio} held</Pill>
          <Pill tone="violet">{counts.Watchlist} watch</Pill>
          <Pill tone="neutral">{counts.Suggested} sugg.</Pill>
        </span>
      )}
    </header>
  );
}
