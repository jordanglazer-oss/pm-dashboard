"use client";

import React, { useEffect, useState } from "react";
import { Sparkline } from "@/app/components/Sparkline";
import { displayTicker } from "@/app/lib/ticker";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { Explain } from "@/app/components/Explain";
import { PERIOD_PRESETS, periodRange, type PeriodPreset } from "@/app/lib/period-presets";
import type { CurrencyImpact, FxClass, FxRow } from "@/app/lib/currency-impact";

/**
 * Currency impact — how much of the PIM book's return came from the US
 * dollar over a period, and what the CAD-hedged holdings gave up or saved
 * (GET /api/currency-impact). Read-only; an ESTIMATE on today's model
 * weights. Separate from alpha, which is already currency-neutral.
 */

type Resp = CurrencyImpact & { profile: string; profiles: string[]; from: string; to: string; rows: FxRow[]; hedgedList: string[]; fxAvailable: boolean; notes: string[]; error?: string };

const PROFILE_LABEL: Record<string, string> = { conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity" };
const CLASS_LABEL: Record<FxClass, string> = { "usd-unhedged": "US dollar, unhedged", hedged: "CAD-hedged", cad: "Canadian dollar", unclassified: "Not classified" };
const pts = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const share = (v: number) => `${(v * 100).toFixed(1)}%`;
const tone = (v: number | null | undefined) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

export type CurrencyResp = Resp;

/** The currency read-out without its own header or date controls — the caller
 *  owns the range and the fetch (the merged "Where returns came from" panel). */
export function CurrencyView({ data }: { data: Resp | null }) {
  const [showRows, toggleRows] = usePersistedOpen("aa.currencyImpact.rows", false);
  return (
    <>
    {!data ? (
      <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
    ) : data.error ? (
      <p className="px-3.5 py-3 text-[12.5px] text-neg">{data.error}</p>
    ) : !data.fxAvailable || data.fxPct == null ? (
      <p className="px-3.5 py-3 text-[12.5px] text-ink-3">No USD/CAD history for this period.</p>
    ) : (
      <>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 py-3 lg:grid-cols-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Currency contribution</div>
            <div className={`text-[20px] font-semibold tabular-nums ${tone(data.contributionPct)}`}>{pts(data.contributionPct)}</div>
            <div className="text-[12px] text-ink-3">points of the {PROFILE_LABEL[data.profile] ?? data.profile} return · estimate</div>
            <div className="mt-1">
              <Sparkline points={data.series} width={160} height={28} />
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">US dollar vs Canadian</div>
            <div className={`text-[20px] font-semibold tabular-nums ${tone(data.fxPct)}`}>{pts(data.fxPct)}</div>
            <div className="text-[12px] text-ink-3">USD/CAD move{data.partial ? " · partial history" : ""}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Unhedged US-dollar share</div>
            <div className="text-[20px] font-semibold tabular-nums text-ink">{share(data.unhedgedWeight)}</div>
            <div className="text-[12px] text-ink-3">
              CAD-hedged {share(data.hedgedWeight)}
              {data.unclassifiedWeight > 0 ? ` · not classified ${share(data.unclassifiedWeight)}` : ""}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Hedging effect</div>
            <div className={`text-[20px] font-semibold tabular-nums ${tone(data.hedgingEffectPct)}`}>{pts(data.hedgingEffectPct)}</div>
            <div className="text-[12px] text-ink-3">vs the same funds unhedged · estimate</div>
          </div>
        </div>
        <Explain prefKey="explain.perf.currency" label="How currency is calculated" className="px-3.5 pb-2">
          <ul className="list-disc pl-4">
            <li>Currency contribution = the unhedged US-dollar share × the USD/CAD move, using today&apos;s model weights for the whole period.</li>
            <li>Hedging effect = what the CAD-hedged holdings saved (+) or gave up (−) against holding the same funds unhedged, before the cost of hedging.</li>
            <li>Hedged holdings: {data.hedgedList.join(", ")}. Fidelity Global Innovators is counted in full as unhedged.</li>
            <li>Separate from alpha, which is measured against the S&amp;P 500 in C$ and is already currency-neutral.</li>
          </ul>
        </Explain>
        <button className="px-3.5 pb-2.5 text-[12.5px] text-accent" onClick={toggleRows}>
          {showRows ? "Hide" : "Show"} every holding ({data.rows.length})
        </button>
        {showRows && (
          <div className="tbl-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Holding</th>
                  <th>Priced in</th>
                  <th className="n">Share of portfolio</th>
                  <th>Counted as</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.symbol}>
                    <td className="pl-3.5">
                      <span className="font-medium">{displayTicker(r.symbol)}</span>
                      <div className="text-[11px] text-ink-3">{r.name}</div>
                    </td>
                    <td>{r.currency}</td>
                    <td className="n">{(r.weight * 100).toFixed(2)}%</td>
                    <td>
                      <span className={r.cls === "unclassified" ? "text-warn" : "text-ink-2"}>{CLASS_LABEL[r.cls]}</span>
                    </td>
                    <td>
                      <span className="text-[12px] text-ink-3">{r.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    )}
    </>
  );
}

export function CurrencyImpactPanel() {
  const [open, toggle] = usePersistedOpen("aa.currencyImpact.open", true);
  const [preset, setPreset] = useState<PeriodPreset>("ytd");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [profile, setProfile] = useState("balanced");
  const [loaded, setLoaded] = useState<{ key: string; data: Resp } | null>(null);

  const range = periodRange(preset, custom);
  const from = range.from ?? "";
  const to = range.to;

  const key = `${from}|${to}|${profile}`;

  useEffect(() => {
    if (!open) return;
    let live = true;
    const qs = new URLSearchParams({ to, profile });
    if (from) qs.set("from", from);
    fetch(`/api/currency-impact?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: Resp) => live && setLoaded({ key, data: d }))
      .catch(() => live && setLoaded({ key, data: { error: "Could not load." } as Resp }));
    return () => {
      live = false;
    };
  }, [open, from, to, profile, key]);

  // The last answer stays on screen while a new period loads.
  const data = loaded?.data ?? null;
  const loading = open && loaded?.key !== key;

  return (
    <section className="panel">
      <button className="panel-h w-full text-left" onClick={toggle}>
        <span className="t">Currency impact</span>
        <span className="m">How much of the return came from the US dollar · estimate · {open ? "hide" : "show"}</span>
      </button>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
            <div className="seg">
              {PERIOD_PRESETS.map((p) => (
                <button key={p.key} className={preset === p.key ? "on" : ""} onClick={() => setPreset(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
                From
                <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
                to
                <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
              </span>
            )}
            {(data?.profiles?.length ?? 0) > 1 && (
              <div className="seg">
                {data!.profiles.map((p) => (
                  <button key={p} className={data!.profile === p ? "on" : ""} onClick={() => setProfile(p)}>
                    {PROFILE_LABEL[p] ?? p}
                  </button>
                ))}
              </div>
            )}
            <span className="text-[12px] text-ink-3">
              {loading ? "Loading…" : data?.fxBase && data.fxEnd ? `USD/CAD from the ${data.fxBase.date} close (${data.fxBase.value.toFixed(4)}) to the ${data.fxEnd.date} close (${data.fxEnd.value.toFixed(4)})` : ""}
            </span>
          </div>

          <CurrencyView data={data} />
        </>
      )}
    </section>
  );
}
