"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { PERIOD_PRESETS, periodRange, type PeriodPreset } from "@/app/lib/period-presets";
import type { RangeAttributionResponse } from "@/app/lib/range-attribution-load";
import { ContributionView } from "@/app/components/ContributionPanel";
import { CurrencyView, type CurrencyResp } from "@/app/components/CurrencyImpactPanel";

/**
 * Where returns came from (Nov 2026) — ONE panel, one date range, three
 * levels, replacing three overlapping panels (Return attribution,
 * Contribution by holding, Currency impact) for the PIM equity book:
 *
 *   1. Summary   — recorded return = market + currency + selection.
 *   2. By sleeve and holding — top 5 / bottom 5, sleeve table, full table.
 *   3. Currency detail — unhedged share, USD/CAD move, hedging effect.
 *
 * ONE currency method everywhere in this panel: the PM-confirmed hedged /
 * unhedged classification (app/lib/currency-impact.ts) × the USD/CAD move.
 * Market = the book's beta × a blend of the S&P 500 (US$) and the TSX at the
 * book's US / Canada mix (both from the existing attribution build).
 * Selection = whatever is left of the RECORDED return. READ-ONLY; every
 * figure but the recorded return is an estimate and is labelled so.
 */

type Bar = { date: string; close: number };
type IndexResp = { indexes: { key: string; history: Bar[] }[] };
type AttrMeta = { equityBeta?: number; usdEquityFractionPct?: number };

