"use client";

import { usePathname } from "next/navigation";

/**
 * Fades + rises the page content in when you move between top-level sections.
 * Keyed by the FIRST path segment (not the full pathname) on purpose: switching
 * sections (Rankings → Positioning → Research …) re-mounts the wrapper and plays
 * the animation, but moving within a section — e.g. stock A → stock B — keeps
 * the same key, so the page updates in place without a remount/loading flash.
 * Only wraps the page content (not the nav/tabs). Respects prefers-reduced-motion.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = pathname.split("/")[1] || "home";
  return (
    <div key={section} className="animate-page-in">
      {children}
    </div>
  );
}
