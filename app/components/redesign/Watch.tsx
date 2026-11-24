"use client";

/**
 * Redesign › Watch list. "I'd buy this at $X", set in advance, so the alert
 * does the remembering.
 *
 *  - Target buy price is edited INLINE in the table by anyone.
 *  - Zones: GREEN at or below target; YELLOW within 5% above it.
 *
 * WRITES: only the target price, through the existing `updateStockFields`
 * (one stock's `watch` object, every other plan field kept as it is).
 * Option A = one table sorted by distance to target. Option B = zone boards.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import TickerLink from "@/app/components/TickerLink";
import { displayTicker } from "@/app/lib/ticker";
import { watchRows, type WatchRow } from "@/app/lib/watchlist-plan";
import { usePrices } from "./data";
import { AsOf, BTN, Bullets, Card, Empty, fmtNum, fmtSigned, Figure, More, Page, Table, Tag, TD, TDN, type OptionDef } from "./ui";

export const WATCH_OPTIONS: OptionDef[] = [
  { id: "a", label: "One table", blurb: "Every watch list name in one table, closest to its target first. Type a target price straight into the row." },
  { id: "b", label: "Zone boards", blurb: "Three boards: in the green zone, in the yellow zone, and everything else. The names that need a decision are impossible to miss." },
];

export const YELLOW_PCT = 5;
export type Zone = "green" | "yellow" | "none" | "unset";

export function zoneOf(r: WatchRow): Zone {
  if (r.plan.targetBuyPrice == null || r.aboveTargetPct == null) return "unset";
  if (r.aboveTargetPct <= 0) return "green";
  if (r.aboveTargetPct <= YELLOW_PCT) return "yellow";
  return "none";
}

export function ZoneTag({ z }: { z: Zone }) {
  if (z === "green") return <Tag kind="green" title="At or below the target buy price">Green · at target</Tag>;
  if (z === "yellow") return <Tag kind="yellow" title={`Within ${YELLOW_PCT}% of the target buy price`}>Yellow · within {YELLOW_PCT}%</Tag>;
  if (z === "unset") return <span className="text-[13px] text-ink-3">No target set</span>;
  return <span className="text-[13px] text-ink-3">Above zone</span>;
}

/** Watch list rows with live prices, closest to target first; names with no target last. */
export function useWatch() {
  const { stocks, updateStockFields } = useStocks();
  const tickers = useMemo(() => stocks.filter((s) => s.bucket === "Watchlist").map((s) => s.ticker), [stocks]);
  const { prices, at } = usePrices(tickers);
  const rows = useMemo(() => {
    const all = watchRows(stocks, prices);
    return all.sort((a, b) => {
      const av = a.aboveTargetPct, bv = b.aboveTargetPct;
      if (av != null && bv != null) return av - bv;
      if (av != null) return -1;
      if (bv != null) return 1;
      return a.ticker.localeCompare(b.ticker);
    });
  }, [stocks, prices]);
  const setTarget = (r: WatchRow, target: number | undefined) => {
    const plan = { ...r.plan };
    if (target == null) delete plan.targetBuyPrice;
    else plan.targetBuyPrice = target;
    updateStockFields(r.ticker, { watch: plan });
  };
  return { rows, at, setTarget };
}

/** Inline target-price box: saves on Enter or when focus leaves, only if changed. */
function TargetInput({ row, onSave }: { row: WatchRow; onSave: (v: number | undefined) => void }) {
  const current = row.plan.targetBuyPrice;
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const t = text.trim();
    const v = parseFloat(t);
    if (t === "") {
      if (current != null) onSave(undefined);
    } else if (Number.isFinite(v) && v > 0 && v !== current) onSave(v);
    setText(null);
  };
  return (
    <input
      inputMode="decimal"
      aria-label={`Target buy price for ${row.ticker}`}
      value={text ?? (current != null ? String(current) : "")}
      placeholder="set target"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
      className="h-10 w-[110px] rounded-control border border-line bg-surface px-2.5 text-right text-[15px] tabular-nums text-ink focus:border-accent focus:outline-none"
    />
  );
}

function Row({ r, onSave }: { r: WatchRow; onSave: (v: number | undefined) => void }) {
  const z = zoneOf(r);
  const tint = z === "green" ? "bg-pos-soft/50" : z === "yellow" ? "bg-warn-soft/60" : "";
  const yellowAt = r.plan.targetBuyPrice != null ? r.plan.targetBuyPrice * (1 + YELLOW_PCT / 100) : null;
  return (
    <tr className={tint}>
      <td className={TD}>
        <TickerLink ticker={r.ticker} className="text-[16px] font-bold text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink>
        <div className="max-w-[240px] truncate text-[13px] text-ink-3">{r.name || "—"}</div>
      </td>
      <td className={`${TDN} text-[16px] font-semibold`}>{fmtNum(r.price)}</td>
      <td className={TDN}><TargetInput row={r} onSave={onSave} /></td>
      <td className={`${TDN} text-ink-2`} title={`Yellow zone starts ${YELLOW_PCT}% above the target`}>{yellowAt != null ? fmtNum(yellowAt) : "—"}</td>
      <td className={TDN}>{r.aboveTargetPct == null ? "—" : fmtSigned(r.aboveTargetPct)}</td>
      <td className={TD}><ZoneTag z={z} /></td>
    </tr>
  );
}

