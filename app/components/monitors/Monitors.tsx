"use client";

/**
 * Monitors — one page, one toggle (Nov 2026 hackathon scaffold):
 *   Hedging           the existing hedging dashboard, unchanged
 *   Sentiment         sentiment data only, as facts with dates and sources
 *   Currency outlook  USD-focused: the level today, and the currency views in
 *                     the RBC / J.P. Morgan / other reports on file
 *
 * READ-ONLY. The chosen tab persists in pm:ui-prefs. The existing /hedging
 * page is untouched and still reachable.
 */

import React, { useMemo } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import HedgingDashboard from "@/app/components/HedgingDashboard";
import type { StrategistReport } from "@/app/lib/strategist-reports";
import { useFacts, useGet, usePrices } from "@/app/components/redesign/data";
import { FactCard, StaleBanner } from "@/app/components/redesign/Market";
import { Bullets, Card, Empty, fmtAsOf, fmtNum, Loading, Page, Table, TD } from "@/app/components/redesign/ui";

type Tab = "hedging" | "sentiment" | "currency";
const TABS: { id: Tab; label: string }[] = [
  { id: "hedging", label: "Hedging" },
  { id: "sentiment", label: "Sentiment" },
  { id: "currency", label: "Currency outlook" },
];
const SENTIMENT_IDS = ["fearGreed", "aaii", "putCall", "oscillator", "vix"];

export function Sentiment() {
  const { facts, loading } = useFacts();
  const rows = facts.filter((f) => SENTIMENT_IDS.includes(f.id));
  return (
    <>
      <StaleBanner />
      <Card title="Sentiment" sub="data only — no reading of it">
        {loading && !rows.some((f) => !f.missing) ? <Loading what="Loading sentiment data" /> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{rows.map((f) => <FactCard key={f.id} f={f} />)}</div>}
      </Card>
    </>
  );
}

const firmLabel = (r: StrategistReport) => (r.firm === "Other" ? r.firmName || "Other" : r.firm === "JPM" ? "J.P. Morgan" : r.firm);

function Currency() {
  const { prices, at } = usePrices(["USDCAD=X"]);
  const usdcad = prices["USDCAD=X"] ?? null;
  const reports = useGet<StrategistReport[]>("/api/strategist-reports", (raw) => (raw as { reports?: StrategistReport[] })?.reports ?? null);
  const { views, fxReports } = useMemo(() => {
    const all = (reports.data ?? []).filter((r) => r.source !== "note");
    const views = all.flatMap((r) => (r.summary?.fx ?? []).map((f) => ({ ...f, r })));
    return { views, fxReports: all.filter((r) => r.kind === "fx") };
  }, [reports.data]);
  return (
    <>
      <Card title="US dollar today">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div>
            <div className="text-[13px] font-medium text-ink-3">USD/CAD</div>
            <div className="figure text-[30px] leading-tight">{usdcad ? fmtNum(usdcad, 4) : "—"}</div>
            <div className="text-[12.5px] text-ink-3">{at ? `${fmtAsOf(at)} · Yahoo Finance` : "loading"}</div>
          </div>
          <div>
            <div className="text-[13px] font-medium text-ink-3">One US dollar costs</div>
            <div className="figure text-[30px] leading-tight">{usdcad ? `C$${fmtNum(usdcad, 2)}` : "—"}</div>
            <div className="text-[12.5px] text-ink-3">one Canadian dollar = US${usdcad ? fmtNum(1 / usdcad, 4) : "—"}</div>
          </div>
          <Link href="/aa-performance" className="ml-auto text-[14px] font-semibold !text-accent underline">How currency has helped or hurt the portfolio</Link>
        </div>
      </Card>

      <Card title="Currency views in the reports on file" sub="the forecasters' views, not ours" pad={false}>
        {reports.loading ? (
          <div className="px-5"><Loading what="Loading reports" /></div>
        ) : !views.length ? (
          <div className="px-5 py-1">
            <Empty>No currency views on file yet.</Empty>
            <Bullets
              className="pb-4"
              items={[
                <>Forward an FX report to the dashboard inbox with a subject starting <span className="font-semibold">FX: RBC – …</span>, <span className="font-semibold">FX: JPM – …</span> or <span className="font-semibold">FX: Other – …</span></>,
                "Any forecast or view it states (USD/CAD and others) is listed here with its date and source.",
              ]}
            />
          </div>
        ) : (
          <Table head={[{ label: "Pair" }, { label: "View" }, { label: "Forecast" }, { label: "Horizon" }, { label: "Source" }, { label: "Report date" }]} minWidth={820}>
            {views.map((v, i) => (
              <tr key={`${v.r.id}-${i}`}>
                <td className={`${TD} whitespace-nowrap font-bold`}>{v.pair}</td>
                <td className={`${TD} max-w-[300px] text-[14.5px]`}>{v.view || "—"}</td>
                <td className={`${TD} whitespace-nowrap`}>{v.forecast ?? "—"}</td>
                <td className={`${TD} whitespace-nowrap text-ink-2`}>{v.horizon ?? "—"}</td>
                <td className={`${TD} whitespace-nowrap`}>{firmLabel(v.r)}{v.r.author ? <span className="text-ink-3"> · {v.r.author}</span> : null}</td>
                <td className={`${TD} whitespace-nowrap text-ink-2`}>{fmtAsOf(v.r.date)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {fxReports.length > 0 && (
        <Card title="Currency reports" sub={`${fxReports.length} on file`}>
          <Bullets items={fxReports.slice(0, 12).map((r) => <><span className="font-semibold">{firmLabel(r)}</span> · {fmtAsOf(r.date)} · {r.summary?.stance ?? r.title}</>)} />
          <Link href="/strategists" className="mt-3 inline-block text-[14px] font-semibold !text-accent underline">Open on Strategists</Link>
        </Card>
      )}
    </>
  );
}

export default function Monitors() {
  const { uiPrefs, setUiPref } = useStocks();
  const tab: Tab = TABS.some((t) => t.id === uiPrefs["monitors.tab"]) ? (uiPrefs["monitors.tab"] as Tab) : "hedging";
  return (
    <Page title="Monitors" lede="Hedging, sentiment and the currency outlook, in one place.">
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setUiPref("monitors.tab", t.id)} className={`h-10 rounded-control border px-4 text-[15px] font-semibold ${tab === t.id ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "hedging" && <div className="flex flex-col gap-3.5"><HedgingDashboard /></div>}
      {tab === "sentiment" && <Sentiment />}
      {tab === "currency" && <Currency />}
    </Page>
  );
}
