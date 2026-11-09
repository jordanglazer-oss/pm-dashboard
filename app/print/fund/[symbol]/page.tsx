"use client";

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { FundOnePager, FundRow } from "@/app/lib/fund-one-pagers-shared";

/**
 * Print view of one signed fund one-pager — clean, single page, browser
 * Print → Save as PDF. Lives OUTSIDE the (dashboard) group so no app chrome
 * renders; the data comes from /api/fund-one-pagers, which the auth
 * middleware still protects (no cookie → nothing to show). The internal "would make us reconsider" line and the
 * source list are NOT printed.
 */

const pctOr = (v?: number) => (v == null ? "—" : `${v.toFixed(1)}%`);

export default function FundPrintPage() {
  const { symbol } = useParams<{ symbol: string }>();
  const sym = decodeURIComponent(symbol ?? "").toUpperCase();
  const [data, setData] = useState<{ fund?: FundRow; pager?: FundOnePager } | null>(null);

  useEffect(() => {
    fetch("/api/fund-one-pagers")
      .then((r) => r.json())
      .then((d: { funds: FundRow[]; pagers: Record<string, FundOnePager> }) => setData({ fund: d.funds.find((f) => f.symbol.toUpperCase() === sym), pager: d.pagers[sym] }))
      .catch(() => setData({}));
  }, [sym]);

  if (!data) return <p className="p-6 text-[13px] text-ink-3">Loading…</p>;
  const { pager: p, fund } = data;
  if (!p) return <p className="p-6 text-[13px] text-ink-3">No signed one-pager for {sym} yet.</p>;
  const f = fund?.facts;

  return (
    <div className="fund-print mx-auto max-w-[780px] bg-white p-8 text-[12.5px] leading-relaxed text-[#1c1c1c]">
      <style>{`@media print { .no-print { display: none !important; } body { background: #fff !important; } .fund-print { padding: 0 !important; max-width: none !important; } @page { margin: 14mm; } }`}</style>
      <div className="no-print mb-4 flex justify-end">
        <button onClick={() => window.print()} className="rounded border border-[#ccc] px-3 py-1 text-[12.5px]">Print / Save as PDF</button>
      </div>
      <div className="border-b border-[#1c2a44] pb-2">
        <div className="text-[11px] uppercase tracking-[0.12em] text-[#5a6070]">Why we own it</div>
        <h1 className="text-[22px] font-semibold text-[#1c2a44]">{p.name || sym}</h1>
        <div className="text-[12px] text-[#5a6070]">
          {sym}
          {f?.category ? ` · ${f.category}` : ""}
          {f?.expenseRatio != null ? ` · MER ${f.expenseRatio}%` : ""}
        </div>
      </div>
      <p className="mt-3 text-[14.5px] font-medium text-[#1c2a44]">{p.headline}</p>

      <div className="mt-3 grid grid-cols-2 gap-5">
        <div className="flex flex-col gap-3">
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">Why we own it</h2>
            <ul className="mt-1 list-disc pl-4">{p.whyWeOwn.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </section>
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">The manager</h2>
            <p className="mt-1">
              <strong>{p.manager.firm}</strong>
              {p.manager.team ? ` — ${p.manager.team}` : ""}
              {p.manager.since ? ` (${p.manager.since})` : ""}
            </p>
            <p className="mt-1">{p.manager.philosophy}</p>
          </section>
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">How they invest</h2>
            <p className="mt-1">{p.process}</p>
          </section>
        </div>
        <div className="flex flex-col gap-3">
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">Its role in our portfolio</h2>
            <p className="mt-1">{p.role}</p>
          </section>
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">Track record</h2>
            <p className="mt-1">{p.record}</p>
            {f?.perf && (
              <table className="mt-1.5 w-full text-[11.5px]">
                <thead>
                  <tr className="text-[#5a6070]">
                    <th className="text-left font-normal">Annualised</th>
                    <th className="text-right font-normal">1 yr</th>
                    <th className="text-right font-normal">3 yr</th>
                    <th className="text-right font-normal">5 yr</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Fund</td>
                    <td className="text-right">{pctOr(f.perf.oneYear)}</td>
                    <td className="text-right">{pctOr(f.perf.threeYear)}</td>
                    <td className="text-right">{pctOr(f.perf.fiveYear)}</td>
                  </tr>
                  {f.categoryPerf && (
                    <tr>
                      <td>Category average</td>
                      <td className="text-right">{pctOr(f.categoryPerf.oneYear)}</td>
                      <td className="text-right">{pctOr(f.categoryPerf.threeYear)}</td>
                      <td className="text-right">{pctOr(f.categoryPerf.fiveYear)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">Fees</h2>
            <p className="mt-1">{p.fees}</p>
          </section>
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">Risks to understand</h2>
            <ul className="mt-1 list-disc pl-4">{p.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </section>
        </div>
      </div>

      <section className="mt-4 rounded border border-[#e3e0d8] bg-[#faf8f3] p-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1c2a44]">In a sentence or two</h2>
        <ul className="mt-1 list-disc pl-4">{p.talkingPoints.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </section>

      <p className="mt-4 text-[10px] leading-snug text-[#7a7f8c]">
        Performance figures {f?.asOf ? `as of ${f.asOf}` : "from the latest data on file"}, annualised, in the fund&apos;s currency, net of fees where reported. Past performance is not indicative of future results. For discussion purposes only. Prepared {p.signedAt?.slice(0, 10)}.
      </p>
    </div>
  );
}
