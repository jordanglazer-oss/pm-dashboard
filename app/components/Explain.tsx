"use client";

import React from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";

/**
 * The one place explanatory text goes (Nov 2026 declutter): how a number is
 * calculated, caveats, assumptions, "how to read this". A panel shows its
 * numbers and at most one short line; everything else sits behind this small
 * link, closed by default, and the choice persists (pm:ui-prefs) so a person
 * who wants the notes open keeps them open.
 *
 * Rules for using it:
 *  - Never put a NUMBER the reader needs, or a warning that a figure is
 *    unreliable, behind it. Those stay visible.
 *  - One Explain per panel; give it a stable, unique prefKey.
 */
export function Explain({
  prefKey,
  label = "About these numbers",
  children,
  className = "",
  defaultOpen = false,
}: {
  prefKey: string;
  /** The link text when closed, e.g. "How this is calculated". */
  label?: string;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, toggle] = usePersistedOpen(prefKey, defaultOpen);
  return (
    <div className={className}>
      <button type="button" onClick={toggle} aria-expanded={open} className="text-[12px] font-medium text-ink-3 underline decoration-line underline-offset-2 hover:text-ink-2">
        {open ? "Hide: " + label.charAt(0).toLowerCase() + label.slice(1) : label}
      </button>
      {open && <div className="mt-1.5 text-[12px] leading-snug text-ink-3">{children}</div>}
    </div>
  );
}