const HEAD = [
  { label: "Name" },
  { label: "Price", right: true },
  { label: "Target buy", right: true, title: "Type a price and press Enter" },
  { label: "Yellow from", right: true, title: "5% above the target" },
  { label: "To target", right: true, title: "How far the price is above the target" },
  { label: "Zone" },
];

function PlanDetails({ rows }: { rows: WatchRow[] }) {
  const withPlan = rows.filter((r) => r.plan.thesis || r.plan.breakers || r.plan.addedOn);
  if (!withPlan.length) return <Empty>No notes on file yet.</Empty>;
  return (
    <div className="flex flex-col gap-4 pt-1">
      {withPlan.map((r) => (
        <div key={r.ticker}>
          <div className="text-[15px] font-bold">{displayTicker(r.ticker)} <span className="font-normal text-ink-3">{r.name}</span></div>
          <Bullets
            className="mt-1"
            items={[
              r.plan.thesis ? <>Why own it: {r.plan.thesis}</> : null,
              r.plan.breakers ? <>Drop it if: {r.plan.breakers}</> : null,
              r.plan.addedOn ? <>Added {r.plan.addedOn}{r.plan.addedBy ? ` by ${r.plan.addedBy}` : ""}{r.plan.priceAtAdd != null ? ` at ${fmtNum(r.plan.priceAtAdd)}` : ""}{r.sinceAddPct != null ? ` (${fmtSigned(r.sinceAddPct)} since)` : ""}</> : null,
            ].filter(Boolean) as React.ReactNode[]}
          />
        </div>
      ))}
    </div>
  );
}

export default function WatchList({ opt }: { opt: string }) {
  const { rows, at, setTarget } = useWatch();
  const green = rows.filter((r) => zoneOf(r) === "green");
  const yellow = rows.filter((r) => zoneOf(r) === "yellow");
  const rest = rows.filter((r) => zoneOf(r) === "none" || zoneOf(r) === "unset");
  const unset = rows.filter((r) => zoneOf(r) === "unset").length;

  const table = (list: WatchRow[]) => (
    <Table head={HEAD} minWidth={760}>
      {list.map((r) => <Row key={r.ticker} r={r} onSave={(v) => setTarget(r, v)} />)}
    </Table>
  );

  return (
    <Page title="Watch list" lede="What we would buy, and the price we set in advance." right={<Link href="/watchlist" className={BTN}>Current watchlist page</Link>}>
      <Card>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Figure label="Green zone" value={green.length} valueClass={green.length ? "text-pos" : ""} sub="at or below target" />
          <Figure label="Yellow zone" value={yellow.length} valueClass={yellow.length ? "text-warn" : ""} sub={`within ${YELLOW_PCT}% of target`} />
          <Figure label="On the watch list" value={rows.length} sub={`${rows.length - unset} with a target`} />
          <Figure label="No target yet" value={unset} sub="type one in the table" />
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card><Empty>Nothing on the watch list.</Empty></Card>
      ) : opt === "b" ? (
        <>
          <Card title="Green zone" sub="at or below the price we set" pad={false} className="border-pos-border">
            {green.length ? table(green) : <div className="px-5"><Empty>No names at target.</Empty></div>}
          </Card>
          <Card title="Yellow zone" sub={`within ${YELLOW_PCT}% of target`} pad={false} className="border-warn-border">
            {yellow.length ? table(yellow) : <div className="px-5"><Empty>No names close to target.</Empty></div>}
          </Card>
          <Card title="Everything else" sub={`${rest.length} names`} pad={false}>
            <More prefKey="redesign.watch.rest" label="the rest of the watch list" count={rest.length} defaultOpen>
              <div className="-mx-5">{table(rest)}</div>
            </More>
          </Card>
        </>
      ) : (
        <Card title="Watch list" sub={<AsOf at={at} source="Yahoo Finance prices, each stock's own currency" />} pad={false}>
          {table(rows)}
        </Card>
      )}

      <Card title="Notes on each name" pad={false}>
        <More prefKey="redesign.watch.notes" label="why we would own each name" count={rows.filter((r) => r.plan.thesis || r.plan.breakers || r.plan.addedOn).length}>
          <PlanDetails rows={rows} />
        </More>
      </Card>
      <p className="px-1 text-[13px] text-ink-3">
        Type a target and press Enter to save; clear the box to remove it. Green = at or below target. Yellow = within {YELLOW_PCT}% above it.
      </p>
    </Page>
  );
}
