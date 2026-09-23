"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { computeSetup } from "@/app/lib/setup-grade";
import { sleevesOf, isCoreDesignated } from "@/app/lib/sleeves";
import { isScoreable } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { LaneChip } from "@/app/components/LaneChecklist";
import type { EntryScan, EntryRow } from "@/app/lib/entry-scan";
import type { Lane } from "@/app/lib/lanes";

/* The bench — where the next position comes from, sorted into lanes by the
 * readiness engine (app/lib/lanes): Thesis-ready names (enter now / wait for
 * setup), Tactical-ready names (tape before case — held on a plan), everything
 * else with what it is missing, and held Thesis names with a working setup as
 * overlay candidates. Watchlist AND Suggested names, from /api/entry-scan.
 * Read-only. The Tactical entry floor is deferred and not enforced. */

const GRADE_ORDER: Record<string, number> = { Strong: 0, Constructive: 1, Neutral: 2, Weak: 3, Broken: 4 };
const gradeCls = (g: string | null | undefined) => (g === "Strong" || g === "Constructive" ? "text-pos" : g === "Weak" || g === "Broken" ? "text-neg" : "text-ink-3");
const LANES: Array<{ key: Lane | "thesis"; title: string; hint: string; match: (l: Lane) => boolean }> = [
  { key: "thesis", title: "Thesis lane", hint: "case proven — reports on file, synthesis Advance after them, conviction Hold+", match: (l) => l === "thesis-now" || l === "thesis-wait" },
  { key: "tactical", title: "Tactical lane", hint: "tape ready before the case is — held on a plan", match: (l) => l === "tactical" },
  { key: "watch", title: "Watch", hint: "neither lane yet — hover the chip for what is missing", match: (l) => l === "watch" },
];

export function TacticalBench() {
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

  const laneRows = (match: (l: Lane) => boolean) => rows
    .filter(({ r }) => r.lane && match(r.lane.lane))
    .sort((a, b) => (a.r.lane!.lane === "thesis-now" ? -1 : 0) - (b.r.lane!.lane === "thesis-now" ? -1 : 0) || Number(b.r.ready) - Number(a.r.ready) || b.r.met - a.r.met || (GRADE_ORDER[a.grade ?? "Neutral"] ?? 2) - (GRADE_ORDER[b.grade ?? "Neutral"] ?? 2));

  const overlay = useMemo(() => scoredStocks
    .filter((s) => s.bucket === "Portfolio" && isScoreable(s) && !isCoreDesignated(s) && sleevesOf(s).thesis && !sleevesOf(s).tactical)
    .map((s) => ({ s, setup: computeSetup(s) }))
    .filter((x) => x.setup.grade === "Strong" || x.setup.grade === "Constructive")
    .sort((a, b) => GRADE_ORDER[a.setup.grade!] - GRADE_ORDER[b.setup.grade!] || b.s.adjusted - a.s.adjusted), [scoredStocks]);

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
    <CollapsibleSection prefKey="review.bench" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Bench" subtitle="where the next Thesis or Tactical position comes from — Thesis wins when a name reads both; no entry floor is enforced yet" defaultCollapsed>
      {state === "loading" ? <p className="text-[12px] text-ink-3">Loading…</p> : state === "none" ? <p className="text-[12px] text-ink-3">Entry scan unavailable.</p> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {LANES.map((l) => {
            const list = laneRows(l.match);
            return (
              <div key={l.key}>
                <div className="mb-1 text-[11.5px] font-medium text-ink-2">{l.title} · {list.length} <span className="font-normal text-ink-3">— {l.hint}</span></div>
                {table(list)}
              </div>
            );
          })}
          <div>
            <div className="mb-1 text-[11.5px] font-medium text-ink-2">Overlay candidates · {overlay.length} <span className="font-normal text-ink-3">— held Thesis names with a working setup and no tactical leg</span></div>
            <div className="overflow-auto"><table className="data-table">
              <thead><tr><th>Name</th><th>Setup</th><th className="text-right">Score</th><th className="text-right">Next</th></tr></thead>
              <tbody>
                {overlay.map(({ s, setup }) => (
                  <tr key={s.ticker}>
                    <td><Link href={`/stock/${s.ticker.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">{displayTicker(s.ticker)}</Link><span className="ml-2 hidden text-[11.5px] text-ink-3 md:inline">{s.name}</span></td>
                    <td><span className={gradeCls(setup.grade)}>{setup.grade} {setup.rawPoints}/{setup.availableMax}</span></td>
                    <td className="n">{Number(s.adjusted.toFixed(1))} <span className="text-[11px] text-ink-3">{s.ratingLabel || s.rating}</span></td>
                    <td className="n"><span className="text-[11.5px] text-ink-2">tag Tactical on Holdings to add the overlay</span></td>
                  </tr>
                ))}
                {overlay.length === 0 && <tr><td colSpan={4} className="text-ink-3">No Thesis name reads Strong or Constructive right now.</td></tr>}
              </tbody>
            </table></div>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
