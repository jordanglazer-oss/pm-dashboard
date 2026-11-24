"use client";

/**
 * Redesign › Market facts. Replaces the regime CALL with the inputs behind
 * it, shown as facts: now, prior, change, context, as-of date, source.
 * No "risk on / off", no weighted score, no conclusion.
 *
 * READ-ONLY. Option A = one table. Option B = three columns by horizon.
 */

import React from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { useFacts } from "./data";
import { GROUPS, manualStatus, type Fact } from "./facts";
import { AsOf, BTN, Card, daysOld, Empty, fmtAsOf, Loading, More, Page, Spark, Table, Tag, TD, TDN, todayET, tone, type OptionDef } from "./ui";

export const MARKET_OPTIONS: OptionDef[] = [
  { id: "a", label: "One table", blurb: "Every market fact in a single table, grouped by time horizon. Best for scanning down a column." },
  { id: "b", label: "Three columns", blurb: "Tactical, cyclical and structural side by side, with the value large and the context under it. Best on an iPad." },
  { id: "c", label: "Table with trends", level: "Medium", blurb: "The full table, plus how each fact has moved over one week, one month and three months, a small trend line, and where today sits in its recent range." },
  { id: "d", label: "Trend cards", level: "Medium", blurb: "Every fact as a card with its trend line and its one-week and one-month change, grouped by time horizon. Nothing hidden." },
];

/** A manual number is "stale" when its as-of date is not today or the last weekday. */
function staleTag(f: Fact): React.ReactNode {
  if (f.missing) return f.manual ? <Tag kind="red">Not entered</Tag> : <Tag title="The source did not return a value">Not available</Tag>;
  if (!f.manual) return null;
  if (!f.asOf) return <Tag kind="yellow" title="Entered before dates were recorded for this number">Date not recorded</Tag>;
  const d = daysOld(f.asOf);
  if (d == null || d <= 1) return null;
  return <Tag kind="yellow" title="Typed in by hand and not updated recently">{d} days old</Tag>;
}

export function StaleBanner() {
  const { marketData } = useStocks();
  const rows = manualStatus(marketData, todayET());
  const stale = rows.filter((r) => !r.today);
  if (!stale.length) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-pos-border bg-pos-soft px-4 py-2.5 text-[14.5px] text-pos">
        <span className="font-semibold">All {rows.length} hand-entered numbers were updated today.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-warn-border bg-warn-soft px-4 py-2.5 text-[14.5px] text-warn">
      <span className="font-semibold">
        {stale.length} of {rows.length} hand-entered numbers not updated today
      </span>
      <span className="text-ink-2">{stale.slice(0, 4).map((r) => r.field.label.replace("% of ", "")).join(" · ")}{stale.length > 4 ? ` · +${stale.length - 4} more` : ""}</span>
      <Link href="/redesign/manual-inputs" className="ml-auto font-semibold !text-accent underline">
        Update now (2 min)
      </Link>
    </div>
  );
}

function Change({ f }: { f: Fact }) {
  if (!f.change) return <span className="text-ink-3">—</span>;
  return <span className={tone(f.changeNum)}>{f.change}</span>;
}

