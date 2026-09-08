"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Portfolio hub keyboard navigation. The visible segment row moved into the
 * workspace rail (every Portfolio page is listed there), so this component
 * only keeps the global Shift + ← / → shortcut that cycles the hub's pages.
 * Routes are unchanged.
 */
export const PORTFOLIO_SEGMENTS: { label: string; href: string }[] = [
  { label: "Holdings", href: "/" },
  { label: "Positioning", href: "/portfolio" },
  { label: "Models", href: "/pim-model" },
  { label: "Performance", href: "/aa-performance" },
  { label: "Risk", href: "/risk" },
  { label: "Thesis", href: "/thesis" },
  { label: "Journal", href: "/journal" },
];

export function PortfolioTabs() {
  const pathname = usePathname();
  const router = useRouter();

  const isHub =
    pathname === "/" ||
    pathname === "/scoring" ||
    pathname.startsWith("/stock/") ||
    pathname.startsWith("/portfolio") ||
    pathname === "/pim-model" ||
    pathname === "/aa-performance" ||
    pathname === "/attribution" ||
    pathname === "/risk" ||
    pathname === "/thesis" ||
    pathname === "/journal";

  const activeHref =
    pathname === "/pim-model" ? "/pim-model"
    : pathname === "/aa-performance" ? "/aa-performance"
    : pathname === "/attribution" ? "/aa-performance"
    : pathname === "/risk" ? "/risk"
    : pathname === "/thesis" ? "/thesis"
    : pathname === "/journal" ? "/journal"
    : pathname.startsWith("/portfolio") ? "/portfolio"
    : "/";

  useEffect(() => {
    if (!isHub) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      const idx = Math.max(0, PORTFOLIO_SEGMENTS.findIndex((s) => s.href === activeHref));
      const next = e.key === "ArrowRight"
        ? (idx + 1) % PORTFOLIO_SEGMENTS.length
        : (idx - 1 + PORTFOLIO_SEGMENTS.length) % PORTFOLIO_SEGMENTS.length;
      e.preventDefault();
      router.push(PORTFOLIO_SEGMENTS[next].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isHub, activeHref, router]);

  return null;
}
