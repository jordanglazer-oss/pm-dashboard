"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tweens a number from its previous value to the next over 640ms (easeOutCubic)
 * via requestAnimationFrame, so a figure that updates on refresh rolls up/down
 * instead of snapping (#01). Pair with FlashValue for the green/red tint. An
 * optional delta pill (▲ +N.N / ▼ N.N) pops in on each change. Snaps instantly
 * under prefers-reduced-motion.
 */
export function CountUp({
  value,
  format,
  className = "",
  showDelta = false,
  deltaFormat,
}: {
  value: number;
  /** Format the animating number for display (default: 2 decimals). */
  format?: (n: number) => string;
  className?: string;
  /** Show a ▲/▼ delta pill next to the figure on each change. */
  showDelta?: boolean;
  deltaFormat?: (n: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const [delta, setDelta] = useState(0);
  const [deltaKey, setDeltaKey] = useState(0);
  const prevRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) return;
    setDelta(to - from);
    setDeltaKey((k) => k + 1);

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setDisplay(to);
      prevRef.current = to;
      return;
    }

    const start = performance.now();
    const DUR = 640;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DUR);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        prevRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value]);

  const fmt = format ?? ((n: number) => n.toFixed(2));
  const dfmt = deltaFormat ?? ((n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`);

  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`}>
      <span className="tabular-nums">{fmt(display)}</span>
      {showDelta && delta !== 0 && (
        <span
          key={deltaKey}
          className={`animate-chip-in inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ${
            delta >= 0 ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg"
          }`}
        >
          {delta >= 0 ? "▲" : "▼"} {dfmt(delta)}
        </span>
      )}
    </span>
  );
}
