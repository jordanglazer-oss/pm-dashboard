"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";

/**
 * Segmented switcher for the consolidated "Portfolio" hub. The redesign merges
 * the old Dashboard + Positioning + PIM Model tabs into one Portfolio tab; this
 * bar navigates between the segments. Routes are UNCHANGED (deep-linking
 * preserved) — each segment just links to the page that already renders that
 * content. Self-hides on any non-hub route so it only appears within the hub.
 *
 * No header-level Model/Version selector: every segment that needs one already
 * has its own page-level control (Positioning + Models each own a working
 * profile toggle; Rankings/Allocation read the profile from the URL with an
 * All-Equity default and don't need to switch it). A second selector up here
 * was redundant and could drift out of sync, so it was removed.
 */

// X-ray was removed as a distinct segment — Portfolio X-ray already lives on the
// Positioning page, so a separate segment was redundant. Positioning owns it.
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Rankings", href: "/" },
  { label: "Positioning", href: "/portfolio" },
  { label: "Models", href: "/pim-model" },
  { label: "Allocation", href: "/aa-performance" },
];

export function PortfolioTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const { stocks } = useStocks();
  // Roving-tabindex refs so ← / → move focus + navigate between segments when
  // the tab bar is focused (standard ARIA tablist keyboard pattern). Scoped to
  // the tab bar via role="tablist" so it doesn't clash with the ← / → profile
  // toggles on Positioning / Models (those handlers skip when a tablist is
  // focused — see PimPortfolio / PimModel).
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const isHub =
    pathname === "/" ||
    pathname === "/scoring" ||
    pathname.startsWith("/stock/") ||
    pathname.startsWith("/portfolio") ||
    pathname === "/pim-model" ||
    pathname === "/aa-performance";
  if (!isHub) return null;

  // Which segment "owns" the current route (X-ray shares /portfolio with
  // Positioning; it's an in-page anchor, so Positioning is the active one there).
  const activeHref =
    pathname === "/pim-model" ? "/pim-model"
    : pathname === "/aa-performance" ? "/aa-performance"
    : pathname.startsWith("/portfolio") ? "/portfolio"
    : "/"; // "/", "/scoring", "/stock/*"

  const holdingsCount = (stocks ?? []).filter((s) => s.bucket === "Portfolio").length;

  const activeIdx = Math.max(0, SEGMENTS.findIndex((s) => s.href === activeHref));
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (activeIdx + 1) % SEGMENTS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (activeIdx - 1 + SEGMENTS.length) % SEGMENTS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SEGMENTS.length - 1;
    else return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
    router.push(SEGMENTS[next].href);
  };

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 pt-3">
        {/* Title row: page title + holdings count. The Model/Version selectors
            were removed — each segment owns its own control (see file header). */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink leading-none">Portfolio</h1>
            <p className="mt-1 text-xs text-ink-3">{holdingsCount} holdings</p>
          </div>
        </div>

        {/* Segment row — an ARIA tablist so ← / → (and Home / End) move between
            segments once the bar is focused (Tab into it, then arrow). */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-2">
          <div
            role="tablist"
            aria-label="Portfolio sections"
            onKeyDown={onTabKeyDown}
            className="flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0"
          >
            {SEGMENTS.map((seg, i) => {
              const isActive = seg.href === activeHref;
              return (
                <Link
                  key={seg.label}
                  href={seg.href}
                  ref={(el) => { tabRefs.current[i] = el; }}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={`rounded-[6px] px-3 py-1 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-border ${
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
