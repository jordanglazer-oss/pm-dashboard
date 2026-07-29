"use client";

import React, { useEffect, useRef, useState } from "react";
import { BRIEF_STEPS, type BriefProgress } from "@/app/lib/brief-progress-shared";

/**
 * Generation progress modal — now with REAL per-step ticks.
 *
 * History: this modal originally refused to animate steps, because the route
 * returned a single JSON response and ticking on a timer would have invented
 * a progress signal that didn't exist. The route now reports actual phase
 * completions (each phase marks pm:brief-progress the moment its promise
 * settles — see app/lib/brief-progress.ts), and this modal polls that blob
 * while open. Steps complete in whatever order the upstreams genuinely
 * answer, because the phases run concurrently — an honest, slightly
 * out-of-order tick beats a fabricated sequence.
 *
 * The elapsed timer derives from a start timestamp inside the interval (no
 * synchronous setState in the effect body — react-hooks lint).
 */

export function BriefGenerationModal({
  open,
  runId,
  onRunInBackground,
  hasPreviousBrief,
}: {
  open: boolean;
  /** The generation run to watch — must match what the client POSTed. */
  runId: string | null;
  onRunInBackground: () => void;
  hasPreviousBrief: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => {
      clearInterval(t);
      setElapsed(0);
    };
  }, [open]);

  // Poll the progress blob while the modal is open. Guarded by runId so a
  // stale blob from a previous generation can never render as live progress.
  const [progress, setProgress] = useState<BriefProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!open || !runId) return;
    let alive = true;
    const poll = () =>
      fetch(`/api/brief-progress?runId=${encodeURIComponent(runId)}`)
        .then((r) => r.json())
        .then((d) => {
          if (alive && d?.progress) setProgress(d.progress as BriefProgress);
        })
        .catch(() => {});
    poll();
    pollRef.current = setInterval(poll, 1200);
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
      setProgress(null);
    };
  }, [open, runId]);

  if (!open) return null;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const doneSet = new Set(progress?.done ?? []);
  const pct = Math.round((doneSet.size / BRIEF_STEPS.length) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 backdrop-blur-sm">
      <div className="animate-fade-up w-full max-w-md overflow-hidden rounded-card border border-line bg-white shadow-card">
        <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            <h2 className="text-base font-semibold text-ink">Generating the brief</h2>
          </div>
          <span className="font-mono text-xs text-ink-3">
            {progress ? `${pct}%` : `${mins}:${String(secs).padStart(2, "0")}`}
          </span>
        </div>

        {/* Determinate once real progress arrives; shimmer until the first poll. */}
        <div className="mt-3 h-1 overflow-hidden bg-line">
          {progress ? (
            <div className="h-full bg-accent transition-all duration-500" style={{ width: `${Math.max(4, pct)}%` }} />
          ) : (
            <div className="shimmer-sweep h-full w-1/3 rounded-pill bg-accent" />
          )}
        </div>

        <ul className="px-5 pt-2.5">
          {BRIEF_STEPS.map((s) => {
            const done = doneSet.has(s.key);
            return (
              <li
                key={s.key}
                className="flex items-center gap-2.5 border-b border-line-soft py-2.5 text-[13px] last:border-b-0"
              >
                {done ? (
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-pos"
                    aria-hidden
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-pos" />
                  </span>
                ) : (
                  <span className="h-4 w-4 shrink-0 animate-pulse rounded-full border-2 border-line" aria-hidden />
                )}
                <span className={done ? "text-ink" : "text-ink-2"}>{s.label}</span>
                <span className={`ml-auto text-[11px] ${done ? "text-ink-3" : "text-ink-faint"}`}>
                  {done ? "done" : progress ? "running" : "…"}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-2 flex items-center justify-between gap-3 border-t border-line bg-surface-2/50 px-5 py-3.5">
          <span className="text-[11px] text-ink-3">
            {hasPreviousBrief
              ? "You can keep reading yesterday's brief while this runs."
              : "This usually takes under a minute."}
          </span>
          <button
            onClick={onRunInBackground}
            className="shrink-0 rounded-control border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
          >
            {hasPreviousBrief ? "View brief" : "Run in background"}
          </button>
        </div>
      </div>
    </div>
  );
}