const pts = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`);
const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

/** % change between the last closes on or before two dates. */
function retBetween(hist: Bar[] | undefined, base: string, end: string): number | null {
  if (!hist?.length) return null;
  const at = (d: string) => {
    let v: number | null = null;
    for (const b of hist) {
      if (b.date > d) break;
      v = b.close;
    }
    return v;
  };
  const a = at(base);
  const b = at(end);
  return a && b ? (b / a - 1) * 100 : null;
}

function Cell({ label, value, note, strong }: { label: string; value: number | null; note: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`${strong ? "text-[22px]" : "text-[20px]"} font-semibold tabular-nums ${tone(value)}`}>{pts(value)}</div>
      <div className="text-[12px] leading-snug text-ink-3">{note}</div>
    </div>
  );
}

export function ReturnSourcesPanel() {
  const [preset, setPreset] = useState<PeriodPreset>("ytd");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [showCurrency, toggleCurrency] = usePersistedOpen("perf.sources.currency", false);
  const [contrib, setContrib] = useState<{ key: string; data: RangeAttributionResponse } | null>(null);
  const [fx, setFx] = useState<{ key: string; data: CurrencyResp } | null>(null);
  const [indexes, setIndexes] = useState<IndexResp | null>(null);
  const [meta, setMeta] = useState<AttrMeta | null>(null);

  const range = periodRange(preset, custom);
  const from = range.from ?? "";
  const to = range.to;
  const ready = preset !== "custom" || !custom.from || !custom.to || custom.from <= custom.to;
  const key = `${from}|${to}`;

  // Benchmarks and the book's beta / US mix: loaded once.
  useEffect(() => {
    let live = true;
    fetch("/api/index-history?extended=1").then((r) => r.json()).then((d: IndexResp) => live && setIndexes(d)).catch(() => {});
    // The route wraps its payload: { attribution: { equityBeta, usdEquityFractionPct, … } }.
    fetch("/api/attribution").then((r) => (r.ok ? r.json() : null)).then((d: { attribution?: AttrMeta | null } | null) => live && setMeta(d?.attribution ?? {})).catch(() => live && setMeta({}));
    return () => {
      live = false;
    };
  }, []);

  // The two range reads, once per range, shared by every level below.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const tag = `${from}|${to}`;
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    q.set("to", to);
    fetch(`/api/attribution/range?${q.toString()}`)
      .then((r) => r.json())
      .then((d: RangeAttributionResponse) => live && setContrib({ key: tag, data: d }))
      .catch(() => live && setContrib({ key: tag, data: { ok: false, error: "Could not load the contribution data." } }));
    const q2 = new URLSearchParams(q);
    q2.set("profile", "allEquity");
    fetch(`/api/currency-impact?${q2.toString()}`)
      .then((r) => r.json())
      .then((d: CurrencyResp) => live && setFx({ key: tag, data: d }))
      .catch(() => live && setFx({ key: tag, data: { error: "Could not load." } as CurrencyResp }));
    return () => {
      live = false;
    };
  }, [from, to, ready]);

  const cData = contrib?.data ?? null;
  const fData = fx?.data ?? null;
  const loading = ready && (contrib?.key !== key || fx?.key !== key);

  const summary = useMemo(() => {
    if (!cData || !cData.ok) return null;
    // The summary always covers the WHOLE requested range (from the recorded series).
    const recorded = cData.full.recordedPct;
    const currency = fData && !fData.error && fData.fxAvailable ? fData.contributionPct : null;
    const beta = meta?.equityBeta;
    const usMix = meta?.usdEquityFractionPct;
    const sp = retBetween(indexes?.indexes.find((i) => i.key === "sp500")?.history, cData.full.base, cData.full.end);
    const tsx = retBetween(indexes?.indexes.find((i) => i.key === "tsx")?.history, cData.full.base, cData.full.end);
    const blend = sp != null && tsx != null && usMix != null ? (usMix / 100) * sp + (1 - usMix / 100) * tsx : null;
    const market = blend != null && beta != null && Number.isFinite(beta) ? beta * blend : null;
    const selection = recorded != null && market != null && currency != null ? recorded - market - currency : null;
    return { recorded, currency, market, selection, beta: beta ?? null, usMix: usMix ?? null, sp, tsx, blend };
  }, [cData, fData, meta, indexes]);

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Where returns came from</span>
        <span className="m">PIM equity book (All-Equity model) · one date range for the summary, the sleeves, the holdings and currency</span>
      </div>

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
        {loading && <span className="text-[12px] text-ink-3">Loading…</span>}
      </div>

      {/* ── 1 · Summary ── */}
      <div className="px-3.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">1 · Summary</div>
      {!cData ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
      ) : !cData.ok ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">{cData.error}</p>
      ) : summary ? (
        <div className={loading ? "opacity-60" : ""}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 py-2.5 lg:grid-cols-4">
            <Cell strong label="Recorded return" value={summary.recorded} note={`All-Equity model, ${cData.full.base} close to ${cData.full.end} close. The dashboard's own performance record.`} />
            <Cell
              label="Market"
              value={summary.market}
              note={summary.market == null ? "Benchmark history or the book's beta is not available." : `Beta ${summary.beta!.toFixed(2)} × a blend of the S&P 500 (${pts(summary.sp)}) and the TSX (${pts(summary.tsx)}) at ${summary.usMix!.toFixed(0)}% US. Estimate.`}
            />
            <Cell label="Currency" value={summary.currency} note={summary.currency == null ? "No USD/CAD history for this period." : "Unhedged US-dollar share × the USD/CAD move. Estimate; detail in section 3."} />
            <Cell label="Selection" value={summary.selection} note={summary.selection == null ? "Needs the three figures beside it." : "What is left of the recorded return after market and currency: our stock and fund choices. Estimate."} />
          </div>
          <p className="px-3.5 pb-1 text-[11.5px] text-ink-3">
            Recorded return = market + currency + selection. Only the recorded return is exact; the split uses today&apos;s beta, US / Canada mix and hedged list for the whole period.
          </p>
        </div>
      ) : null}

      {/* ── 2 · By sleeve and holding ── */}
      {(!cData || cData.ok) && (
        <>
          <div className="border-t border-line px-3.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">2 · By sleeve and holding</div>
          <ContributionView data={cData} loading={loading} />
        </>
      )}

      {/* ── 3 · Currency detail ── */}
      <div className="border-t border-line px-3.5 py-2.5">
        <button onClick={toggleCurrency} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          3 · Currency detail <span className="font-normal normal-case tracking-normal underline decoration-line underline-offset-2">{showCurrency ? "hide" : "show"}</span>
        </button>
      </div>
      {showCurrency && <CurrencyView data={fData} />}
    </section>
  );
}
