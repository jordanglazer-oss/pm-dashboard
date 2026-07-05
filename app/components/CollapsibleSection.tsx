"use client";

import React from "react";
import { useCollapsed } from "@/app/lib/useCollapsed";

/**
 * A card section whose body collapses/expands, with the state PERSISTED via
 * pm:ui-prefs (useCollapsed) so it survives tab navigation + refresh. The
 * header (title + optional right-side controls) stays visible when collapsed,
 * so the user can see what to re-open. Default = expanded.
 */
export function CollapsibleSection({
  prefKey,
  className,
  title,
  subtitle,
  titleClass,
  right,
  children,
}: {
  prefKey: string;
  /** Border/background classes for the outer <section> (e.g. "border-amber-200"). */
  className?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Classes for the <h3> (e.g. "text-xl font-bold text-amber-800"). */
  titleClass?: string;
  /** Right-aligned header content (counts, refresh buttons, etc.). */
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, toggle] = useCollapsed(prefKey);
  return (
    <section className={`rounded-[24px] border bg-white p-6 shadow-sm ${className || "border-slate-200"}`}>
      <div className={`flex items-center justify-between ${collapsed ? "" : "mb-4"}`}>
        <button
          onClick={toggle}
          className="flex items-center gap-2 min-w-0 text-left group"
          aria-label={collapsed ? "Expand section" : "Collapse section"}
        >
          <span className="text-slate-400 group-hover:text-slate-700 text-base leading-none shrink-0 w-4">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="min-w-0">
            <span className={`block ${titleClass || "text-xl font-bold text-slate-800"}`}>{title}</span>
            {subtitle && <span className="block text-xs text-slate-400">{subtitle}</span>}
          </span>
        </button>
        {right && <div className="flex items-center gap-3 shrink-0">{right}</div>}
      </div>
      {!collapsed && children}
    </section>
  );
}
