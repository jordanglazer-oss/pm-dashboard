"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkline } from "@/app/components/Sparkline";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { SLEEVES, SLEEVE_LABELS, type SleevePerformance, type SleevePoint, type SleeveId } from "@/app/lib/sleeve-performance-shared";

/**
 * Weights-based sleeve tracking (pm:sleeve-performance): Core, Thematic,
 * Stocks and Stocks + Thematic, each tracked forward from the PIM model's
 * weights — no units — with the past optionally filled from the existing
 * ledger series. Any period (preset or custom range) against Core.
 */

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

type Preset = "mtd" | "qtd" | "ytd" | "1y" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "Since start" },
  { key: "custom", label: "Custom" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Period start (exclusive base = the last close BEFORE `from`) and end (inclusive). */
function rangeFor(p: Preset, custom: { from: string; to: string }, firstDate: string | null): { from: string | null; to: string } {
  const now = new Date();
  const today = iso(now);
  if (p === "custom") return { from: custom.from || null, to: custom.to || today };
  if (p === "all") return { from: null, to: today };
  if (p === "mtd") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === "ytd") return { from: `${now.getFullYear()}-01-01`, to: today };
  if (p === "qtd") {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { from: iso(new Date(Date.UTC(now.getFullYear(), q, 1))), to: today };
  }
  const y = new Date(now);
  y.setFullYear(y.getFullYear() - 1);
  return { from: firstDate && iso(y) < firstDate ? null : iso(y), to: today };
}

/** Return over the range: base = last point before `from` (or the first point), end = last point on/before `to`. */
function retOver(h: SleevePoint[], from: string | null, to: string): { pct: number | null; base: string | null; end: string | null; partial: boolean } {
  if (h.length < 2) return { pct: null, base: null, end: null, partial: false };
  const endPt = [...h].reverse().find((p) => p.date <= to);
  const before = from ? [...h].reverse().find((p) => p.date < from) : undefined;
  const basePt = before ?? h[0];
  const partial = !!from && !before; // series starts after the period start
  if (!endPt || endPt.date <= basePt.date || !(basePt.value > 0)) return { pct: null, base: basePt?.date ?? null, end: endPt?.date ?? null, partial };
  return { pct: (endPt.value / basePt.value - 1) * 100, base: basePt.date, end: endPt.date, partial };
}

const fmt = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const tone = (v: number | null) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

