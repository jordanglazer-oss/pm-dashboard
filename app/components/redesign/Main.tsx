"use client";

/**
 * Redesign › Main screen — the one page with what matters:
 *   performance (models + indices, any period) · watch list names in a
 *   yellow / green zone · key market facts with dates · what is on the
 *   calendar this week · a warning when a hand-entered number is stale.
 *
 * FACTS ONLY. No regime label, no AI call, no recommendation: action items
 * written by the AI brief (source "ai") are left out, and watcher flags are
 * shown as a count that links to Monitor, not as text.
 *
 * READ-ONLY. Option A = one column, top to bottom. B = dashboard grid.
 * C = three questions, large type.
 */

import React from "react";
import Link from "next/link";
import TickerLink from "@/app/components/TickerLink";
import { displayTicker } from "@/app/lib/ticker";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { WatchRow } from "@/app/lib/watchlist-plan";
import { useFacts, useSummary } from "./data";
import type { Fact } from "./facts";
import { FactCard, FactRow, StaleBanner } from "./Market";
import { PerformancePanel } from "@/app/components/brief/PerformancePanel";
import { EarningsCard, EconCard } from "@/app/components/brief/SummaryCalendar";
import { MoversCard } from "@/app/components/brief/SummaryMarket";
import { PerfTable } from "./Perf";
import { useWatch, zoneOf, ZoneTag } from "./Watch";
import { AsOf, Bullets, Card, Empty, fmtAsOf, fmtNum, fmtSigned, Loading, More, Page, Spark, Table, Tag, TD, TDN, tone, type OptionDef } from "./ui";

export const MAIN_OPTIONS: OptionDef[] = [
  { id: "a", label: "Top to bottom", blurb: "One column in order of urgency: anything stale, names at their buy price, performance, market facts, this week. Nothing to hunt for." },
  { id: "b", label: "Dashboard grid", blurb: "Everything on one screen in tiles: performance on the left, alerts and the week on the right, market facts across the bottom." },
  { id: "c", label: "Three questions", blurb: "The page answers three questions in large type: How are we doing? What is the market doing? What needs us this week? Detail opens underneath." },
  { id: "d", label: "Morning briefing", level: "Medium", blurb: "Everything a morning needs on one scroll: all models and sleeves by period, buy-zone alerts, the week, eight key facts with trend lines, the earnings and economic calendars, and what moved the index." },
  { id: "e", label: "Two-column desk", level: "Medium", blurb: "Numbers on the left (full performance table, key market facts with one-week and one-month change), things to act on down the right (alerts, the week, earnings, movers)." },
];

// ── Shared blocks ──

function ZoneAlerts({ rows, at }: { rows: WatchRow[]; at: string | null }) {
  const hit = rows.filter((r) => zoneOf(r) === "green" || zoneOf(r) === "yellow");
  if (!hit.length) return <Empty>No watch list names are in a buy zone.</Empty>;
  return (
    <div className="flex flex-col">
      {hit.map((r) => (
        <div key={r.ticker} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft py-2.5 last:border-b-0">
          <TickerLink ticker={r.ticker} className="text-[16px] font-bold text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink>
          <ZoneTag z={zoneOf(r)} />
          <span className="text-[15px] tabular-nums text-ink-2">
            {fmtNum(r.price)} vs target {fmtNum(r.plan.targetBuyPrice)} ({fmtSigned(r.aboveTargetPct)})
          </span>
        </div>
      ))}
      <AsOf at={at} source="Yahoo Finance prices" className="pt-2" />
    </div>
  );
}

function zoneCount(rows: WatchRow[]) {
  return { green: rows.filter((r) => zoneOf(r) === "green").length, yellow: rows.filter((r) => zoneOf(r) === "yellow").length };
}

/** Rule-based action items only — never the AI brief's own suggestions. */
function factualActions(s: DailySummary | null) {
  const items = s?.actions?.items ?? [];
  return {
    rules: items.filter((i) => i.source !== "ai" && i.source !== "agent"),
    flags: items.filter((i) => i.source === "agent").length,
  };
}

