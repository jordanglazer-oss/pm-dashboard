"use client";

/**
 * Fund page › Performance (Nov 2026).
 *
 * The trailing returns stored on a fund record are the data provider's
 * MONTH-END figures, captured whenever fund data was last refreshed — and
 * they were shown with no date. On 2026-11-24 the page read FID5982 +40.62%
 * and DYN3361 +7.94% year to date: both correct for October 30, both well
 * off by late November (+37.9% and +4.07%, matching FactSet).
 *
 * For a MUTUAL FUND the short periods (1M · 3M · YTD · 1Y) are now computed
 * here from the fund's NAV history with distributions reinvested, through the
 * latest NAV, and the date is shown. The longer annualized figures (3Y · 5Y ·
 * 10Y) stay the provider's, with their as-of date. ETFs keep the provider
 * figures, now dated.
 *
 * READ-ONLY: one POST to the existing /api/report-history (no Redis).
 */

import React, { useEffect, useState } from "react";
import { StatStrip } from "@/app/components/StatStrip";
import type { FundData } from "@/app/lib/types";
import { bareFundCode, isFundCode, returnSinceDate, ytdReturn, type NavPoint } from "@/app/lib/fund-nav";

const fmt = (v: number | null | undefined) => (v == null ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const tone = (v: number | null | undefined) => (v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg");
const shortDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = plain ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: plain ? "UTC" : "America/New_York" });
};
/** YYYY-MM-DD shifted back by whole calendar months. */
function monthsBefore(date: string, months: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function useFundSeries(ticker: string): NavPoint[] | null {
  const fund = isFundCode(ticker);
  const [series, setSeries] = useState<NavPoint[] | null>(null);
  useEffect(() => {
    if (!fund) return;
    let alive = true;
    const code = bareFundCode(ticker);
    fetch("/api/report-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: [code], range: "2y", funds: true }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { series?: Record<string, [number, number][]> } | null) => {
        if (!alive) return;
        const rows = d?.series?.[code] ?? [];
        setSeries(rows.map(([ms, nav]) => ({ date: new Date(ms).toISOString().slice(0, 10), nav })));
      })
      .catch(() => alive && setSeries([]));
    return () => {
      alive = false;
    };
  }, [fund, ticker]);
  return fund ? series : null;
}

export function FundPerformancePanel({ fundData, ticker }: { fundData: FundData; ticker: string }) {
  const series = useFundSeries(ticker);
  const p = fundData.performance;
  const live = series && series.length > 20 ? series : null;
  const through = live ? live[live.length - 1].date : null;
  const computed = live && through ? { oneMonth: returnSinceDate(live, monthsBefore(through, 1)), threeMonth: returnSinceDate(live, monthsBefore(through, 3)), ytd: ytdReturn(live), oneYear: returnSinceDate(live, monthsBefore(through, 12)) } : null;
  if (!p && !computed) return null;

  const providerAsOf = shortDate(fundData.lastUpdated);
  const short: { label: string; val: number | null | undefined }[] = [
    { label: "1M", val: computed?.oneMonth ?? p?.oneMonth },
    { label: "3M", val: computed?.threeMonth ?? p?.threeMonth },
    { label: "YTD", val: computed?.ytd ?? p?.ytd },
    { label: "1Y", val: computed?.oneYear ?? p?.oneYear },
  ];
  const long: { label: string; val: number | null | undefined }[] = [
    { label: "3Y", val: p?.threeYear },
    { label: "5Y", val: p?.fiveYear },
    { label: "10Y", val: p?.tenYear },
  ];
  const hasLong = long.some((r) => r.val != null);

  return (
    <section className="panel">
      <div className="panel-h">
        <span className="t">Performance</span>
        <span className="m">{computed ? `through ${shortDate(through)} · distributions reinvested` : providerAsOf ? `provider figures · fetched ${providerAsOf}` : "provider figures · date not on file"}</span>
      </div>
      <div className="p-2.5">
        <StatStrip
          cols={4}
          items={[...short, ...long]
            .filter((r) => r.val != null)
            .map((r) => ({ label: r.label, value: <span className={tone(r.val)}>{fmt(r.val)}</span> }))}
        />
        {computed && hasLong && (
          <p className="px-1 pt-2 text-[11.5px] text-ink-3">
            1M · 3M · YTD · 1Y: from the fund&apos;s daily NAV. 3Y · 5Y · 10Y: the provider&apos;s annualized month-end figures{providerAsOf ? `, fetched ${providerAsOf}` : ""}.
          </p>
        )}
        {!computed && (
          <p className="px-1 pt-2 text-[11.5px] text-warn">
            These are the provider&apos;s month-end figures and can be weeks old. Use &ldquo;Refresh data&rdquo; to update them.
          </p>
        )}
      </div>
    </section>
  );
}
