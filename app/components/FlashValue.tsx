"use client";

import { useState } from "react";

/**
 * Briefly tints its contents green (value rose) or red (value fell) when the
 * `value` changes — e.g. a price/score updating on refresh — then settles. A
 * component (not a bare hook) so it can be dropped inside a table `.map` without
 * breaking the rules of hooks. Respects prefers-reduced-motion (the flash
 * keyframes no-op there). Does not flash on first mount, only on real changes.
 *
 * The direction is derived while rendering from the previous value rather than
 * from an effect: an effect that calls setState synchronously costs a second
 * render per cell on every price refresh, which in a 40-row table is 40
 * cascading renders for a cosmetic tint. `seq` bumps on every change so the
 * `key` remounts the span — that is what restarts the one-shot CSS animation
 * when the SAME direction fires twice in a row (the class alone would not),
 * and it replaces the timeout that used to clear the class. The animation ends
 * at a transparent background, so a class left in place after it finishes is
 * visually identical to no class at all.
 */
export function FlashValue({
  value,
  children,
  className = "",
}: {
  value: number | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState({ cls: "", seq: 0 });

  // React's "adjust state while rendering" escape hatch: the render that first
  // sees a new `value` also decides the tint, so nothing renders twice.
  if (prev !== value) {
    const before = prev;
    setPrev(value);
    if (before != null && value != null) {
      setFlash((f) => ({ cls: value > before ? "flash-pos" : "flash-neg", seq: f.seq + 1 }));
    }
  }

  return (
    <span key={flash.seq} className={`${flash.cls} -mx-1 rounded px-1 ${className}`}>
      {children}
    </span>
  );
}
