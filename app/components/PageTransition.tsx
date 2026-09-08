"use client";

import { usePathname } from "next/navigation";
import { navHue } from "@/app/lib/nav-model";

/**
 * Fades + rises the page content in when you move between top-level sections.
 * Keyed by the FIRST path segment (not the full pathname) on purpose: switching
 * sections (Rankings → Positioning → Research …) re-mounts the wrapper and plays
 * the animation, but moving within a section — e.g. stock A → stock B — keeps
 * the same key, so the page updates in place without a remount/loading flash.
 * Only wraps the page content (not the nav/tabs). Respects prefers-reduced-motion.
 *
 * It also carries the HUB HUE for the whole content column, so every panel on
 * the page inherits its section's colour (tinted header, coloured title and
 * table-header rule) without each one declaring it. A panel that carries its
 * own `.t-mark` colour overrides this — see the `.hue-*` block in globals.css.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = pathname.split("/")[1] || "home";
  const hue = navHue(pathname);
  return (
    <div key={section} className={`animate-page-in ${hue ? `hue-${hue}` : ""}`}>
      {children}
    </div>
  );
}
