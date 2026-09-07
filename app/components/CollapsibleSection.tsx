"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "./AppIcon";

/**
 * A card section whose body collapses/expands, with the state PERSISTED via
 * pm:ui-prefs (useCollapsed) so it survives tab navigation + refresh. The
 * header (title + optional right-side controls) stays visible when collapsed,
 * so the user can see what to re-open. Default = expanded.
 */
export function CollapsibleSection({
  prefKey,
  linkedKeys,
  className,
  title,
  subtitle,
  titleClass,
  right,
  defaultCollapsed = false,
  flush = false,
  children,
}: {
  prefKey: string;
  /** Other prefKeys to collapse/expand in lockstep with this one (e.g. a
      side-by-side pair that should open/close together). */
  linkedKeys?: string[];
  /** Border/background classes for the outer <section> (e.g. "border-warn-border"). */
  className?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Classes for the title (e.g. "text-[13px] font-semibold text-warn"). */
  titleClass?: string;
  /** Right-aligned header content (counts, refresh buttons, etc.). */
  right?: React.ReactNode;
  /** Start collapsed the FIRST time this section is seen (before the user has
   *  toggled it). Once toggled, the persisted pref wins. Used for secondary
   *  reference sections that should be tucked away until opened. */
  defaultCollapsed?: boolean;
  /** Render as a ROW inside a shared card rather than as its own card: no
   *  border, radius, shadow or card padding, and a tighter title. Used by the
   *  Brief's Narrative list, which the design shows as one card of thin
   *  divided rows rather than a stack of separate panels. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  const { uiPrefs, setUiPref } = useStocks();
  // Persisted pref wins once set; until then fall back to defaultCollapsed.
  // Note: reading an unset pref never writes, so nothing persists until the
  // user actually toggles — the default stays purely presentational.
  const collapsed = prefKey in uiPrefs ? uiPrefs[prefKey] === "1" : defaultCollapsed;
  const toggle = () => {
    const next = collapsed ? "0" : "1";
    setUiPref(prefKey, next);
    // Keep any linked sections in lockstep (functional setState in setUiPref
    // makes these successive writes safe from stale-closure clobber).
    (linkedKeys || []).forEach((k) => setUiPref(k, next));
  };
  return (
    <section
      id={prefKey}
      className={
        flush
          ? `bg-surface px-4 py-2 scroll-mt-24 ${className || ""}`
          : `overflow-hidden rounded-card border bg-surface scroll-mt-24 ${className || "border-line"}`
      }
    >
      {/* Panel header: 38px, 13px semibold title, meta beside it. */}
      <div className={`flex items-center justify-between gap-3 ${flush ? "" : `min-h-[38px] px-3.5 ${collapsed ? "" : "border-b border-line-soft"}`}`}>
        {/* The whole title region (arrow + title + subtitle + the empty space up
            to the right-side controls) toggles — not just the arrow. Uses a div
            with role="button" rather than <button> so the `right` slot can hold
            its own buttons without nesting. */}
        <div
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand section" : "Collapse section"}
          className="flex flex-1 items-center gap-2 min-w-0 text-left cursor-pointer group"
        >
          <span className={`text-ink-3 group-hover:text-ink-2 leading-none shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}>
            <AppIcon name="chevD" size={flush ? 12 : 14} strokeWidth={2} />
          </span>
          {/* Flush rows keep title + subtitle on ONE line so a narrative row is
              the same height as the Brief's other collapsed rails (a `block`
              title pushed the subtitle onto a second line: 61px vs 42px). */}
          <span className="min-w-0 flex-1 flex items-baseline gap-2 truncate">
            <span className={`shrink-0 ${titleClass || "text-[13px] font-semibold text-ink"}`}>{title}</span>
            {subtitle && <span className="min-w-0 truncate text-[11.5px] text-ink-3">{subtitle}</span>}
          </span>
        </div>
        {right && (
          <div
            className="flex items-center gap-3 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {right}
          </div>
        )}
      </div>
      {!collapsed && <div className={`animate-section-reveal ${flush ? "mt-2 pl-5" : "px-3.5 py-3"}`}>{children}</div>}
    </section>
  );
}
