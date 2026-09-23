"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { computeSetup, actionFor } from "@/app/lib/setup-grade";
import { sleevesOf, isCoreDesignated } from "@/app/lib/sleeves";
import { isScoreable } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import type { EntryScan } from "@/app/lib/entry-scan";

/* Tactical Bench — where the next Tactical position comes from. Two lists:
 *   Watchlist   every watchlist stock, ranked by entry readiness (the standard
 *               scorecard from /api/entry-scan), then setup grade.
 *   Overlay     held Thesis names with a Strong / Constructive setup and no
 *               tactical leg yet — candidates for a temporary overweight.
 * Read-only. The Tactical ENTRY FLOOR (a minimum conviction band / no critical
 * alert to open a Tactical position) is deliberately not enforced yet — the PM
 * deferred it; the columns it would gate on are all shown. */

const GRADE_ORDER: Record<string, number> = { Strong: 0, Constructive: 1, Neutral: 2, Weak: 3, Broken: 4 };
const gradeCls = (g: string | null) => (g === "Strong" || g === "Constructive" ? "text-pos" : g === "Weak" || g === "Broken" ? "text-neg" : "text-ink-3");

export function TacticalBench() {
  const { scoredStocks } = useStocks();
  const [scan, setScan] = useState<EntryScan | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/entry-scan", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => alive && d && setScan(d)).catch(() => {});
    return () => { alive = false; };
  }, []);
  const scanBy = useMemo(() => new Map((scan?.rows ?? []).map((r) => [r.ticker.toUpperCase(), r])), [scan]);

  const watch = useMemo(() => scoredStocks
    .filter((s) => s.bucket === "Watchlist" && isScoreable(s))
    .map((s) => {
      const setup = computeSetup(s);
      const e = scanBy.get(s.ticker.toUpperCase());
      return { s, setup, e, action: actionFor(s.ratingLabel || s.rating, setup.grade ?? "Neutral") };
    })
    .sort((a, b) => Number(b.e?.ready ?? false) - Number(a.e?.ready ?? false) || (b.e?.met ?? 0) - (a.e?.met ?? 0) || (GRADE_ORDER[a.setup.grade ?? "Neutral"] - GRADE_ORDER[b.setup.grade ?? "Neutral"]) || b.s.adjusted - a.s.adjusted), [scoredStocks, scanBy]);

  const overlay = useMemo(() => scoredStocks
    .filter((s) => s.bucket === "Portfolio" && isScoreable(s) && !isCoreDesignated(s) && sleevesOf(s).thesis && !sleevesOf(s).tactical)
    .map((s) => ({ s, setup: computeSetup(s) }))
    .filter((r) => r.setup.grade === "Strong" || r.setup.grade === "Constructive")
    .sort((a, b) => GRADE_ORDER[a.setup.grade!] - GRADE_ORDER[b.setup.grade!] || b.s.adjusted - a.s.adjusted), [scoredStocks]);

  const row = (tk: string, name: string | undefined, cells: React.ReactNode[]) => (
    <tr key={tk}>
      <td><Link href={`/stock/${tk.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">{displayTicker(tk)}</Link><span className="ml-2 hidden text-[11.5px] text-ink-3 md:inline">{name}</span></td>
      {cells.map((c, i) => <td key={i} className={i >= 2 ? "n" : ""}>{c}</td>)}
    </tr>
  );

  return (
    <CollapsibleSection prefKey="review.bench" className="border-line" titleClass="text-[13px] font-semibold text-ink" title="Tactical bench" subtitle="where the next Tactical position comes from — no entry floor is enforced yet" defaultCollapsed>
      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-1 text-[11.5px] font-medium text-ink-2">Watchlist · {watch.length} · ready {watch.filter((w) => w.e?.ready).length}</div>
          <div className="overflow-auto"><table className="data-table">
            <thead><tr><th>Name</th><th>Entry</th><th>Setup</th><th className="text-right">Score</th><th className="text-right">Action</th></tr></thead>
            <tbody>
              {watch.slice(0, 15).map(({ s, setup, e, action }) => row(s.ticker, s.name, [
                <span key="e" className={e?.ready ? "text-pos" : "text-ink-3"}>{e ? `${e.strength} · ${e.met}/${e.known}` : "—"}</span>,
                <span key="g" className={gradeCls(setup.grade)}>{setup.grade ?? "n/a"}</span>,
                <span key="s">{Number(s.adjusted.toFixed(1))} <span className="text-[11px] text-ink-3">{s.ratingLabel || s.rating}</span></span>,
                <span key="a" className="text-[11.5px] text-ink-2">{action}</span>,
              ]))}
              {watch.length === 0 && <tr><td colSpan={5} className="text-ink-3">No watchlist stocks.</td></tr>}
            </tbody>
          </table></div>
        </div>
        <div>
          <div className="mb-1 text-[11.5px] font-medium text-ink-2">Overlay candidates · Thesis names with a working setup and no tactical leg · {overlay.length}</div>
          <div className="overflow-auto"><table className="data-table">
            <thead><tr><th>Name</th><th>Setup</th><th>—</th><th className="text-right">Score</th><th className="text-right">Action</th></tr></thead>
            <tbody>
              {overlay.map(({ s, setup }) => row(s.ticker, s.name, [
                <span key="g" className={gradeCls(setup.grade)}>{setup.grade} {setup.rawPoints}/{setup.availableMax}</span>,
                <span key="x" />,
                <span key="s">{Number(s.adjusted.toFixed(1))} <span className="text-[11px] text-ink-3">{s.ratingLabel || s.rating}</span></span>,
                <span key="a" className="text-[11.5px] text-ink-2">tag Tactical on Holdings to add the overlay</span>,
              ]))}
              {overlay.length === 0 && <tr><td colSpan={5} className="text-ink-3">No Thesis name reads Strong or Constructive right now.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