function ThisWeek({ s, limit = 8 }: { s: DailySummary | null; limit?: number }) {
  if (!s) return <Loading what="Loading the week" />;
  const earnings = (s.calendar?.earnings ?? []).filter((e) => e.bucket === "Portfolio" && e.daysAway >= 0 && e.daysAway <= 7);
  const econ = (s.calendar?.econ ?? []).filter((e) => e.daysAway >= 0 && e.daysAway <= 7 && e.importance === "high");
  const { rules, flags } = factualActions(s);
  const day = (d: string) => fmtAsOf(d);
  const bullets: React.ReactNode[] = [
    ...earnings.map((e) => (
      <>
        <span className="font-semibold">{displayTicker(e.ticker)}</span> reports {day(e.date)}
        {e.weightPct != null ? ` · ${e.weightPct.toFixed(1)}% of the portfolio` : ""}
      </>
    )),
    ...econ.map((e) => <>{e.title} · {day(e.date)}</>),
    ...rules.slice(0, limit).map((i) => (
      <>
        {i.ticker && !i.title.toUpperCase().startsWith(i.ticker.toUpperCase()) ? <span className="font-semibold">{displayTicker(i.ticker)} · </span> : null}
        {i.title}
      </>
    )),
  ];
  return (
    <div className="flex flex-col gap-3">
      {bullets.length ? <Bullets items={bullets} /> : <Empty>Nothing on the calendar for the next 7 days.</Empty>}
      {flags > 0 && (
        <Link href="/monitor" className="text-[14.5px] font-semibold !text-accent underline">
          {flags} open {flags === 1 ? "flag" : "flags"} on Monitor
        </Link>
      )}
      <AsOf at={s.generatedAt} source="earnings dates: Yahoo Finance · events: economic calendar · rules: thesis and alert checks" />
    </div>
  );
}

function KeyFacts({ facts, loading }: { facts: Fact[]; loading: boolean }) {
  const key = facts.filter((f) => f.key);
  if (loading && !key.some((f) => !f.missing)) return <Loading what="Loading market facts" />;
  return <div>{key.map((f) => <FactRow key={f.id} f={f} />)}</div>;
}

function FactTile({ f }: { f: Fact }) {
  return (
    <div className="min-w-0 rounded-control border border-line-soft bg-surface-2 px-3.5 py-3">
      <div className="truncate text-[13px] font-medium text-ink-3" title={f.label}>{f.label}</div>
      <div className="figure text-[24px] leading-tight">{f.value}</div>
      <div className="text-[13px]">
        {f.change ? <span className={`font-semibold ${tone(f.changeNum)}`}>{f.change}</span> : <span className="text-ink-3">—</span>}
        {f.change && f.priorLabel ? <span className="text-ink-3"> vs {f.priorLabel}</span> : null}
      </div>
      <AsOf at={f.asOf} source={f.source} className="block truncate" />
    </div>
  );
}

const factsLink = (
  <Link href="/redesign/market/a" className="font-semibold !text-accent underline">
    All market facts
  </Link>
);
const watchLink = (
  <Link href="/redesign/watch/a" className="font-semibold !text-accent underline">
    Watch list
  </Link>
);

// ── Option A: one column ──

function OptionA() {
  const { rows, at } = useWatch();
  const { facts, loading } = useFacts();
  const s = useSummary();
  const z = zoneCount(rows);
  return (
    <>
      <StaleBanner />
      <Card title="Names at our buy price" sub={`${z.green} green · ${z.yellow} yellow`} right={watchLink}>
        <ZoneAlerts rows={rows} at={at} />
      </Card>
      <Card title="Performance" sub="models and indices" pad={false}>
        <PerfTable prefKey="redesign.main.a.perf" />
      </Card>
      <Card title="Key market facts" right={factsLink} pad={false}>
        <div className="px-5 py-1"><KeyFacts facts={facts} loading={loading} /></div>
      </Card>
      <Card title="This week">
        <ThisWeek s={s.data} />
      </Card>
    </>
  );
}

// ── Option B: grid ──

