"use client";

import React from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { useStocks } from "@/app/lib/StockContext";
import { EarningsCard, EconCard } from "./SummaryCalendar";
import { Card, Empty, IconButton, TickerLink, relDays, weekday, weekdayShort } from "./summary-ui";

/**
 * Calendar — earnings and macro merged into ONE chronological list, so the
 * next few sessions read as a single sequence rather than two calendars the
 * PM has to interleave in their head. The chevron opens the full per-source
 * detail (Earnings + Economic data cards) in place; open/closed persists.
 */

type Item =
  | { kind: "earnings"; date: string; daysAway: number; ticker: string; name?: string; bucket: "Portfolio" | "Watchlist" | "Suggested"; weightPct: number | null; impliedMovePct: number | null }
  | { kind: "econ" | "fomc"; date: string; daysAway: number; title: string; importance: "high" | "medium" };

const BUCKET_WORD = { Portfolio: "held", Watchlist: "watch", Suggested: "suggested" } as const;

const PREF = "brief.summary.calendar";

export function CalendarPanel({ s, limit = 7 }: { s: DailySummary; limit?: number }) {
  const { uiPrefs, setUiPref } = useStocks();
  const open = (uiPrefs[PREF] ?? "1") !== "1";
  const c = s.calendar;

  const items: Item[] = c
    ? [
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
        .slice(0, limit)
    : [];

  const held = c ? c.earnings.filter((e) => e.bucket === "Portfolio").length : 0;
  const watch = c ? c.earnings.filter((e) => e.bucket === "Watchlist").length : 0;
  const print = c?.postPrints[0];

  return (
    <Card>
      <div className="panel-h" id="s-calendar" style={{ scrollMarginTop: 64 }}>
        <span className="t">Calendar</span>
        <span className="m">{c ? `next ${c.windowDays} days` : "loading"}</span>
        {c && c.earnings.length > 0 && <span className="m hidden sm:inline">{held} held · {watch} watch</span>}
        <div className="ml-auto flex items-center gap-2">
          <IconButton onClick={() => setUiPref(PREF, open ? "1" : "0")} title={open ? "Hide earnings and economic detail" : "Show earnings and economic detail"} icon={open ? "chevU" : "chevD"} active={open} />
        </div>
      </div>
      {!c ? (
        <Empty>Calendar unavailable.</Empty>
      ) : items.length === 0 ? (
        <Empty>Nothing scheduled in the next {c.windowDays} days.</Empty>
      ) : (
        <div>
          {items.map((it, i) => (
            <div key={`${it.date}-${i}`} className="flex h-8 items-center gap-2.5 border-b border-line-soft px-3.5 text-[12.5px]">
              <span className="w-[30px] shrink-0 font-mono text-[11.5px] text-ink-3" title={`${weekday(it.date)} · ${relDays(it.daysAway)}`}>
                {weekdayShort(it.date)}
              </span>
              {it.kind === "earnings" ? (
                <>
                  <TickerLink ticker={it.ticker} className="w-[84px] shrink-0 truncate" />
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={it.name}>
                    {it.name ? `${it.name} · ` : ""}{BUCKET_WORD[it.bucket]}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-3">
                    {it.weightPct != null && <span title="Portfolio weight">{it.weightPct.toFixed(1)}%</span>}
                    {it.weightPct != null && it.impliedMovePct != null && " · "}
                    {it.impliedMovePct != null && <span title="Implied move">±{it.impliedMovePct.toFixed(1)}%</span>}
                    {it.weightPct == null && it.impliedMovePct == null && relDays(it.daysAway)}
                  </span>
                </>
              ) : (
                <>
                  <span className={`w-[84px] shrink-0 truncate font-mono ${it.importance === "high" ? "font-medium text-ink" : "text-ink"}`} title={it.title}>
                    {it.title}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{it.kind === "fomc" ? "FOMC" : "macro release"}{it.importance === "high" ? " · high" : ""}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{relDays(it.daysAway)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {print && (
        <div className="flex flex-wrap items-baseline gap-2 border-b border-line-soft bg-surface-2 px-3.5 py-2 text-[11.5px]">
          <TickerLink ticker={print.ticker} />
          <span className="text-ink-2">reported {weekday(print.date)}</span>
          {print.results.slice(0, 2).map((r, i) => (
            <span key={i} className="font-mono text-ink-2">
              {r.label} <b className="font-medium text-ink">{r.actual ?? "—"}</b>
              {r.consensus && <span className="text-ink-3"> vs {r.consensus}</span>}
            </span>
          ))}
          {c && c.postPrints.length > 1 && <span className="ml-auto text-ink-3">+{c.postPrints.length - 1} more below</span>}
        </div>
      )}
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-line-soft bg-ground p-3 xl:grid-cols-2">
          <EarningsCard s={s} />
          <EconCard s={s} />
        </div>
      )}
    </Card>
  );
}
