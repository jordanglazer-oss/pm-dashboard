"use client";

import React from "react";
import { LANE_LABEL, normalizeLane, type LaneCheck, type LaneRead } from "@/app/lib/lanes";

/* The Case / Tape readiness checklist for one unowned name. Each item is
 * a tick, a cross, or a dash (unknown), with the reading beside it. */

const mark = (ok: boolean | null) => (ok === true ? <span className="text-pos">✓</span> : ok === false ? <span className="text-neg">✗</span> : <span className="text-ink-faint">–</span>);

export function laneTone(raw: LaneRead["lane"]): string {
  const lane = normalizeLane(raw);
  return lane === "ready" ? "bg-pos-soft text-pos" : lane === "wait" ? "bg-accent-soft text-accent" : "bg-line-soft text-ink-3";
}

export function LaneChip({ lane }: { lane: LaneRead }) {
  const missing = (cs: LaneCheck[]) => cs.filter((c) => c.ok !== true).map((c) => `${c.label}: ${c.reading}`);
  const title = [
    `Case: ${lane.thesisReady ? "proven" : "not proven"}${lane.thesisReady ? "" : ` — ${missing(lane.thesis).join("; ")}`}`,
    `Tape: ${lane.tacticalReady ? "ready" : "not ready"}${lane.tacticalReady ? "" : ` — ${missing(lane.tactical).join("; ")}`}`,
  ].join("\n");
  return <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium whitespace-nowrap ${laneTone(lane.lane)}`} title={title}>{LANE_LABEL[normalizeLane(lane.lane)]}</span>;
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
      {col("Case", lane.thesisReady, lane.thesis)}
      {col("Tape", lane.tacticalReady, lane.tactical)}
    </div>
  );
}
