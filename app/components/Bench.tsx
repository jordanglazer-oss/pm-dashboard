"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { computeSetup } from "@/app/lib/setup-grade";
import { displayTicker } from "@/app/lib/ticker";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { LaneChip } from "@/app/components/LaneChecklist";
import type { EntryScan, EntryRow } from "@/app/lib/entry-scan";
import { normalizeLane, type Lane } from "@/app/lib/lanes";

/* The bench — where the next position comes from, sorted into lanes by the
 * readiness engine (app/lib/lanes): Ready (the tape says now), Wait (case
 * proven, tape not yet), Watch (neither — hover the chip for what is missing).
 * Watchlist AND Suggested names, from /api/entry-scan. Read-only. */

const GRADE_ORDER: Record<string, number> = { Strong: 0, Constructive: 1, Neutral: 2, Weak: 3, Broken: 4 };
const gradeCls = (g: string | null | undefined) => (g === "Strong" || g === "Constructive" ? "text-pos" : g === "Weak" || g === "Broken" ? "text-neg" : "text-ink-3");
const LANES: Array<{ key: Lane; title: string; hint: string }> = [
  { key: "ready", title: "Ready", hint: "the tape says now — setup Constructive+, a live trigger, no critical alert" },
  { key: "wait", title: "Wait", hint: "case proven (reports, synthesis Advance after them, conviction Hold+), tape not yet" },
  { key: "watch", title: "Watch", hint: "neither yet — hover the chip for what is missing" },
];

export function Bench() {
  const { scoredStocks } = useStocks();
  const [scan, setScan] = useState<EntryScan | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  useEffect(() => {
    let alive = true;
    fetch("/api/entry-scan", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!alive) return; if (d?.rows) { setScan(d); setState("ok"); } else setState("none"); }).catch(() => alive && setState("none"));
    return () => { alive = false; };
  }, []);

  const byTicker = useMemo(() => new Map(scoredStocks.map((s) => [s.ticker.toUpperCase(), s])), [scoredStocks]);
  const rows = useMemo(() => (scan?.rows ?? []).filter((r) => r.lane).map((r) => {
    const s = byTicker.get(r.ticker.toUpperCase());
    const grade = r.signals.find((x) => x.key === "setup")?.reading ?? null;
    return { r, s, grade: s ? computeSetup(s).grade : (grade && GRADE_ORDER[grade] != null ? grade : null) };
  }), [scan, byTicker]);

  const laneRows = (key: Lane) => rows
    .filter(({ r }) => r.lane && normalizeLane(r.lane.lane) === key)
    // Within Ready, a proven case first.
    .sort((a, b) => Number(b.r.lane!.thesisReady) - Number(a.r.lane!.thesisReady) || Number(b.r.ready) - Number(a.r.ready) || b.r.met - a.r.met || (GRADE_ORDER[a.grade ?? "Neutral"] ?? 2) - (GRADE_ORDER[b.grade ?? "Neutral"] ?? 2));

  const table = (list: Array<{ r: EntryRow; s: (typeof scoredStocks)[number] | undefined; grade: string | null }>) => (
    <div className="overflow-auto"><table className="data-table">
      <thead><tr><th>Name</th><th>Lane</th><th>Scorecard</th><th>Setup</th><th className="text-right">Score</th></tr></thead>
      <tbody>
        {list.slice(0, 12).map(({ r, s, grade }) => (
          <tr key={r.ticker}>
            <td>
              <Link href={`/stock/${r.ticker.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">{displayTicker(r.ticker)}</Link>
              <span className="ml-2 hidden text-[11.5px] text-ink-3 md:inline">{r.name}</span>
              {r.bucket === "Suggested" && <span className="ml-1.5 text-[10.5px] text-ink-faint">suggested</span>}
            </td>
            <td>{r.lane && <LaneChip lane={r.lane} />}</td>
            <td><span className={r.ready ? "text-pos" : "text-ink-3"}>{r.strength} · {r.met}/{r.known}</span></td>
            <td><span className={gradeCls(grade)}>{grade ?? "n/a"}</span></td>
            <td className="n">{s ? <>{Number(s.adjusted.toFixed(1))} <span className="text-[11px] text-ink-3">{s.ratingLabel || s.rating}</span></> : <span className="text-ink-faint">—</span>}</td>
          </tr>
        ))}
        {list.length === 0 && <tr><td colSpan={5} className="text-ink-3">none</td></tr>}
      </tbody>
    </table></div>
  );

  return (
    <CollapsibleSection prefKey="review.bench" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Bench" subtitle="where the next position comes from — Ready / Wait / Watch" defaultCollapsed>
      {state === "loading" ? <p className="text-[12px] text-ink-3">Loading…</p> : state === "none" ? <p className="text-[12px] text-ink-3">Entry scan unavailable.</p> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {LANES.map((l) => {
            const list = laneRows(l.key);
            return (
              <div key={l.key}>
                <div className="mb-1 text-[11.5px] font-medium text-ink-2">{l.title} · {list.length} <span className="font-normal text-ink-3">— {l.hint}</span></div>
                {table(list)}
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}
