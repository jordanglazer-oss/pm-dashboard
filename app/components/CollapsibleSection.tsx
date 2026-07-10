"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";

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
  /** Classes for the <h3> (e.g. "text-xl font-bold text-warn"). */
  titleClass?: string;
  /** Right-aligned header content (counts, refresh buttons, etc.). */
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { uiPrefs, setUiPref } = useStocks();
  const collapsed = uiPrefs[prefKey] === "1";
  const toggle = () => {
    const next = collapsed ? "0" : "1";
    setUiPref(prefKey, next);
    // Keep any linked sections in lockstep (functional setState in setUiPref
    // makes these successive writes safe from stale-closure clobber).
    (linkedKeys || []).forEach((k) => setUiPref(k, next));
  };
  return (
    <section className={`rounded-card border bg-white p-6 shadow-sm ${className || "border-line"}`}>
      <div className={`flex items-center justify-between ${collapsed ? "" : "mb-4"}`}>
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
          <span className="text-ink-3 group-hover:text-ink-2 text-base leading-none shrink-0 w-4">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="min-w-0">
            <span className={`block ${titleClass || "text-xl font-bold text-ink"}`}>{title}</span>
            {subtitle && <span className="block text-xs text-ink-3">{subtitle}</span>}
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
      {!collapsed && children}
    </section>
  );
}
