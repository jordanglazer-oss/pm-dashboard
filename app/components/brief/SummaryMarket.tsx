"use client";

import React, { useState } from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { DriverRow } from "@/app/lib/market-drivers";
import { Card, CardHeader, Empty, Pct, Pill, TickerLink, timeAgo } from "./summary-ui";

/* ── Market drivers ──────────────────────────────────────────────────── */

export function DriversCard({ s, onRefresh, refreshing }: { s: DailySummary; onRefresh: () => void; refreshing: boolean }) {
  const d = s.drivers;
  const [idx, setIdx] = useState<"spx" | "tsx">("spx");
  const [win, setWin] = useState<"1d" | "1w">("1d");
  const index = d?.indexes.find((i) => i.key === idx) ?? null;
  const top = index ? (win === "1d" ? index.top1d : index.top1w) : [];
  const bottom = index ? (win === "1d" ? index.bottom1d : index.bottom1w) : [];
  const contrib = (r: DriverRow) => (win === "1d" ? r.contrib1d : r.contrib1w);
  const ret = (r: DriverRow) => (win === "1d" ? r.ret1d : r.ret1w);
  const maxAbs = Math.max(0.01, ...[...top, ...bottom].map((r) => Math.abs(contrib(r) ?? 0)));
  return (
    <Card>
      <CardHeader
        title="Market drivers"
        sub={d ? `cap-weighted contribution · ${timeAgo(d.builtAt)}${d.error ? " · stale" : ""}` : "loading"}
        right={
          <span className="flex items-center gap-1">
            <Toggle value={idx} options={[["spx", "S&P 500"], ["tsx", "TSX 60"]]} onChange={setIdx} />
            <Toggle value={win} options={[["1d", "1D"], ["1w", "1W"]]} onChange={setWin} />
            <button onClick={onRefresh} disabled={refreshing} title="Rebuild from FactSet" className="rounded-[6px] px-1.5 py-1 text-[11px] text-ink-3 hover:bg-surface-hover hover:text-ink disabled:opacity-50">
              {refreshing ? "…" : "↻"}
            </button>
          </span>
        }
      />
      {!index || index.namesPriced === 0 ? (
        <Empty>{d?.error ?? "No driver data yet — the nightly job builds it, or hit ↻."}</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-2.5 pb-1 text-[11px] text-ink-3">
            <span>
              {index.label} <Pct v={win === "1d" ? index.ret1d : index.ret1w} className="text-[13px] font-semibold" />
            </span>
            <span>{index.namesPriced}/{index.namesTotal} names priced</span>
            <span className="ml-auto inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-accent" /> held</span>
              <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-violet" /> watch</span>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-0 md:grid-cols-2 md:divide-x md:divide-line-soft">
            <DriverList title="Contributors" rows={top} contrib={contrib} ret={ret} maxAbs={maxAbs} />
            <DriverList title="Detractors" rows={bottom} contrib={contrib} ret={ret} maxAbs={maxAbs} />
          </div>
          <div className="border-t border-line-soft px-4 py-2.5">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Sectors · {win === "1d" ? "today" : "week"}</div>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {index.sectors.map((sec) => {
                const v = win === "1d" ? sec.ret1d : sec.ret1w;
                const leaders = win === "1d" ? sec.leaders : sec.leaders;
                return (
                  <div key={sec.sector} className="flex items-center gap-2 text-[11.5px]">
                    <span className="w-[128px] shrink-0 truncate text-ink-2" title={sec.sector}>{sec.sector}</span>
                    <SectorBar v={v} />
                    <Pct v={v} className="w-[52px] shrink-0 text-right text-[11px]" />
                    <span className="hidden min-w-0 truncate font-mono text-[10px] text-ink-faint lg:inline" title={leaders.map((l) => l.ticker).join(", ")}>
                      {leaders.slice(0, 2).map((l) => l.ticker).join(" ")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function DriverList({ title, rows, contrib, ret, maxAbs }: { title: string; rows: DriverRow[]; contrib: (r: DriverRow) => number | null; ret: (r: DriverRow) => number | null; maxAbs: number }) {
  return (
    <div>
      <div className="bg-surface-2 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">{title}</div>
      <ul>
        {rows.slice(0, 8).map((r) => {
          const c = contrib(r);
          const w = c == null ? 0 : (Math.abs(c) / maxAbs) * 100;
          return (
            <li key={r.ticker} className="flex items-center gap-2 px-4 py-[5px] text-[12px]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.held === "Portfolio" ? "bg-accent" : r.held === "Watchlist" ? "bg-violet" : "bg-transparent"}`} />
              <TickerLink ticker={r.ticker} className="w-[52px] shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{r.name ?? r.sector ?? ""}</span>
              <span className="relative h-1.5 w-[54px] shrink-0 overflow-hidden rounded-full bg-line-soft">
                <span className={`absolute left-0 top-0 h-full rounded-full ${(c ?? 0) >= 0 ? "bg-pos" : "bg-neg"}`} style={{ width: `${w}%` }} />
              </span>
              <span className="w-[56px] shrink-0 text-right font-mono text-[11px] text-ink-2">{c == null ? "—" : `${c > 0 ? "+" : ""}${c.toFixed(2)}`}</span>
              <Pct v={ret(r)} digits={1} className="w-[48px] shrink-0 text-right text-[11px]" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SectorBar({ v }: { v: number | null }) {
  const pct = v == null ? 0 : Math.max(-1, Math.min(1, v / 3)) * 50;
  return (
    <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line-soft">
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      {v != null && <span className={`absolute top-0 h-full ${v >= 0 ? "bg-pos" : "bg-neg"}`} style={pct >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${-pct}%` }} />}
    </span>
  );
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded-[5px] px-2 py-[2px] text-[11px] font-semibold ${value === v ? "bg-ink text-white" : "text-ink-2 hover:text-ink"}`}>
          {label}
        </button>
      ))}
    </span>
  );
}

/* ── Sector map (regime × leadership × book) ─────────────────────────── */

export function SectorMapCard({ s }: { s: DailySummary }) {
  const rows = s.regime?.sectorMap ?? [];
  const sectors = rows.filter((r) => r.kind === "sector").sort((a, b) => (b.ret1m ?? -99) - (a.ret1m ?? -99));
  const industries = rows.filter((r) => r.kind === "industry").sort((a, b) => (b.ret1m ?? -99) - (a.ret1m ?? -99));
  const label = s.regime?.composite?.label;
  return (
    <Card>
      <CardHeader title="Sector map" sub={label ? `leadership under ${label} · book vs S&P weight` : "leadership"} />
      {rows.length === 0 ? (
        <Empty>Needs the market-drivers build.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-4 py-1 text-left font-semibold">Sector</th>
                <th className="py-1 text-right font-semibold">1D</th>
                <th className="py-1 text-right font-semibold">1W</th>
                <th className="py-1 text-right font-semibold">1M</th>
                <th className="py-1 text-right font-semibold">3M</th>
                <th className="px-4 py-1 text-right font-semibold">Book · active</th>
              </tr>
            </thead>
            <tbody>
              {sectors.map((r) => (
                <tr key={r.symbol} className="border-t border-line-soft">
                  <td className="px-4 py-1 text-ink"><span className="font-mono text-[10.5px] text-ink-faint">{r.symbol}</span> {r.label}</td>
                  <Cell v={r.ret1d} /><Cell v={r.ret1w} /><Cell v={r.ret1m} /><Cell v={r.ret3m} />
                  <td className="px-4 py-1 text-right font-mono">
                    {r.bookWeightPct != null ? (
                      <>
                        <span className="text-ink">{r.bookWeightPct.toFixed(1)}%</span>
                        {r.activePct != null && <span className={`ml-1 ${r.activePct > 0.5 ? "text-pos" : r.activePct < -0.5 ? "text-neg" : "text-ink-3"}`}>{r.activePct > 0 ? "+" : ""}{r.activePct.toFixed(1)}</span>}
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-3"><td colSpan={6} className="px-4 py-1 font-semibold">Industries</td></tr>
              {industries.map((r) => (
                <tr key={r.symbol} className="border-t border-line-soft">
                  <td className="px-4 py-1 text-ink"><span className="font-mono text-[10.5px] text-ink-faint">{r.symbol}</span> {r.label}</td>
                  <Cell v={r.ret1d} /><Cell v={r.ret1w} /><Cell v={r.ret1m} /><Cell v={r.ret3m} />
                  <td className="px-4 py-1" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Cell({ v }: { v: number | null }) {
  const bg = v == null ? "" : v >= 3 ? "bg-pos-soft" : v <= -3 ? "bg-neg-soft" : "";
  return (
    <td className={`py-1 text-right ${bg}`}>
      <Pct v={v} digits={1} className="pr-2" />
    </td>
  );
}

/* ── All models ──────────────────────────────────────────────────────── */

const PROFILE_LABEL: Record<string, string> = { conservative: "Cons.", balanced: "Balanced", growth: "Growth", allEquity: "All-Eq" };

export function ModelsCard({ s }: { s: DailySummary }) {
  const rows = s.performance?.models ?? [];
  const [all, setAll] = useState(false);
  const groups = [...new Set(rows.map((r) => r.groupId))];
  const shown = all ? groups : groups.slice(0, 1);
  return (
    <Card>
      <CardHeader
        title="Model returns"
        sub={rows[0]?.asOf ? `as of ${rows[0].asOf}` : "pm:pim-performance"}
        href="/aa-performance"
        right={groups.length > 1 && (
          <button onClick={() => setAll((v) => !v)} className="text-[11px] text-ink-3 hover:text-ink">{all ? "PIM only" : `all ${groups.length} groups`}</button>
        )}
      />
      {rows.length === 0 ? (
        <Empty>No model series yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-4 py-1 text-left font-semibold">Model</th>
                {["1D", "1W", "1M", "3M", "YTD"].map((h) => <th key={h} className="py-1 pr-3 text-right font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const grp = rows.filter((r) => r.groupId === g);
                return grp.map((r, i) => (
                  <tr key={`${g}-${r.profile}`} className="border-t border-line-soft">
                    <td className="px-4 py-1">
                      {i === 0 ? <span className="font-semibold text-ink">{r.groupName}</span> : <span className="text-ink-faint">{r.groupName}</span>}
                      <Pill tone="neutral" className="ml-1.5 normal-case tracking-normal">{PROFILE_LABEL[r.profile] ?? r.profile}</Pill>
                    </td>
                    {(["1d", "1w", "1m", "3m", "ytd"] as const).map((k) => (
                      <td key={k} className="py-1 pr-3 text-right"><Pct v={r.returns[k]} /></td>
                    ))}
                  </tr>
                ));
              })}
              {(s.performance?.benchmarks ?? []).map((b) => (
                <tr key={b.key} className="border-t border-line bg-surface-2">
                  <td className="px-4 py-1 text-ink-2">{b.label}</td>
                  {(["1d", "1w", "1m", "3m", "ytd"] as const).map((k) => (
                    <td key={k} className="py-1 pr-3 text-right"><Pct v={b.returns[k]} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
