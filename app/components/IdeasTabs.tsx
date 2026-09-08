"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Ideas hub: Shift + ← / → still cycles every Ideas page, and the four
 * screening pages (Screener / Radar / Setups / Factor Lab) show a MODE switch
 * — they are one "Screen" entry in the rail. Synthesis and Pipeline
 * (Funnel → Conviction) are rail items with no segment row.
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Funnel", href: "/funnel" },
  { label: "Synthesis", href: "/synthesis" },
  { label: "Pipeline", href: "/conviction" },
  { label: "Screener", href: "/screener" },
  { label: "Radar", href: "/radar" },
  { label: "Setups", href: "/setups" },
  { label: "Factor Lab", href: "/factor-lab" },
];

export const SCREEN_MODES: { label: string; href: string }[] = [
  { label: "Technical", href: "/screener" },
  { label: "Radar", href: "/radar" },
  { label: "Setups", href: "/setups" },
  { label: "Factor", href: "/factor-lab" },
];

export function IdeasTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const isVisible = SEGMENTS.some((s) => s.href === pathname);
  const isScreen = SCREEN_MODES.some((s) => s.href === pathname);

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

  if (!isScreen) return null;

  return (
    <div className="px-4 pt-4 md:px-5 print:hidden">
      <div className="seg">
        {SCREEN_MODES.map((m) => (
          <Link key={m.href} href={m.href} aria-current={pathname === m.href ? "page" : undefined} className={pathname === m.href ? "on" : ""}>
            {m.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
