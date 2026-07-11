"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Sub-navigation for the Research area. Inbox was consolidated from a top-level
 * nav tab into a sub-tab of Research (analyst-report ingestion feeds the same
 * research workflow). This bar shows on /research and /inbox and lets the PM
 * switch between the source lists and the Inbox. Self-hides everywhere else.
 * Mirrors the PortfolioTabs pattern, including the sliding active-tab pill (#15).
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Sources", href: "/research" },
  { label: "Inbox", href: "/inbox" },
];

export function ResearchTabs() {
  const pathname = usePathname();
  const isVisible = pathname === "/research" || pathname === "/inbox";
  const activeIdx = Math.max(0, SEGMENTS.findIndex((s) => s.href === pathname));

  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);
  useIsoLayoutEffect(() => {
    const el = tabRefs.current[activeIdx];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeIdx, isVisible]);
  useEffect(() => {
    if (!isVisible) return;
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 pt-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1">Research</span>
          <div className="relative flex items-center gap-0.5 rounded-control border border-line bg-surface-2 p-0.5 shrink-0">
            {pill && (
              <span
                aria-hidden
                className={`absolute top-0.5 bottom-0.5 rounded-[6px] bg-surface shadow-sm ${ready ? "transition-all duration-300 ease-out" : ""}`}
                style={{ left: pill.left, width: pill.width }}
              />
            )}
            {SEGMENTS.map((seg, i) => {
              const isActive = seg.href === pathname;
              return (
                <Link
                  key={seg.label}
                  href={seg.href}
                  ref={(el) => { tabRefs.current[i] = el; }}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative z-10 rounded-[6px] px-3 py-1 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-border ${
                    isActive ? "text-ink font-semibold" : "text-ink-2 hover:text-ink"
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
