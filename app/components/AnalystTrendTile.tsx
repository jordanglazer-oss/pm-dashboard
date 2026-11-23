"use client";

import React, { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { Explain } from "@/app/components/Explain";
import type { AnalystReading, AnalystTrend } from "@/app/lib/analyst-history";

/**
 * Analyst trend — the sell-side consensus over time for one name, from the
 * append-only pm:analyst-history log (FactSet mean target, analyst count,
 * 30-day EPS revisions; recorded nightly whenever a value changes).
 * READ-ONLY, and independent of scoring: nothing here feeds a score.
 * Collapse state persists via CollapsibleSection (pm:ui-prefs).
 */

type Payload = { tickers: Record<string, { trend: AnalystTrend; entries: AnalystReading[] }> };

const fmtDay = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : d;
};
const signed = (n: number | null | undefined, suffix = "") => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}${suffix}`);
const tone = (n: number | null | undefined) => (n == null || n === 0 ? "text-ink-2" : n > 0 ? "text-pos" : "text-neg");

export default function AnalystTrendTile({ ticker }: { ticker: string }) {
  const [data, setData] = useState<{ trend: AnalystTrend; entries: AnalystReading[] } | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/kv/analyst-history?ticker=${encodeURIComponent(ticker.toUpperCase())}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Payload | null) => {
        if (live) setData(d?.tickers?.[ticker.toUpperCase()] ?? null);
      })
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [ticker]);

  if (data === undefined) return null; // loading — no layout jump for a secondary tile
  const latest = data?.trend.latest ?? null;
  const entries = data?.entries ?? [];
  const streak = data?.trend.targetStreak ?? null;

  return (
    <CollapsibleSection prefKey="stock.analystTrend" title="Analyst trend" subtitle="Not part of the score">
      {!latest ? (
        <p className="text-[12.5px] text-ink-3">No readings logged yet (recording began 19 Nov 2026).</p>
      ) : (
        <div className="flex flex-col gap-2.5 text-[12.5px]">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[11px] text-ink-3">Average target</div>
              <div className="text-[15px] font-medium tabular-nums">{latest.target != null ? latest.target.toFixed(2) : "—"}</div>
            </div>
            <div>
              <div className="text-[11px] text-ink-3">Analysts</div>
              <div className="text-[15px] font-medium tabular-nums">{latest.count ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] text-ink-3">Revisions, 30 days</div>
              <div className="text-[15px] font-medium tabular-nums">
                <span className="text-pos">{latest.revUp ?? "—"} up</span> · <span className="text-neg">{latest.revDown ?? "—"} down</span>
              </div>
            </div>
          </div>

          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left text-[11px] text-ink-3">
                <th className="font-normal">Change over</th>
                <th className="text-right font-normal">Target</th>
                <th className="text-right font-normal">Analysts</th>
              </tr>
            </thead>
            <tbody>
              {([["30 days", data?.trend.d30], ["90 days", data?.trend.d90]] as const).map(([label, d]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="text-right"><span className={tone(d?.targetPct)}>{d ? signed(d.targetPct, "%") : "not enough history"}</span></td>
                  <td className="text-right"><span className={tone(d?.count)}>{d ? signed(d.count) : "—"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          {streak && streak.changes >= 2 && (
            <p>
              <span className={streak.direction === "down" ? "text-neg" : "text-pos"}>
                {streak.changes} target {streak.direction === "down" ? "cuts" : "raises"} in a row
              </span>
            </p>
          )}

          {entries.length > 1 && (
            <table className="w-full tabular-nums">
              <thead>
                <tr className="text-left text-[11px] text-ink-3">
                  <th className="font-normal">Logged</th>
                  <th className="text-right font-normal">Target</th>
                  <th className="text-right font-normal">Analysts</th>
                  <th className="text-right font-normal">Up / down</th>
                </tr>
              </thead>
              <tbody>
                {[...entries].reverse().slice(0, 8).map((e) => (
                  <tr key={e.date}>
                    <td>{fmtDay(e.date)}</td>
                    <td className="text-right">{e.target != null ? e.target.toFixed(2) : "—"}</td>
                    <td className="text-right">{e.count ?? "—"}</td>
                    <td className="text-right">{e.revUp ?? "—"} / {e.revDown ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Explain prefKey="explain.stock.analystTrend" label="About these readings">
            FactSet consensus (average target, analyst count, 30-day estimate revisions), logged since {fmtDay(entries[0]?.date ?? latest.date)}. A line is added only on a night a value changed.
          </Explain>
        </div>
      )}
    </CollapsibleSection>
  );
}
