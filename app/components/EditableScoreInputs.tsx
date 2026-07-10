"use client";

/**
 * Shared editable inputs for external-scoring fields:
 *   - EditableNumberCell — partial-typing-safe number input with bounds
 *     and on-blur / Enter commit. Used for FactSet target, analyst count,
 *     BoostedAI rating, and SIA SMAX.
 *   - ConsensusButton — chip that cycles through BoostedAI consensus
 *     values on click (Strong Buy → Buy → Hold → Sell → Strong Sell → —).
 *
 * Originally lived inline in the Inbox tab. Lifted to a shared module so
 * the Stock page can render the same inputs under the AI Rating and
 * Relative Strength categories — keeps the editing surface uniform
 * regardless of which page the PM is on.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  consensusLabel,
  consensusToneClass,
  type BoostedAiConsensus,
} from "@/app/lib/external-scoring";

export function EditableNumberCell({
  value,
  step,
  onCommit,
  width,
  placeholder,
  ariaLabel,
  formatDisplay,
  min,
  max,
}: {
  value: number | null;
  step: string; // e.g. "0.01" or "1"
  onCommit: (next: number | null) => void;
  width: string; // tailwind class
  placeholder?: string;
  ariaLabel: string;
  formatDisplay?: (n: number) => string;
  /** Optional inclusive bounds. When set, the input enforces them via the
   *  native HTML attribute AND the commit handler clamps to the range. */
  min?: number;
  max?: number;
}) {
  // Local string state so the user can type partial values (e.g. "12.")
  // without the parent coercing the value to a number mid-keystroke.
  const [str, setStr] = useState<string>(value != null ? (formatDisplay ? formatDisplay(value) : String(value)) : "");
  const initialRef = useRef(str);

  // Re-sync when parent value changes (e.g. another device edited, or
  // a refresh pulled new data). Skip when the field is focused so we
  // don't yank the value out from under the user mid-type.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    const next = value != null ? (formatDisplay ? formatDisplay(value) : String(value)) : "";
    setStr(next);
    initialRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (str === initialRef.current) return; // no change
    const trimmed = str.trim();
    if (trimmed === "") {
      onCommit(null);
      initialRef.current = "";
      return;
    }
    let n = parseFloat(trimmed);
    if (!isFinite(n)) {
      // Not a number — snap back to prior value
      setStr(initialRef.current);
      return;
    }
    // Lower bound: an explicit `min` (which may be NEGATIVE — e.g. MarketEdge
    // Power Rating −60 or Opinion Score −4) is the floor; out-of-range values
    // clamp to it. With NO `min`, the field is non-negative by default (SMAX,
    // ratings, price targets), so a negative input is rejected.
    if (typeof min === "number") {
      if (n < min) n = min;
    } else if (n < 0) {
      setStr(initialRef.current);
      return;
    }
    if (typeof max === "number" && n > max) n = max;
    onCommit(n);
    const finalDisplay = formatDisplay ? formatDisplay(n) : String(n);
    setStr(finalDisplay);
    initialRef.current = finalDisplay;
  };

  return (
    <input
      ref={inputRef}
      type="number"
      step={step}
      min={min}
      max={max}
      value={str}
      onChange={(e) => setStr(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setStr(initialRef.current);
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder ?? "—"}
      aria-label={ariaLabel}
      className={`${width} rounded border border-line bg-white text-ink px-1.5 py-0.5 text-xs font-mono text-right outline-none focus:border-accent-border focus:ring-1 focus:ring-accent-border placeholder-ink-faint`}
    />
  );
}

/**
 * Cycle-on-click consensus chip. Left-click advances forward, right-click
 * or shift-click reverses. Color-coded by current value via
 * consensusToneClass(). Width is locked so it doesn't shift the
 * surrounding table when the label changes length.
 */
export function ConsensusButton({
  value,
  onChange,
  ariaLabel,
}: {
  value: BoostedAiConsensus | null;
  onChange: (next: BoostedAiConsensus | null) => void;
  ariaLabel: string;
}) {
  const cycle: (BoostedAiConsensus | null)[] = [
    null,
    "strong-buy",
    "buy",
    "hold",
    "sell",
    "strong-sell",
  ];
  const idx = value == null ? 0 : Math.max(0, cycle.indexOf(value));
  const advance = (forward: boolean) => {
    const len = cycle.length;
    const next = forward ? (idx + 1) % len : (idx - 1 + len) % len;
    onChange(cycle[next]);
  };

  return (
    <button
      type="button"
      onClick={(e) => advance(!e.shiftKey)}
      onContextMenu={(e) => {
        e.preventDefault();
        advance(false);
      }}
      aria-label={ariaLabel}
      title="Click to cycle to the next consensus value. Shift-click or right-click to go backwards. Drives aiRating along with the numeric rating."
      className={`inline-flex w-[82px] items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-all hover:opacity-90 hover:shadow-sm cursor-pointer whitespace-nowrap ${consensusToneClass(value)}`}
    >
      {consensusLabel(value)}
    </button>
  );
}