function OptionB() {
  const { rows, at } = useWatch();
  const { facts, loading } = useFacts();
  const s = useSummary();
  const z = zoneCount(rows);
  const key = facts.filter((f) => f.key);
  return (
    <>
      <StaleBanner />
      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <Card title="Performance" sub="models and indices" pad={false}>
          <PerfTable prefKey="redesign.main.b.perf" compact />
        </Card>
        <div className="flex flex-col gap-4">
          <Card title="Buy-zone alerts" sub={`${z.green} green · ${z.yellow} yellow`} right={watchLink}>
            <ZoneAlerts rows={rows} at={at} />
          </Card>
          <Card title="This week">
            <ThisWeek s={s.data} limit={5} />
          </Card>
        </div>
      </div>
      <Card title="Key market facts" right={factsLink}>
        {loading && !key.some((f) => !f.missing) ? (
          <Loading what="Loading market facts" />
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{key.map((f) => <FactTile key={f.id} f={f} />)}</div>
        )}
      </Card>
    </>
  );
}

// ── Option C: three questions ──

function Question({ n, q, children }: { n: number; q: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line-soft bg-surface shadow-[var(--shadow-card)]">
      <div className="flex items-baseline gap-3 px-6 pt-5">
        <span className="figure text-[22px] text-brass-ink">{n}</span>
        <h2 className="text-[22px] font-bold tracking-tight">{q}</h2>
      </div>
      {children}
    </section>
  );
}

function OptionC() {
  const { rows, at } = useWatch();
  const { facts, loading } = useFacts();
  const s = useSummary();
  const z = zoneCount(rows);
  const models = (s.data?.performance?.models ?? []).filter((m) => m.groupId === "pim" && ["balanced", "growth", "allEquity"].includes(m.profile));
  const sp = s.data?.performance?.benchmarks.find((b) => b.key === "sp500");
  const tsx = s.data?.performance?.benchmarks.find((b) => b.key === "tsx");
  const label: Record<string, string> = { balanced: "Balanced", growth: "Growth", allEquity: "All-Equity" };
  const headline = facts.filter((f) => ["vix", "breadth200", "spx10m", "hyOas"].includes(f.id));
  return (
    <>
      <StaleBanner />
      <Question n={1} q="How are we doing?">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 py-5 md:grid-cols-5">
          {[...models.map((m) => ({ k: label[m.profile], v: m.returns.ytd, at: m.asOf })), { k: "S&P 500 (US$)", v: sp?.returns.ytd ?? null, at: sp?.asOf ?? null }, { k: "S&P/TSX", v: tsx?.returns.ytd ?? null, at: tsx?.asOf ?? null }].map((x) => (
            <div key={x.k}>
              <div className="text-[14px] font-medium text-ink-3">{x.k}</div>
              <div className={`figure text-[30px] leading-tight ${tone(x.v)}`}>{fmtSigned(x.v, 1)}</div>
              <div className="text-[12.5px] text-ink-3">year to date · {fmtAsOf(x.at)}</div>
            </div>
          ))}
          {!s.data && <Loading what="Loading performance" />}
        </div>
        <More prefKey="redesign.main.c.perf" label="other periods, sleeves and a custom date range">
          <div className="-mx-5"><PerfTable prefKey="redesign.main.c.perf.extra" /></div>
        </More>
      </Question>

      <Question n={2} q="What is the market doing?">
        <div className="grid grid-cols-2 gap-3 px-6 py-5 md:grid-cols-4">
          {loading && !headline.some((f) => !f.missing) ? <Loading what="Loading market facts" /> : headline.map((f) => <FactTile key={f.id} f={f} />)}
        </div>
        <More prefKey="redesign.main.c.facts" label="the rest of the key facts">
          <KeyFacts facts={facts.filter((f) => !headline.includes(f))} loading={loading} />
          <div className="pt-3 text-[14px]">{factsLink}</div>
        </More>
      </Question>

      <Question n={3} q="What needs us this week?">
        <div className="px-6 py-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tag kind={z.green ? "green" : "neutral"}>{z.green} at target</Tag>
            <Tag kind={z.yellow ? "yellow" : "neutral"}>{z.yellow} within 5%</Tag>
            <span className="text-[14px]">{watchLink}</span>
          </div>
          <ZoneAlerts rows={rows} at={at} />
        </div>
        <More prefKey="redesign.main.c.week" label="earnings, events and rule checks this week" defaultOpen>
          <ThisWeek s={s.data} />
        </More>
      </Question>
    </>
  );
}

