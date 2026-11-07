"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Ideas hub: Shift + ← / → cycles every Ideas page. Renders nothing — the
 * Setups mode (and with it the Screener's mode switch) was removed Nov 2026.
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Funnel", href: "/funnel" },
  { label: "Synthesis", href: "/synthesis" },
  { label: "Pipeline", href: "/conviction" },
  { label: "Screener", href: "/screener" },
];

export function IdeasTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const isVisible = SEGMENTS.some((s) => s.href === pathname);

  useEffect(() => {
    if (!isVisible) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      const idx = Math.max(0, SEGMENTS.findIndex((s) => s.href === pathname));
      const next = e.key === "ArrowRight" ? (idx + 1) % SEGMENTS.length : (idx - 1 + SEGMENTS.length) % SEGMENTS.length;
      e.preventDefault();
      router.push(SEGMENTS[next].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVisible, pathname, router]);

  return null;
}
