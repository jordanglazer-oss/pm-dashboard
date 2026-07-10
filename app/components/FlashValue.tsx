"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Briefly tints its contents green (value rose) or red (value fell) when the
 * `value` changes — e.g. a price/score updating on refresh — then settles. A
 * component (not a bare hook) so it can be dropped inside a table `.map` without
 * breaking the rules of hooks. Respects prefers-reduced-motion (the flash
 * keyframes no-op there). Does not flash on first mount, only on real changes.
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
  const prev = useRef(value);
  const [flash, setFlash] = useState<"" | "flash-pos" | "flash-neg">("");

  useEffect(() => {
    const p = prev.current;
    if (p != null && value != null && value !== p) {
      setFlash(value > p ? "flash-pos" : "flash-neg");
      prev.current = value;
      const t = setTimeout(() => setFlash(""), 950);
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  return <span className={`${flash} -mx-1 rounded px-1 ${className}`}>{children}</span>;
}