export function SleeveTracking() {
  const [data, setData] = useState<SleevePerformance | null | undefined>(undefined);
  const [busy, setBusy] = useState<null | "update" | "backfill">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [eventsOpen, toggleEvents] = usePersistedOpen("aa.sleeves.events", false);
  const [preset, setPreset] = useState<Preset>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });

  const load = useCallback(async () => {
    try {
      setData(((await fetch("/api/sleeve-performance").then((r) => r.json())) as { data: SleevePerformance | null }).data);
    } catch {
      setData(null);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const update = async () => {
    setBusy("update");
    setMsg(null);
    try {
      const d = await fetch("/api/sleeve-performance", { method: "POST" }).then((r) => r.json());
      if (d?.data) setData(d.data);
      setMsg(d?.ok ? (d.started ? `Tracking started at 100 on ${d.lastDate}. The first daily return lands after the next close — or fill the history below.` : d.added ? `${d.added} new day(s) through ${d.lastDate}.${d.waiting ? ` Waiting: ${d.waiting}.` : ""}` : `Up to date through ${d.lastDate}${d.waiting ? ` (waiting: ${d.waiting})` : ""}.`) : d?.error ?? "Could not update.");
    } finally {
      setBusy(null);
    }
  };

  const backfill = async () => {
    setBusy("backfill");
    setMsg(null);
    try {
      const plan = (await fetch("/api/sleeve-performance/backfill").then((r) => r.json())) as { ok: boolean; plan?: { sleeve: SleeveId; source: string; points: number; firstDate: string | null; skipped?: string }[]; error?: string };
      if (!plan.ok || !plan.plan) {
        setMsg(plan.error ?? "Could not plan the backfill.");
        return;
      }
      const lines = plan.plan.map((p) => `• ${SLEEVE_LABELS[p.sleeve]}: ${p.points ? `${p.points} days from ${p.firstDate}, from the ${p.source}` : p.skipped ?? "nothing to add"}`);
      if (!plan.plan.some((p) => p.points > 0)) {
        setMsg(`Nothing to fill. ${lines.join(" ")}`);
        return;
      }
      if (!window.confirm(`Fill the history before tracking start from the series already recorded?\n\n${lines.join("\n")}\n\nEach is rescaled to meet the new series at tracking start; nothing after it changes, and the current state is saved first so this can be undone.`)) return;
      const d = await fetch("/api/sleeve-performance/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "BACKFILL" }) }).then((r) => r.json());
      if (d?.data) setData(d.data);
      setMsg(d?.applied ? "History filled." : d?.error ?? "Backfill failed.");
    } finally {
      setBusy(null);
    }
  };

  const firstDate = useMemo(() => {
    if (!data) return null;
    return SLEEVES.map((id) => data.series[id]?.history[0]?.date).filter(Boolean).sort()[0] ?? null;
  }, [data]);
  const range = rangeFor(preset, custom, firstDate);
  const core = data?.series.core.history ?? [];
  const coreR = retOver(core, range.from, range.to);
  const canBackfill = !!data && (["core", "thematic", "stocks"] as SleeveId[]).some((id) => !data.series[id]?.backfilledFrom);

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Sleeves vs Core</span>
        <span className="m">
          From the PIM model&apos;s weights, no units · {data ? `weights tracking since ${data.startedAt}${firstDate && firstDate < data.startedAt ? ` · history from ${firstDate}` : ""} · through ${data.lastDate}` : data === null ? "not started" : "…"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canBackfill && (
            <button className={BTN} disabled={!!busy} onClick={backfill} title="Fill the history before tracking start from the Core, Thematic and Alpha series already recorded.">
              {busy === "backfill" ? "Filling…" : "Fill history from existing series"}
            </button>
          )}
          <button className={BTN} disabled={!!busy} onClick={update}>
            {busy === "update" ? "Updating…" : data ? "Update now" : "Start tracking"}
          </button>
        </div>
      </div>
      <p className="px-3.5 pt-2.5 text-[12.5px] leading-relaxed text-ink-3">
        Each sleeve holds the PIM model&apos;s names at their model weights (rescaled to 100% within the sleeve), lets them drift with prices, and resets to the targets whenever the model changes. Returns are in C$ and include dividends. Updates itself after each close.
        {data && SLEEVES.some((id) => data.series[id]?.backfilledFrom) && " Before weights tracking began, each line uses the series already recorded for it (Stocks uses the Alpha book, which held only the stocks); Stocks + Thematic has no earlier record."}
        {msg && <span className="ml-1 text-ink-2">{msg}</span>}
      </p>
      {data && (
        <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
          <div className="seg">
            {PRESETS.map((p) => (
              <button key={p.key} className={preset === p.key ? "on" : ""} onClick={() => setPreset(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
              From
              <input type="date" value={custom.from} min={firstDate ?? undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
              to
              <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
              <span className="text-ink-faint">(leave &quot;from&quot; empty to measure from the start — i.e. as of the &quot;to&quot; date; leave &quot;to&quot; empty for today)</span>
            </span>
          )}
          <span className="text-[12px] text-ink-3">
            {coreR.base && coreR.end ? `Measured from the ${coreR.base} close to the ${coreR.end} close` : "Not enough history for this period yet"}
          </span>
        </div>
      )}
      {data && (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Sleeve</th>
                <th>Period</th>
                <th className="n">Return</th>
                <th className="n">vs Core</th>
                <th className="n">Names</th>
              </tr>
            </thead>
            <tbody>
              {SLEEVES.map((id: SleeveId) => {
                const h = data.series[id]?.history ?? [];
                const r = retOver(h, range.from, range.to);
                const vs = id === "core" || r.pct == null || coreR.pct == null || r.base !== coreR.base ? null : r.pct - coreR.pct;
                const slice = h.filter((p) => (!r.base || p.date >= r.base) && p.date <= range.to);
                return (
                  <tr key={id}>
                    <td className="pl-3.5 font-medium">
                      {SLEEVE_LABELS[id]}
                      {r.partial && r.base && <div className="text-[11px] font-normal text-ink-3">from {r.base} (no earlier record)</div>}
                    </td>
                    <td>
                      <Sparkline points={slice.map((p) => ({ date: p.date, value: p.value }))} width={140} height={28} />
                    </td>
                    <td className={`n ${tone(r.pct)}`}>{fmt(r.pct)}</td>
                    <td className={`n ${tone(vs)}`}>
                      {id === "core" ? "—" : vs == null ? (r.pct != null && coreR.pct != null ? <span className="text-[11px] text-ink-3">different start</span> : "—") : `${vs > 0 ? "+" : ""}${vs.toFixed(2)} pts`}
                    </td>
                    <td className="n">{Object.keys(data.series[id]?.weights ?? {}).length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.events.length > 0 && (
        <div className="px-3.5 py-2.5">
          <button className="text-[12px] text-accent hover:underline" onClick={toggleEvents}>
            {eventsOpen ? "Hide" : "Show"} changes and notes ({data.events.length})
          </button>
          {eventsOpen && (
            <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] text-ink-3">
              {[...data.events].reverse().map((e, i) => (
                <li key={i}>
                  <span className="font-mono">{e.date}</span> · {SLEEVE_LABELS[e.sleeve]}: {e.note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
