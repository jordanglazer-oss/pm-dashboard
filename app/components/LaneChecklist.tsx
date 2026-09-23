"use client";

import React from "react";
import { LANE_LABEL, type LaneCheck, type LaneRead } from "@/app/lib/lanes";

/* The Thesis / Tactical readiness checklist for one unowned name. Each item is
 * a tick, a cross, or a dash (unknown), with the reading beside it. */

const mark = (ok: boolean | null) => (ok === true ? <span className="text-pos">✓</span> : ok === false ? <span className="text-neg">✗</span> : <span className="text-ink-faint">–</span>);

export function laneTone(lane: LaneRead["lane"]): string {
  return lane === "thesis-now" ? "bg-pos-soft text-pos" : lane === "thesis-wait" ? "bg-accent-soft text-accent" : lane === "tactical" ? "bg-violet-soft text-violet" : "bg-line-soft text-ink-3";
}

export function LaneChip({ lane }: { lane: LaneRead }) {
  const missing = (cs: LaneCheck[]) => cs.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.reading}`);
  const title = [
    `Thesis: ${lane.thesisReady ? "ready" : "not ready"}${lane.thesisReady ? "" : ` — ${missing(lane.thesis).join("; ")}`}`,
    `Tactical: ${lane.tacticalReady ? "ready" : "not ready"}${lane.tacticalReady ? "" : ` — ${missing(lane.tactical).join("; ")}`}`,
  ].join("\n");
  return <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium whitespace-nowrap ${laneTone(lane.lane)}`} title={title}>{LANE_LABEL[lane.lane]}</span>;
}

export function LaneChecklist({ lane, compact = false }: { lane: LaneRead; compact?: boolean }) {
  const col = (title: string, ready: boolean, checks: LaneCheck[]) => (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2 text-[11.5px] font-medium text-ink">
        {title}
        <span className={`text-[11px] font-normal ${ready ? "text-pos" : "text-ink-3"}`}>{ready ? "ready" : "not ready"}</span>
      </div>
      <ul className={`flex flex-col ${compact ? "gap-0.5" : "gap-1"} text-[12px]`}>
        {checks.map((c) => (
          <li key={c.key} className="flex items-start gap-1.5">
            <span className="w-3 shrink-0 font-mono">{mark(c.ok)}</span>
            <span className="text-ink-2">{c.label}</span>
            <span className="min-w-0 truncate text-ink-3" title={c.reading}>· {c.reading}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className={`grid gap-x-5 gap-y-2 ${compact ? "" : "md:grid-cols-2"}`}>
      {col("Thesis", lane.thesisReady, lane.thesis)}
      {col("Tactical", lane.tacticalReady, lane.tactical)}
    </div>
  );
}
