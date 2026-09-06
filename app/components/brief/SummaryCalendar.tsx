"use client";

import React from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Card, CardHeader, Empty, Pill, TickerLink, relDays, weekday } from "./summary-ui";

const BUCKET_TONE = { Portfolio: "accent", Watchlist: "violet", Suggested: "neutral" } as const;

export function EarningsCard({ s }: { s: DailySummary }) {
  const c = s.calendar;
  const rows = c?.earnings ?? [];
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const counts = { Portfolio: 0, Watchlist: 0, Suggested: 0 };
  for (const r of rows) counts[r.bucket]++;
  return (
    <Card>
      <CardHeader
        title="Earnings"
        sub={c ? `next ${c.windowDays} days` : "loading"}
        right={
          <span className="flex gap-1">
            {(["Portfolio", "Watchlist", "Suggested"] as const).map((b) => (
              <Pill key={b} tone={BUCKET_TONE[b]}>{counts[b]} {b === "Suggested" ? "sugg." : b === "Watchlist" ? "watch" : "held"}</Pill>
            ))}
          </span>
        }
      />
      {!c ? (
        <Empty>Calendar unavailable.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No prints in the window across Portfolio, Watchlist or Suggested.</Empty>
      ) : (
        <div className="max-h-[340px] overflow-y-auto">
          {[...byDate.entries()].map(([date, list]) => (
            <div key={date} className="border-b border-line-soft last:border-b-0">
              <div className="flex items-baseline gap-2 bg-surface-2 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                {weekday(date)} <span className="font-normal normal-case tracking-normal text-ink-faint">{relDays(list[0].daysAway)}</span>
              </div>
              <ul>
                {list.map((r) => (
                  <li key={`${r.bucket}-${r.ticker}`} className="flex items-center gap-2 px-4 py-1.5 text-[12px]">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.bucket === "Portfolio" ? "bg-accent" : r.bucket === "Watchlist" ? "bg-violet" : "bg-ink-faint"}`} />
                    <TickerLink ticker={r.ticker} />
                    <span className="min-w-0 truncate text-ink-2">{r.name ?? ""}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-3">
                      {r.weightPct != null && <span title="Portfolio weight">{r.weightPct.toFixed(1)}%</span>}
                      {r.impliedMovePct != null && <span title="Implied move (FactSet)">±{r.impliedMovePct.toFixed(1)}%</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {c && c.postPrints.length > 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Just reported · vs consensus</div>
          <ul className="space-y-2">
            {c.postPrints.slice(0, 4).map((p) => (
              <li key={`${p.ticker}-${p.date}`} className="text-[11.5px]">
                <div className="flex items-baseline gap-2">
                  <TickerLink ticker={p.ticker} />
                  <span className="text-ink-3">{p.event ?? "results"} · {weekday(p.date)}</span>
                  {p.trackRecord?.epsBeatRate && <span className="ml-auto font-mono text-[10.5px] text-ink-faint">EPS beat rate {p.trackRecord.epsBeatRate}</span>}
                </div>
                {p.results.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
                    {p.results.map((r, i) => (
                      <span key={i} className="text-ink-2">
                        {r.label} <b className="text-ink">{r.actual ?? "—"}</b>
                        {r.consensus && <span className="text-ink-3"> vs {r.consensus}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {p.guidance && <div className="mt-0.5 line-clamp-2 text-ink-2">{p.guidance}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function EconCard({ s }: { s: DailySummary }) {
  const c = s.calendar;
  const upcoming = c?.econ ?? [];
  const recent = c?.econRecent ?? [];
  return (
    <Card>
      <CardHeader
        title="Economic data"
        sub={c?.econStatus === "live" ? "FRED release calendar" : c?.econStatus === "not-configured" ? "FRED key not configured" : "calendar unavailable"}
      />
      <div className="grid grid-cols-1 divide-y divide-line-soft md:grid-cols-2 md:divide-x md:divide-y-0">
        <div>
          <div className="bg-surface-2 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Upcoming</div>
          {upcoming.length === 0 ? (
            <Empty>No tracked releases in the window.</Empty>
          ) : (
            <ul className="max-h-[300px] overflow-y-auto">
              {upcoming.map((e, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-1.5 text-[12px]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.kind === "fomc" ? "bg-violet" : e.importance === "high" ? "bg-accent" : "bg-ink-faint"}`} />
                  <span className="w-[76px] shrink-0 font-mono text-[11px] text-ink-3">{weekday(e.date)}</span>
                  <span className="min-w-0 truncate text-ink">{e.title}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-ink-faint">{relDays(e.daysAway)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="flex items-baseline gap-2 bg-surface-2 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Latest prints <span className="font-normal normal-case tracking-normal text-ink-faint">actual · prior</span>
          </div>
          {recent.length === 0 ? (
            <Empty>No actuals available.</Empty>
          ) : (
            <table className="w-full text-[12px]">
              <tbody>
                {recent.map((r) => (
                  <tr key={r.series} className="border-b border-line-soft last:border-b-0">
                    <td className="px-4 py-1.5 text-ink">{r.title}<span className="ml-1 text-[10px] text-ink-faint">{r.asOf.slice(0, 7)}</span></td>
                    <td className="py-1.5 text-right font-mono text-ink">{fmtEcon(r.actual, r.unit)}</td>
                    <td className="px-4 py-1.5 text-right font-mono text-ink-3">{fmtEcon(r.prior, r.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="px-4 py-1.5 text-[10.5px] text-ink-faint">Consensus not wired yet — actuals from FRED.</div>
        </div>
      </div>
    </Card>
  );
}

function fmtEcon(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "k") return `${v > 0 ? "+" : ""}${v}k`;
  if (unit === "%") return `${v.toFixed(1)}%`;
  return `${v > 0 ? "+" : ""}${v.toFixed(unit.includes("saar") ? 1 : 2)}%`;
}
