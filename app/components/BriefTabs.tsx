"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Sub-navigation for the Brief area. Hedging moved from a top-level tab to a
 * sub-tab of the Brief — the Brief already issues the daily hedging call and
 * reads the same pm:hedges ledger, so they belong together. Routes unchanged.
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Today", href: "/brief" },
  { label: "Hedging", href: "/hedging" },
];

export function BriefTabs() {
  const pathname = usePathname();
  const isVisible = SEGMENTS.some((s) => s.href === pathname);
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
      <div className="mx-auto max-w-[1560px] px-4 md:px-8 pt-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1">Brief</span>
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