// ── Medium options: more on the page, still facts only ──
// These reuse the existing Brief panels that are pure facts (performance by
// period, earnings and economic calendars, index movers). The regime dial,
// the cash and hedging calls and the AI narrative are deliberately left out.

const signTone = (t: string | undefined) => (!t ? "text-ink-3" : t.startsWith("+") ? "text-pos" : t.startsWith("−") ? "text-neg" : "text-ink-2");

function KeyTrendTable({ facts, loading }: { facts: Fact[]; loading: boolean }) {
  const key = facts.filter((f) => f.key);
  if (loading && !key.some((f) => !f.missing)) return <div className="px-5"><Loading what="Loading market facts" /></div>;
  return (
    <Table minWidth={560} head={[{ label: "Fact" }, { label: "Now", right: true }, { label: "1 week", right: true }, { label: "1 month", right: true }, { label: "Trend" }]}>
      {key.map((f) => (
        <tr key={f.id}>
          <td className={TD}>
            <div className="font-medium">{f.label}</div>
            <AsOf at={f.asOf} source={f.source} />
          </td>
          <td className={`${TDN} text-[17px] font-semibold`}>{f.value}</td>
          <td className={`${TDN} ${signTone(f.d1w || f.change)}`}>{f.d1w || f.change || "—"}</td>
          <td className={`${TDN} ${signTone(f.d1m)}`}>{f.d1m || "—"}</td>
          <td className={TD}><Spark points={f.spark ?? []} /></td>
        </tr>
      ))}
    </Table>
  );
}

function OptionD() {
  const { rows, at } = useWatch();
  const { facts, loading } = useFacts();
  const s = useSummary();
  const z = zoneCount(rows);
  const key = facts.filter((f) => f.key);
  return (
    <>
      <StaleBanner />
      {s.data ? <PerformancePanel s={s.data} /> : <Card title="Performance"><Loading what="Loading performance" /></Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Buy-zone alerts" sub={`${z.green} green · ${z.yellow} yellow`} right={watchLink}>
          <ZoneAlerts rows={rows} at={at} />
        </Card>
        <Card title="This week">
          <ThisWeek s={s.data} />
        </Card>
      </div>
      <Card title="Key market facts" right={factsLink}>
        {loading && !key.some((f) => !f.missing) ? (
          <Loading what="Loading market facts" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{key.map((f) => <FactCard key={f.id} f={f} />)}</div>
        )}
      </Card>
      {s.data && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <EarningsCard s={s.data} />
            <EconCard s={s.data} />
          </div>
          {s.data.drivers && <MoversCard s={s.data} win="1d" />}
        </>
      )}
    </>
  );
}

function OptionE() {
  const { rows, at } = useWatch();
  const { facts, loading } = useFacts();
  const s = useSummary();
  const z = zoneCount(rows);
  return (
    <>
      <StaleBanner />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {s.data ? <PerformancePanel s={s.data} /> : <Card title="Performance"><Loading what="Loading performance" /></Card>}
          <Card title="Key market facts" right={factsLink} pad={false}>
            <KeyTrendTable facts={facts} loading={loading} />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Buy-zone alerts" sub={`${z.green} green · ${z.yellow} yellow`} right={watchLink}>
            <ZoneAlerts rows={rows} at={at} />
          </Card>
          <Card title="This week">
            <ThisWeek s={s.data} limit={6} />
          </Card>
          {s.data && <EarningsCard s={s.data} />}
          {s.data?.drivers && <MoversCard s={s.data} win="1d" />}
        </div>
      </div>
    </>
  );
}

export default function MainScreen({ opt }: { opt: string }) {
  return (
    <Page title="Main screen" lede="What matters today, as facts.">
      {opt === "b" ? <OptionB /> : opt === "c" ? <OptionC /> : opt === "d" ? <OptionD /> : opt === "e" ? <OptionE /> : <OptionA />}
    </Page>
  );
}
