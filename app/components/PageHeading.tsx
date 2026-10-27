"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { navCrumb } from "@/app/lib/nav-model";

/**
 * Private Office page heading — the same eyebrow / title / one-line lede the
 * Holdings and Brief pages carry, so every page opens the same way. Display
 * only. Title + section default to the rail's names for the route.
 */
export function PageHeading({
  title,
  lede,
  actions,
}: {
  title?: string;
  lede?: React.ReactNode;
  /** Optional controls on the right of the title row. */
  actions?: React.ReactNode;
}) {
  const crumb = navCrumb(usePathname() ?? "/");
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return (
    <header className="flex flex-col gap-1.5 px-1 pb-1 pt-2">
      <div className="page-eyebrow">
        {today} · {crumb.group}
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <h1 className="page-title">{title ?? crumb.title}</h1>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {lede && <p className="page-lede">{lede}</p>}
    </header>
  );
}
