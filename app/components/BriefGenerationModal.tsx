"use client";

import React, { useEffect, useState } from "react";

/**
 * Generation progress modal.
 *
 * HONESTY NOTE — why there are no animated per-step checkmarks like the mock:
 * /api/morning-brief returns a SINGLE JSON response, and most of its work runs
 * inside one Promise.all (sector perf, forward-looking macro, strategist
 * history, research, hedging costs, market regime all resolve concurrently).
 * The client therefore cannot observe when any individual step finishes, and
 * the steps aren't even sequential. Ticking them off on a timer would invent a
 * progress signal that doesn't exist.
 *
 * So this shows what the run actually does (accurate — these are the real
 * inputs it gathers), a real elapsed timer, and an indeterminate bar. If we
 * later convert the route to a streamed response emitting per-phase events,
 * this component can light the steps up for real with no UI change.
 */

/** The work the route genuinely performs, for orientation while waiting. */
const STEPS = [
  "Refresh prices & FX",
  "Fetch forward-looking macro",
  "Recompute market regime",
  "Read manual breadth entry",
  "Price the SPY put ladder",
  "Scan the portfolio for risk flags",
  "Compose the narrative",
];

export function BriefGenerationModal({
  open,
  onRunInBackground,
  hasPreviousBrief,
}: {
  open: boolean;
  onRunInBackground: () => void;
  hasPreviousBrief: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!open) return;
    // No synchronous setState in the effect body (react-hooks lint): elapsed
    // is derived from a start timestamp inside the interval, and reset in the
    // cleanup so the next open starts from 0.
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => {
      clearInterval(t);
      setElapsed(0);
    };
  }, [open]);

  if (!open) return null;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 backdrop-blur-sm">
      <div className="animate-fade-up w-full max-w-md rounded-card border border-line bg-white p-5 shadow-card">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            <h2 className="text-base font-semibold text-ink">Generating the brief</h2>
          </div>
          <span className="font-mono text-xs text-ink-3">
            {mins}:{String(secs).padStart(2, "0")}
          </span>
        </div>

        {/* Indeterminate — the route reports no intermediate progress. */}
        <div className="mt-3 h-1 overflow-hidden rounded-pill bg-line">
          <div className="shimmer-sweep h-full w-1/3 rounded-pill bg-accent" />
        </div>

        <ul className="mt-4 space-y-1.5">
          {STEPS.map((s) => (
            <li key={s} className="flex items-center gap-2.5 text-[13px] text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
              {s}
            </li>
          ))}
        </ul>

        <p className="mt-3 text-[11px] leading-4 text-ink-3">
          These run mostly in parallel and finish server-side, so there is no
          per-step tick to show — the timer above is the real signal.
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-3">
            {hasPreviousBrief
              ? "You can keep reading the current brief while this runs."
              : "This usually takes under a minute."}
          </span>
          <button
            onClick={onRunInBackground}
            className="shrink-0 rounded-control border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
          >
            Run in background
          </button>
        </div>
      </div>
    </div>
  );
}