function TableView({ facts }: { facts: Fact[] }) {
  return (
    <Card pad={false}>
      <Table minWidth={900} head={[{ label: "Fact" }, { label: "Now", right: true }, { label: "Prior", right: true }, { label: "Change", right: true }, { label: "Context" }, { label: "As of · source" }]}>
        {GROUPS.map((g) => (
          <React.Fragment key={g.id}>
            <tr>
              <td colSpan={6} className="border-b border-line-soft bg-accent-soft px-5 py-2 text-[13px] font-bold uppercase tracking-wide text-accent">
                {g.label} <span className="font-medium normal-case tracking-normal text-ink-3">· {g.horizon}</span>
              </td>
            </tr>
            {facts.filter((f) => f.group === g.id).map((f) => (
              <tr key={f.id}>
                <td className={TD}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.label}</span>
                    {f.manual && <Tag title="Typed in by hand">Manual</Tag>}
                    {staleTag(f)}
                  </div>
                </td>
                <td className={`${TDN} text-[17px] font-semibold`}>{f.value}</td>
                <td className={`${TDN} text-ink-2`} title={f.priorLabel}>{f.prior}</td>
                <td className={TDN}><Change f={f} /></td>
                <td className={`${TD} max-w-[300px] text-[13.5px] text-ink-2`}>{f.context || "—"}</td>
                <td className={`${TD} whitespace-nowrap`}><AsOf at={f.asOf} source={f.source} /></td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </Table>
    </Card>
  );
}

export function FactRow({ f }: { f: Fact }) {
  return (
    <div className="border-b border-line-soft py-3 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug">{f.label}</span>
        <span className="figure whitespace-nowrap text-[22px]">{f.value}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-2">
        {f.change ? (
          <span>
            <span className={`font-semibold ${tone(f.changeNum)}`}>{f.change}</span> vs {f.priorLabel} ({f.prior})
          </span>
        ) : null}
        {staleTag(f)}
        {f.manual && !f.missing && <Tag title="Typed in by hand">Manual</Tag>}
      </div>
      {f.context && <div className="mt-0.5 text-[13px] text-ink-3">{f.context}</div>}
      <AsOf at={f.asOf} source={f.source} className="mt-0.5 block" />
    </div>
  );
}

function ColumnsView({ facts }: { facts: Fact[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {GROUPS.map((g) => {
        const rows = facts.filter((f) => f.group === g.id);
        const top = rows.filter((f) => f.key);
        const rest = rows.filter((f) => !f.key);
        return (
          <Card key={g.id} title={g.label} sub={g.horizon} pad={false}>
            <div className="px-5 py-1">{top.map((f) => <FactRow key={f.id} f={f} />)}</div>
            {rest.length > 0 && (
              <More prefKey={`redesign.market.more.${g.id}`} label={`${rest.length} more ${g.label.toLowerCase()} facts`}>
                {rest.map((f) => <FactRow key={f.id} f={f} />)}
              </More>
            )}
          </Card>
        );
      })}
    </div>
  );
}

const signTone = (t: string | undefined) => (!t ? "text-ink-3" : t.startsWith("+") ? "text-pos" : t.startsWith("−") ? "text-neg" : "text-ink-2");

/** Where today sits between the low and the high of the fact's recent range. */
function RangeBar({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-ink-3">—</span>;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span className="inline-flex items-center gap-2" title={`${Math.round(p)}% of the way from the recent low to the recent high`}>
      <span className="relative inline-block h-[6px] w-[72px] rounded-full bg-line-soft">
        <span className="absolute top-[-3px] h-[12px] w-[3px] rounded-full bg-accent" style={{ left: `calc(${p}% - 1.5px)` }} />
      </span>
      <span className="w-9 text-right text-[13px] tabular-nums text-ink-2">{Math.round(p)}%</span>
    </span>
  );
}

function TrendTable({ facts }: { facts: Fact[] }) {
  return (
    <Card pad={false}>
      <Table minWidth={1180} head={[{ label: "Fact" }, { label: "Now", right: true }, { label: "1 week", right: true }, { label: "1 month", right: true }, { label: "3 months", right: true }, { label: "Trend" }, { label: "In recent range", title: "0% = the recent low, 100% = the recent high" }, { label: "As of · source" }]}>
        {GROUPS.map((g) => (
          <React.Fragment key={g.id}>
            <tr>
              <td colSpan={8} className="border-b border-line-soft bg-accent-soft px-5 py-2 text-[13px] font-bold uppercase tracking-wide text-accent">
                {g.label} <span className="font-medium normal-case tracking-normal text-ink-3">· {g.horizon}</span>
              </td>
            </tr>
            {facts.filter((f) => f.group === g.id).map((f) => (
              <tr key={f.id}>
                <td className={`${TD} min-w-[280px]`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.label}</span>
                    {f.manual && <Tag title="Typed in by hand">Manual</Tag>}
                    {staleTag(f)}
                  </div>
                  {f.context && <div className="max-w-[320px] text-[13px] text-ink-3">{f.context}</div>}
                </td>
                <td className={`${TDN} text-[17px] font-semibold`}>{f.value}</td>
                <td className={`${TDN} ${signTone(f.d1w || f.change)}`}>{f.d1w || f.change || "—"}</td>
                <td className={`${TDN} ${signTone(f.d1m)}`}>{f.d1m || "—"}</td>
                <td className={`${TDN} ${signTone(f.d3m)}`}>{f.d3m || "—"}</td>
                <td className={TD}><Spark points={f.spark ?? []} /></td>
                <td className={TD}><RangeBar pct={f.rangePct} /></td>
                <td className={`${TD} whitespace-nowrap`}><AsOf at={f.asOf} source={f.source} /></td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </Table>
    </Card>
  );
}

export function FactCard({ f }: { f: Fact }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control border border-line-soft bg-surface px-4 py-3">
      <div className="text-[14px] font-medium leading-snug text-ink-2">{f.label}</div>
      {(f.manual || f.missing) && (
        <div className="flex flex-wrap gap-1.5">
          {f.manual && !f.missing && <Tag title="Typed in by hand">Manual</Tag>}
          {staleTag(f)}
        </div>
      )}
      <div className="flex items-end justify-between gap-3">
        <span className="figure text-[26px] leading-none">{f.value}</span>
        <Spark points={f.spark ?? []} width={110} height={32} />
      </div>
      <div className="flex flex-wrap gap-x-4 text-[13.5px]">
        <span><span className="text-ink-3">1 week </span><span className={`font-semibold ${signTone(f.d1w || f.change)}`}>{f.d1w || f.change || "—"}</span></span>
        <span><span className="text-ink-3">1 month </span><span className={`font-semibold ${signTone(f.d1m)}`}>{f.d1m || "—"}</span></span>
      </div>
      {f.context && <div className="text-[13px] leading-snug text-ink-3">{f.context}</div>}
      <AsOf at={f.asOf} source={f.source} />
    </div>
  );
}

function CardsView({ facts }: { facts: Fact[] }) {
  return (
    <>
      {GROUPS.map((g) => (
        <Card key={g.id} title={g.label} sub={g.horizon}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {facts.filter((f) => f.group === g.id).map((f) => <FactCard key={f.id} f={f} />)}
          </div>
        </Card>
      ))}
    </>
  );
}

export default function MarketFacts({ opt }: { opt: string }) {
  const { facts, loading, fetchedAt } = useFacts();
  const have = facts.filter((f) => !f.missing).length;
  return (
    <Page
      title="Market facts"
      lede="What the market is doing, as facts. No labels, no calls."
      right={<Link href="/redesign/manual-inputs" className={BTN}>Update manual inputs</Link>}
    >
      <StaleBanner />
      {loading && !have ? (
        <Card><Loading what="Loading market facts" /></Card>
      ) : !have ? (
        <Card><Empty>Market facts are not available right now.</Empty></Card>
      ) : opt === "b" ? (
        <ColumnsView facts={facts} />
      ) : opt === "c" ? (
        <TrendTable facts={facts} />
      ) : opt === "d" ? (
        <CardsView facts={facts} />
      ) : (
        <TableView facts={facts} />
      )}
      <p className="px-1 text-[13px] text-ink-3">
        {have} of {facts.length} facts available · loaded {fmtAsOf(fetchedAt)} · Change is coloured by direction only (up green, down red), not by whether it is good or bad.
      </p>
    </Page>
  );
}
