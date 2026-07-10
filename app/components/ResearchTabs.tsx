"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sub-navigation for the Research area. Inbox was consolidated from a top-level
 * nav tab into a sub-tab of Research (analyst-report ingestion feeds the same
 * research workflow). This bar shows on /research and /inbox and lets the PM
 * switch between the source lists and the Inbox. Self-hides everywhere else.
 * Mirrors the PortfolioTabs pattern.
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Sources", href: "/research" },
  { label: "Inbox", href: "/inbox" },
];

export function ResearchTabs() {
  const pathname = usePathname();
  if (pathname !== "/research" && pathname !== "/inbox") return null;

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 pt-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1">Research</span>
          <div className="flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0">
            {SEGMENTS.map((seg) => {
              const isActive = seg.href === pathname;
              return (
                <Link
                  key={seg.label}
                  href={seg.href}
                  className={`rounded-[6px] px-3 py-1 text-[13px] whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-surface text-ink font-semibold shadow-sm"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {seg.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
