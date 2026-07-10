"use client";

import Link from "next/link";
import { useEffect } from "react";
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

  const isHub =
    pathname === "/" ||
    pathname === "/scoring" ||
    pathname.startsWith("/stock/") ||
    pathname.startsWith("/portfolio") ||
    pathname === "/pim-model" ||
    pathname === "/aa-performance";

  // Which segment "owns" the current route (X-ray shares /portfolio with
  // Positioning; it's an in-page anchor, so Positioning is the active one there).
  const activeHref =
    pathname === "/pim-model" ? "/pim-model"
    : pathname === "/aa-performance" ? "/aa-performance"
    : pathname.startsWith("/portfolio") ? "/portfolio"
    : "/"; // "/", "/scoring", "/stock/*"

  // Global Shift + ← / → jumps between Portfolio segments — no focus dance, and
  // Shift keeps it clear of the PLAIN ← / → profile toggles on Positioning /
  // Models (those handlers now ignore Shift). No-ops off the hub or while typing.
  useEffect(() => {
    if (!isHub) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      const idx = Math.max(0, SEGMENTS.findIndex((s) => s.href === activeHref));
      const next = e.key === "ArrowRight"
        ? (idx + 1) % SEGMENTS.length
        : (idx - 1 + SEGMENTS.length) % SEGMENTS.length;
      e.preventDefault();
      router.push(SEGMENTS[next].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isHub, activeHref, router]);

  if (!isHub) return null;

  const holdingsCount = (stocks ?? []).filter((s) => s.bucket === "Portfolio").length;

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

        {/* Segment row. Click to switch, or press Shift + ← / → anywhere on the
            page to move between segments. */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-2">
          <div
            className="flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0"
            title="Tip: Shift + ← / → switches between Portfolio sections"
          >
            {SEGMENTS.map((seg) => {
              const isActive = seg.href === activeHref;
              return (
                <Link
                  key={seg.label}
                  href={seg.href}
                  aria-current={isActive ? "page" : undefined}
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
