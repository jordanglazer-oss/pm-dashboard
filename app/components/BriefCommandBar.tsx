"use client";

import React from "react";
import { AppIcon } from "./AppIcon";

/**
 * The Brief's first row — its toolbar, to the canvas:
 *
 *   Tuesday, September 8 · generated 6:42 ET    Daily input 9/9 entered    [Daily input] [Regenerate]
 *
 * Replaces the sticky command bar. The regime read it used to carry lives in
 * the decision panel's Regime cell; the section rail is gone (the Board /
 * Horizons / Narrative folds are one tabbed panel now) but every anchor id
 * (s-today, s-act, s-board, s-horizon, s-narrative) still exists for links.
 * The Brief / Daily-input switch and Regenerate are unchanged in behaviour.
 */

export type BriefInputProgress = {
  /** Fields entered today. */
  done: number;
  total: number;
  /** The PM marked today's input complete (remaining gaps intentionally skipped). */
  marked: boolean;
};

/** "Tuesday, September 8" from a YYYY-MM-DD (parsed as a local date). */
function longDate(ymd: string | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "6:42 ET" — Eastern clock time of the generation. */
function easternTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
  return `${t.replace(/\s?[AP]M$/i, "")} ET`;
}

export function BriefCommandBar({
  date,
  generatedAt,
  inputProgress,
  briefMode,
  onModeChange,
  onRegenerate,
  generating,
}: {
  date: string;
  generatedAt?: string;
  inputProgress?: BriefInputProgress;
  briefMode: "brief" | "input";
  onModeChange: (m: "brief" | "input") => void;
  onRegenerate: () => void;
  generating: boolean;
}) {
  const time = easternTime(generatedAt);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <span className="text-[12.5px] text-ink-2">
        {longDate(date)}
        {time ? (
          <>
            {" "}· generated <span className="font-mono">{time}</span>
          </>
        ) : (
          <> · not generated yet</>
        )}
      </span>
      {inputProgress && (
        <button
          type="button"
          onClick={() => onModeChange(briefMode === "input" ? "brief" : "input")}
          className="text-[12px] text-ink-3 hover:text-ink"
          title={briefMode === "input" ? "Back to the brief" : "Open the daily input"}
        >
          Daily input{" "}
          <span className="font-mono">
            {inputProgress.marked ? inputProgress.total : inputProgress.done}/{inputProgress.total}
          </span>{" "}
          entered
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <div className="seg">
          <button type="button" className={briefMode === "brief" ? "on" : ""} onClick={() => onModeChange("brief")}>
            Brief
          </button>
          <button type="button" className={briefMode === "input" ? "on" : ""} onClick={() => onModeChange("input")}>
            Daily input
          </button>
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={generating}
          title="Regenerate the brief from the current inputs"
          className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          <AppIcon name="refresh" size={13} className={generating ? "animate-spin" : ""} />
          {generating ? "Generating…" : "Regenerate"}
        </button>
      </div>
    </div>
  );
}
