"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Research hub keyboard navigation (Shift + ← / → across Ranked, Sources,
 *  Inbox). The visible segment row lives in the workspace rail now. */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Ranked", href: "/research" },
  { label: "Sources", href: "/research/sources" },
  { label: "Inbox", href: "/inbox" },
];

export function ResearchTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const isVisible = pathname === "/research" || pathname.startsWith("/research/") || pathname === "/inbox";

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
