"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Today hub keyboard navigation (Shift + ← / → between Brief and Hedging).
 *  The visible segment row lives in the workspace rail now. */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Today", href: "/brief" },
  { label: "Hedging", href: "/hedging" },
];

export function BriefTabs() {
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
