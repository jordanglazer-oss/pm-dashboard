"use client";

import React from "react";
import Link from "next/link";
import type { DailySummary } from "@/app/lib/daily-summary";
import { Card, CardHeader, Empty, Pct, Pill, TickerLink, timeAgo } from "./summary-ui";

export function InflowCard({ s }: { s: DailySummary }) {
  const i = s.inflow;
  const total = i ? i.reports.length + i.alerts.length + i.rescored.length : 0;
  return (
    <Card>
      <CardHeader title="Inflow" sub={i ? `since ${timeAgo(i.sinceIso).replace(" ago", "")} back` : "loading"} right={i && <Pill tone={total ? "accent" : "neutral"}>{total} new</Pill>} />
      {!i ? (
        <Empty>Unavailable.</Empty>
      ) : total === 0 ? (
        <Empty>Nothing new arrived.</Empty>
      ) : (
        <ul className="max-h-[260px] divide-y divide-line-soft overflow-y-auto text-[11.5px]">
          {i.alerts.map((a) => (
            <li key={`a-${a.ticker}-${a.at}`} className="flex items-center gap-2 px-4 py-1.5">
              <Pill tone={a.kind === "news" ? "violet" : "accent"}>{a.kind}</Pill>
              <TickerLink ticker={a.ticker} />
              <span className="min-w-0 truncate text-ink-2">{a.headline}</span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{timeAgo(a.at)}</span>
            </li>
          ))}
          {i.reports.map((r) => (
            <li key={`r-${r.ticker}-${r.source}`} className="flex items-center gap-2 px-4 py-1.5">
              <Pill tone="neutral">{r.source}</Pill>
              <TickerLink ticker={r.ticker} />
              <span className="min-w-0 truncate text-ink-2">{r.label ?? "report"}</span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{timeAgo(r.at)}</span>
            </li>
          ))}
          {i.rescored.map((r) => (
            <li key={`s-${r.ticker}-${r.at}`} className="flex items-center gap-2 px-4 py-1.5">
              <Pill tone="neutral">score</Pill>
              <TickerLink ticker={r.ticker} />
              <span className="font-mono text-ink">{r.total.toFixed(1)}</span>
              {r.delta != null && <span className={`font-mono ${r.delta > 0 ? "text-pos" : r.delta < 0 ? "text-neg" : "text-ink-3"}`}>{r.delta > 0 ? "+" : ""}{r.delta}</span>}
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{timeAgo(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function FunnelCard({ s }: { s: DailySummary }) {
  const f = s.funnel;
  return (
    <Card>
      <CardHeader title="Funnel" sub="idea pipeline" href="/funnel" />
      {!f ? (
        <Empty>Unavailable.</Empty>
      ) : (
        <div className="px-4 py-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stage n={f.suggested} label="Suggested" href="/funnel" />
            <Stage n={f.watchlist} label="Watchlist" href="/" />
            <Stage n={f.portfolio} label="Portfolio" href="/" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2">
            <span><b className="font-mono text-pos">{f.entryReady}</b> entry-ready</span>
            <span><b className="font-mono text-ink">{f.entryBuilding}</b> building</span>
            {f.newlyReady.length > 0 && <span className="text-pos">new: {f.newlyReady.join(", ")}</span>}
            {f.scanBuiltAt && <span className="ml-auto text-ink-faint">scan {timeAgo(f.scanBuiltAt)}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

function Stage({ n, label, href }: { n: number; label: string; href: string }) {
  return (
    <Link href={href} className="rounded-control border border-line-soft bg-surface-2 px-2 py-2 hover:border-line">
      <div className="font-mono text-[18px] font-semibold text-ink">{n}</div>
      <div className="text-[10.5px] uppercase tracking-wide text-ink-3">{label}</div>
    </Link>
  );
}

export function JournalCard({ s }: { s: DailySummary }) {
  const j = s.journal;
  return (
    <Card>
      <CardHeader
        title="Decision scorecard"
        sub={j?.computedAt ? `vs benchmark · ${timeAgo(j.computedAt)}` : "journal"}
        href="/journal"
        right={j?.stats && (
          <span className="font-mono text-[10.5px] text-ink-3">
            buys {j.stats.buys.hits}/{j.stats.buys.n} · trims {j.stats.trims.hits}/{j.stats.trims.n}
          </span>
        )}
      />
      {!j || j.recent.length === 0 ? (
        <Empty>No attributed decisions yet.</Empty>
      ) : (
        <ul className="divide-y divide-line-soft text-[11.5px]">
          {j.recent.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-4 py-1.5">
              <span className="w-[62px] shrink-0 font-mono text-[10.5px] text-ink-3">{r.date.slice(5)}</span>
              <Pill tone={r.action === "add" || r.action === "buy" ? "pos" : r.action === "trim" || r.action === "sell" ? "neg" : "neutral"}>{r.action}</Pill>
              <TickerLink ticker={r.ticker} />
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3">
                1m <Pct v={r.rel1m} digits={1} pp />{r.partial1m ? "*" : ""} · 3m <Pct v={r.rel3m} digits={1} pp />{r.partial3m ? "*" : ""}
              </span>
              {r.hit != null && <span className={`shrink-0 ${r.hit ? "text-pos" : "text-neg"}`}>{r.hit ? "✓" : "✗"}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
