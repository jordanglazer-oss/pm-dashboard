"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Segmented switcher for the "Ideas" hub — one home for every surface that
 * feeds the watchlist. Synthesis / Pipeline / Screener / Factor Lab keep
 * their existing routes; Radar and Setups (previously embedded as buckets
 * inside the Rankings table) get proper routes of their own. Mirrors the
 * PortfolioTabs pattern, including the sliding pill and Shift+←/→.
 */
const SEGMENTS: { label: string; href: string }[] = [
  { label: "Synthesis", href: "/synthesis" },
  { label: "Pipeline", href: "/conviction" },
  { label: "Screener", href: "/screener" },
  { label: "Radar", href: "/radar" },
  { label: "Setups", href: "/setups" },
  { label: "Factor Lab", href: "/factor-lab" },
];

export function IdeasTabs() {
  const pathname = usePathname();
  const router = useRouter();
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

  // Shift + ← / → jumps between Ideas segments, same as the Portfolio hub.
  useEffect(() => {
    if (!isVisible) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      const idx = Math.max(0, SEGMENTS.findIndex((s) => s.href === pathname));
      const next = e.key === "ArrowRight"
        ? (idx + 1) % SEGMENTS.length
        : (idx - 1 + SEGMENTS.length) % SEGMENTS.length;
      e.preventDefault();
      router.push(SEGMENTS[next].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVisible, pathname, router]);

  if (!isVisible) return null;

  return (
    <div className="bg-surface border-b border-line print:hidden">
      <div className="mx-auto max-w-7xl px-4 md:px-8 pt-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1">Ideas</span>
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
