"use client";

import React from "react";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { Horizon, SignalContribution } from "@/app/lib/horizons";
import { Empty, Pill, Spark, regimeTone, timeAgo } from "./summary-ui";

/**
 * The regime dial, opened up: every signal with its vote, its live reading,
 * and exactly what it is worth on the 0..100 dial.
 *
 * The arithmetic is the point — `signalContributions` guarantees the rows sum
 * to (dial − 50), so what the PM reads here adds up to the number on the
 * gauge. Grouped by horizon because the horizon weight is what sets the size
 * of each contribution.
 */

const HORIZON_ORDER: Horizon[] = ["tactical", "cyclical", "structural"];

function BigDial({ value, label }: { value: number | null; label: string | null }) {
  const size = 250;
  const r = size / 2 - 15;
  const cx = size / 2;
  const cy = size / 2;
  const pt = (f: number, radius = r) => {
    const a = Math.PI - (f / 100) * Math.PI;
    return { x: cx + radius * Math.cos(a), y: cy - radius * Math.sin(a) };
  };
  const arc = (from: number, to: number) => {
    const a = pt(from);
    const b = pt(to);
    return `M${a.x.toFixed(2)},${a.y.toFixed(2)} A${r},${r} 0 0 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  };
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const tick = v == null ? null : { inner: pt(v, r - 12), outer: pt(v, r + 10) };
  const tone = label === "Risk-On" ? "text-pos" : label === "Risk-Off" ? "text-neg" : "text-warn";
  const t33 = pt(33, r + 9);
  const t67 = pt(67, r + 9);
  return (
    <svg width={size} height={size / 2 + 30} viewBox={`0 0 ${size} ${size / 2 + 30}`} aria-hidden>
      <path d={arc(0, 33)} fill="none" strokeWidth="12" className="stroke-neg-border" />
      <path d={arc(33, 67)} fill="none" strokeWidth="12" className="stroke-warn-border" />
      <path d={arc(67, 100)} fill="none" strokeWidth="12" className="stroke-pos-border" />
      <line x1={pt(33).x} y1={pt(33).y} x2={t33.x} y2={t33.y} strokeWidth="1" className="stroke-line" />
      <line x1={pt(67).x} y1={pt(67).y} x2={t67.x} y2={t67.y} strokeWidth="1" className="stroke-line" />
      <text x={t33.x - 6} y={t33.y - 3} textAnchor="middle" className="fill-current font-mono text-ink-3" style={{ fontSize: 9 }}>33</text>
      <text x={t67.x + 6} y={t67.y - 3} textAnchor="middle" className="fill-current font-mono text-ink-3" style={{ fontSize: 9 }}>67</text>
      {tick && (
        <line x1={tick.inner.x} y1={tick.inner.y} x2={tick.outer.x} y2={tick.outer.y} strokeWidth="4" strokeLinecap="round" className={`stroke-current ${tone}`} />
      )}
      <text x={cx} y={cy - 8} textAnchor="middle" className={`fill-current font-mono ${tone}`} style={{ fontSize: 42, fontWeight: 600 }}>
        {v == null ? "—" : Math.round(v)}
      </text>
      <text x={10} y={cy + 22} className="fill-current text-ink-3" style={{ fontSize: 9.5 }}>RISK-OFF</text>
      <text x={cx} y={cy + 22} textAnchor="middle" className={`fill-current ${tone}`} style={{ fontSize: 9.5, fontWeight: 600 }}>
        {(label ?? "").toUpperCase()}
      </text>
      <text x={size - 10} y={cy + 22} textAnchor="end" className="fill-current text-ink-3" style={{ fontSize: 9.5 }}>RISK-ON</text>
    </svg>
  );
}

function Bar({ points, maxAbs }: { points: number; maxAbs: number }) {
  const w = maxAbs > 0 ? (Math.abs(points) / maxAbs) * 50 : 0;
  return (
    <span className="relative block h-2.5 w-full overflow-hidden rounded-[2px] bg-line-soft">
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      {points !== 0 && (
        <span
          className={`absolute top-0 h-full rounded-[2px] ${points > 0 ? "bg-pos" : "bg-neg"}`}
          style={points > 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
        />
      )}
    </span>
  );
}

function pts(n: number, digits = 2): string {
  if (!isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "0.00";
  return `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
}

export function RegimeDetail({ s }: { s: DailySummary }) {
  const r = s.regime;
  const c = r?.composite;
  if (!r || !c || r.contributions.length === 0) {
    return <Empty>The regime engine hasn&apos;t computed a breakdown yet.</Empty>;
  }

  const byHorizon = new Map<Horizon, SignalContribution[]>();
  for (const row of r.contributions) {
    const arr = byHorizon.get(row.horizon) ?? [];
    arr.push(row);
    byHorizon.set(row.horizon, arr);
  }
  const maxAbs = Math.max(...r.contributions.map((x) => x.perSignalPoints), 0.01);
  const netFor = (h: Horizon) => (byHorizon.get(h) ?? []).reduce((sum, x) => sum + x.dialPoints, 0);
  const total = r.contributions.reduce((sum, x) => sum + x.dialPoints, 0);
  const dial = 50 + total;
  const tone = regimeTone(c.label);

  return (
    <div>
      {/* ── dial · how it is built · horizon weights ── */}
      <div className="grid grid-cols-1 gap-6 px-3.5 pb-4 pt-3.5 xl:grid-cols-[290px_minmax(0,1fr)_minmax(0,420px)]">
        <div>
          <BigDial value={c.score100 ?? null} label={c.label} />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{c.label}</Pill>
            <span className="font-mono text-[11px] text-ink-2">
              weighted {c.weightedScore == null ? "—" : `${c.weightedScore >= 0 ? "+" : ""}${c.weightedScore.toFixed(2)}`}
            </span>
            <span className="font-mono text-[11px] text-ink-3">
              {c.signals.filter((x) => x.direction === "risk-on").length}↑{" "}
              {c.signals.filter((x) => x.direction === "risk-off").length}↓{" "}
              {c.signals.filter((x) => x.direction === "neutral").length}· / {c.total}
            </span>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[11px] text-ink-3">How the dial is built</div>
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            Every signal always votes, neutral included, so a quiet day cannot shrink the denominator and move the
            label on its own. Each vote is then scaled by its horizon&apos;s weight, so a volatility print no longer
            counts the same as the ten-month trend.
          </p>
          <div className="mt-3 rounded-control border border-line-soft bg-surface-2 px-3 py-2.5">
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <span className="text-ink-3">start neutral</span>
              <span className="ml-auto font-semibold">50.0</span>
            </div>
            {HORIZON_ORDER.map((h) => {
              const rows = byHorizon.get(h) ?? [];
              if (rows.length === 0) return null;
              const net = netFor(h);
              const on = rows.filter((x) => x.direction === "risk-on").length;
              const off = rows.filter((x) => x.direction === "risk-off").length;
              const flat = rows.length - on - off;
              return (
                <div key={h} className="mt-1 flex items-center gap-2 font-mono text-[12px]">
                  <span className="text-ink-2 capitalize">{h} net</span>
                  <span className="truncate text-ink-faint">
                    {on} on, {off} off{flat > 0 ? `, ${flat} flat` : ""}
                  </span>
                  <span className={`ml-auto ${Math.abs(net) < 0.005 ? "text-ink-3" : net > 0 ? "font-semibold text-pos" : "font-semibold text-neg"}`}>
                    {Math.abs(net) < 0.005 ? "±0.0" : pts(net, 1)}
                  </span>
                </div>
              );
            })}
            <div className="mt-1.5 flex items-center gap-2 border-t border-line pt-1.5 font-mono text-[13px]">
              <span className="font-semibold">dial today</span>
              <span className={`ml-auto font-semibold ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-warn"}`}>{dial.toFixed(1)}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[11px] text-ink-3">Horizon weights · where the vote comes from</div>
          {r.horizons.map((h) => {
            const net = netFor(h.id);
            return (
              <div key={h.id} className="mb-2.5">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-semibold">{h.label.replace(/ \(.*\)/, "")}</span>
                  <span className="text-ink-3">{h.shortLabel}</span>
                  <Pill tone={h.label_ === "Risk-On" ? "pos" : h.label_ === "Risk-Off" ? "neg" : "neutral"} className="ml-auto">
                    {Math.round(h.weight * 100)}% · {h.total} signal{h.total === 1 ? "" : "s"}
                  </Pill>
                  <span className={`w-11 text-right font-mono ${h.score == null || Math.abs(h.score) < 0.005 ? "text-ink-3" : h.score > 0 ? "font-semibold text-pos" : "font-semibold text-neg"}`}>
                    {h.score == null ? "—" : `${h.score >= 0 ? "+" : ""}${h.score.toFixed(2)}`}
                  </span>
                </div>
                <div className="mt-1">
                  <Bar points={net} maxAbs={maxAbs * 2} />
                </div>
              </div>
            );
          })}

          {r.flip && r.flip.count > 0 && (
            <div className={`rounded-control border px-2.5 py-2 ${r.flip.target === "Risk-On" ? "border-pos-border bg-pos-soft" : r.flip.target === "Risk-Off" ? "border-neg-border bg-neg-soft" : "border-warn-border bg-warn-soft"}`}>
              <div className={`mb-1 text-[11.5px] font-semibold ${r.flip.target === "Risk-On" ? "text-pos" : r.flip.target === "Risk-Off" ? "text-neg" : "text-warn"}`}>
                {r.flip.count} signal{r.flip.count === 1 ? "" : "s"} from {r.flip.target}
              </div>
              <div className="text-[11.5px] leading-relaxed text-ink-2">
                {r.flip.signals.map((sig, i) => (
                  <span key={sig.name}>
                    {i > 0 ? " and " : ""}
                    <b className="font-semibold text-ink">{sig.name}</b> turning {r.flip!.target === "Risk-Off" ? "negative" : "positive"}{" "}
                    <span className="font-mono">({pts(sig.dialPoints, 1)})</span>
                  </span>
                ))}
                {" — taking the dial to "}
                <b className="font-mono text-ink">{(dial + r.flip.signals.reduce((sum, x) => sum + x.dialPoints, 0)).toFixed(0)}</b>.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── the signal table ── */}
      <div className="tbl-wrap border-t border-line-soft">
        <table className="data-table min-w-[900px]">
          <thead>
            <tr>
              <th className="pl-3.5">Signal</th>
              <th>Vote</th>
              <th>Reading</th>
              <th>Contribution to the dial</th>
              <th className="n pr-3.5">Points</th>
            </tr>
          </thead>
          <tbody>
            {HORIZON_ORDER.map((h) => {
              const rows = byHorizon.get(h) ?? [];
              if (rows.length === 0) return null;
              const net = netFor(h);
              const meta = r.horizons.find((x) => x.id === h);
              return (
                <React.Fragment key={h}>
                  <tr className="bg-surface-2">
                    <td colSpan={5} className="pl-3.5">
                      <span className="text-[11px] capitalize text-ink-2">
                        {h} {meta?.shortLabel}
                      </span>
                      <span className="ml-2 font-mono text-[10.5px] text-ink-3">
                        weight {Math.round((meta?.weight ?? 0) * 100)}% · ±{rows[0].perSignalPoints.toFixed(2)} each
                      </span>
                      <span className={`ml-3 font-mono text-[11px] ${Math.abs(net) < 0.005 ? "text-ink-3" : net > 0 ? "font-semibold text-pos" : "font-semibold text-neg"}`}>
                        net {Math.abs(net) < 0.005 ? "±0.0" : pts(net, 1)}
                      </span>
                    </td>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.name} className={row.direction === "risk-off" ? "bg-neg-soft/60" : ""}>
                      <td className="w-[220px] pl-3.5">{row.name}</td>
                      <td className="w-[80px]">
                        <Pill tone={row.direction === "risk-on" ? "pos" : row.direction === "risk-off" ? "neg" : "neutral"}>
                          {row.direction === "neutral" ? "flat" : row.direction}
                        </Pill>
                      </td>
                      <td className="pr-4">
                        <span className="font-mono text-[11.5px] text-ink-2">{row.detail || "—"}</span>
                      </td>
                      <td className="w-[230px]">
                        <Bar points={row.dialPoints} maxAbs={maxAbs} />
                      </td>
                      <td className="n w-[70px] pr-3.5">
                        <span className={row.dialPoints > 0 ? "text-pos" : row.dialPoints < 0 ? "text-neg" : "text-ink-3"}>
                          {pts(row.dialPoints)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
            <tr className="bg-surface-2">
              <td className="pl-3.5 font-medium">Dial</td>
              <td />
              <td>
                <span className="font-mono text-[11.5px] text-ink-3">50 neutral, plus the net of every vote above</span>
              </td>
              <td>
                <Bar points={total} maxAbs={50} />
              </td>
              <td className="n pr-3.5">
                <span className={`font-medium ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-warn"}`}>
                  {dial.toFixed(1)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── history + hysteresis ── */}
      <div className="flex flex-wrap items-center gap-4 border-t border-line-soft px-3.5 py-3">
        <div>
          <div className="text-[11px] text-ink-3">
            Dial, last {r.history.length} session{r.history.length === 1 ? "" : "s"}
          </div>
          <div className="font-mono text-[11px] text-ink-2">
            {r.history.length > 1
              ? `range ${Math.min(...r.history.map((x) => x.score100 ?? 50))}–${Math.max(...r.history.map((x) => x.score100 ?? 50))}`
              : "history starts building today"}
          </div>
        </div>
        {r.history.length > 2 && <Spark points={r.history.map((h) => h.score100 ?? 50)} baseline={50} width={320} height={40} />}
        <div className="ml-auto max-w-[460px] text-[11.5px] leading-relaxed text-ink-2">
          {c.pending ? (
            <>
              Today&apos;s data reads <b>{c.pending.label}</b>. A flip is held for {c.pending.needed} straight sessions
              before the label moves, so the call stays {c.label} for now ({c.pending.days} of {c.pending.needed}).
            </>
          ) : (
            <>A flip is held for three straight sessions before the label moves, so one bar cannot change the call. Nothing is pending{r.computedAt ? `, as of ${timeAgo(r.computedAt)}` : ""}.</>
          )}
        </div>
      </div>
    </div>
  );
}
