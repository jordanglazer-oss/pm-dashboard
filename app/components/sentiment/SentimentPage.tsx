"use client";

/**
 * Sentiment — its own page (Nov 26 2026 team session). Every sentiment
 * reading we track, as facts with dates and sources, each with its trend
 * (sparkline, 1-week and 1-month change), plus J.P. Morgan Flows & Liquidity
 * from the strategist reports on file. READ-ONLY; no reading of the data.
 */

import React, { useMemo } from "react";
import Link from "next/link";
import type { StrategistReport } from "@/app/lib/strategist-reports";
import { useFacts, useGet } from "@/app/components/redesign/data";
import { FactCard, StaleBanner } from "@/app/components/redesign/Market";
import { Bullets, Card, Empty, fmtAsOf, Loading, Page, Table, TD } from "@/app/components/redesign/ui";

/** Shown in this order. Ids are the fact ids in redesign/facts.ts. */
export const SENTIMENT_FACT_IDS = ["fearGreed", "aaii", "putCall", "oscillator", "vix", "move", "breadth50", "breadth200", "newHighs", "newLows"];

const isFlows = (r: StrategistReport) => /flows?\s*(&|and)\s*liquidity|panigirtzoglou/i.test(`${r.title} ${r.subject} ${r.author ?? ""}`);

export default function SentimentPage() {
  const { facts, loading } = useFacts();
  const rows = useMemo(() => SENTIMENT_FACT_IDS.map((id) => facts.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => Boolean(f)), [facts]);
  const reports = useGet<StrategistReport[]>("/api/strategist-reports", (raw) => (raw as { reports?: StrategistReport[] })?.reports ?? null);
  const flows = useMemo(() => (reports.data ?? []).filter(isFlows).sort((a, b) => b.date.localeCompare(a.date)), [reports.data]);
  const latest = flows[0];

  return (
    <Page title="Sentiment" lede="Every sentiment reading we track, with its trend. Data only.">
      <StaleBanner />
      <Card title="Readings" sub="latest value · 1 week · 1 month">
        {loading && !rows.some((f) => !f.missing) ? <Loading what="Loading sentiment data" /> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{rows.map((f) => <FactCard key={f.id} f={f} />)}</div>}
      </Card>

      <Card title="Trend" sub="change over time" pad={false}>
        <Table head={[{ label: "Reading" }, { label: "Latest", right: true }, { label: "1 week", right: true }, { label: "1 month", right: true }, { label: "As of" }, { label: "Source" }]} minWidth={760}>
          {rows.map((f) => (
            <tr key={f.id}>
              <td className={TD}>{f.label}</td>
              <td className={`${TD} text-right tabular-nums`}>{f.value}</td>
              <td className={`${TD} text-right tabular-nums`}>{f.d1w || f.change || "—"}</td>
              <td className={`${TD} text-right tabular-nums`}>{f.d1m || "—"}</td>
              <td className={TD}>{f.asOf ? fmtAsOf(f.asOf) : "no data yet"}</td>
              <td className={TD}>{f.source}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="J.P. Morgan Flows & Liquidity" sub="Nikolaos Panigirtzoglou · the report's view, not ours">
        {reports.loading ? (
          <Loading what="Loading reports" />
        ) : !latest ? (
          <>
            <Empty>No report on file yet.</Empty>
            <Bullets items={[<>Forward the report to the dashboard inbox with a subject starting <span className="font-semibold">Strategy: JPM – Flows &amp; Liquidity</span>.</>, "Its summary and date appear here; earlier reports stay listed below it."]} />
          </>
        ) : (
          <>
            <div className="text-[15px] font-semibold text-ink">{latest.title}</div>
            <div className="text-[12.5px] text-ink-3">{latest.date} · {flows.length} on file</div>
            {latest.summary?.bullets?.length ? <Bullets className="mt-2" items={latest.summary.bullets} /> : <Empty>{latest.summaryError ? "The summary could not be written for this report." : "No summary yet."}</Empty>}
            <Link href="/strategists" className="mt-2 inline-block text-[14px] font-semibold !text-accent underline">Full summary and earlier reports</Link>
          </>
        )}
      </Card>
    </Page>
  );
}
