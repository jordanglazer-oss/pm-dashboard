"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Segmented switcher for the consolidated "Portfolio" hub. The redesign merges
 * the old Dashboard + Positioning + PIM Model tabs into one Portfolio tab; this
 * bar navigates between the segments. Routes are UNCHANGED (deep-linking
 * preserved) — each segment just links to the page that already renders that
 * content. Self-hides on any non-hub route so it only appears within the hub.
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

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1 shrink-0">Portfolio</span>
        <div className="flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0">
          {SEGMENTS.map((seg) => {
            const isActive = seg.href === activeHref;
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
  );
}
