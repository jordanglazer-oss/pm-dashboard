"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Sparkline } from "@/app/components/Sparkline";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { SLEEVES, SLEEVE_LABELS, type SleevePerformance, type SleevePoint, type SleeveId } from "@/app/lib/sleeve-performance-shared";

/**
 * Weights-based sleeve tracking (pm:sleeve-performance): Core, Thematic,
 * Stocks and Stocks + Thematic, each tracked forward from the PIM model's
 * weights — no units. Each sleeve is shown against Core.
 */

const BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50";

function retSince(h: SleevePoint[], from: string | null): number | null {
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  // Base = the last point ON OR BEFORE the period start (the prior close).
  const base = from ? [...h].reverse().find((p) => p.date < from) ?? h[0] : h[0];
  return base.value > 0 ? (last.value / base.value - 1) * 100 : null;
}

const fmt = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const tone = (v: number | null) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

export function SleeveTracking() {
  const [data, setData] = useState<SleevePerformance | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [eventsOpen, toggleEvents] = usePersistedOpen("aa.sleeves.events", false);

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
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/sleeve-performance", { method: "POST" }).then((r) => r.json());
      if (d?.data) setData(d.data);
      setMsg(d?.ok ? (d.started ? `Tracking started at 100 on ${d.lastDate}.` : `${d.added} new day(s) through ${d.lastDate}.${d.waiting ? ` Waiting: ${d.waiting}.` : ""}`) : d?.error ?? "Could not update.");
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  const periods: { key: string; label: string; from: string | null }[] = [
    { key: "mtd", label: "MTD", from: `${ym}-01` },
    { key: "ytd", label: "YTD", from: `${now.getFullYear()}-01-01` },
    { key: "all", label: "Since start", from: null },
  ];
  const core = data?.series.core.history ?? [];

  return (
    <section className="panel">
      <div className="panel-h flex-wrap py-1.5">
        <span className="t">Sleeves vs Core</span>
        <span className="m">
          From the PIM model&apos;s weights, no units · {data ? `since ${data.startedAt} · through ${data.lastDate}` : data === null ? "not started" : "…"}
        </span>
        <button className={`${BTN} ml-auto`} disabled={busy} onClick={update}>
          {busy ? "Updating…" : data ? "Update now" : "Start tracking"}
        </button>
      </div>
      <p className="px-3.5 pt-2.5 text-[12.5px] leading-relaxed text-ink-3">
        Each sleeve holds the PIM model&apos;s names at their model weights (rescaled to 100% within the sleeve), lets them drift with prices, and resets to the targets whenever the model changes. Returns are in C$ and include dividends. Updates itself after each close.
        {msg && <span className="ml-1 text-ink-2">{msg}</span>}
      </p>
      {data && (
        <div className="tbl-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Sleeve</th>
                <th>Since start</th>
                {periods.map((p) => (
                  <th key={p.key} className="n">{p.label}</th>
                ))}
                {periods.map((p) => (
                  <th key={`vs-${p.key}`} className="n">vs Core {p.label}</th>
                ))}
                <th className="n">Names</th>
              </tr>
            </thead>
            <tbody>
              {SLEEVES.map((id: SleeveId) => {
                const h = data.series[id]?.history ?? [];
                return (
                  <tr key={id}>
                    <td className="pl-3.5 font-medium">{SLEEVE_LABELS[id]}</td>
                    <td>
                      <Sparkline points={h.map((p) => ({ date: p.date, value: p.value }))} width={120} height={28} referenceY={100} />
                    </td>
                    {periods.map((p) => {
                      const v = retSince(h, p.from);
                      return <td key={p.key} className={`n ${tone(v)}`}>{fmt(v)}</td>;
                    })}
                    {periods.map((p) => {
                      const a = retSince(h, p.from);
                      const c = retSince(core, p.from);
                      const v = id === "core" || a == null || c == null ? null : a - c;
                      return (
                        <td key={`vs-${p.key}`} className={`n ${tone(v)}`}>
                          {id === "core" ? "—" : v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)} pts`}
                        </td>
                      );
                    })}
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
            {eventsOpen ? "Hide" : "Show"} model changes ({data.events.length})
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
