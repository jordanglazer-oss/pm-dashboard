"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * Lightweight in-app navigation history (sessionStorage, per tab) powering
 * the universal back links: the stock page's "← back to where I came from"
 * and the reverse "← TICKER" chip on pages reached FROM a stock page.
 * history.back() does the actual navigation so scroll positions restore;
 * this store only supplies the LABEL and whether a back target exists.
 */

const KEY = "pm:nav-history";
const MAX = 25;

function read(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Friendly name for a path — mirrors the hub/segment labels. */
export function pageLabel(path: string): string {
  if (path.startsWith("/stock/")) {
    const t = decodeURIComponent(path.slice("/stock/".length)).split("?")[0];
    return t.toUpperCase();
  }
  const base = path.split("?")[0];
  const MAP: Record<string, string> = {
    "/": "Holdings",
    "/scoring": "Holdings",
    "/portfolio": "Positioning",
    "/pim-model": "Models",
    "/aa-performance": "Performance",
    "/attribution": "Performance",
    "/risk": "Risk",
    "/thesis": "Thesis",
    "/journal": "Journal",
    "/brief": "Brief",
    "/hedging": "Hedging",
    "/synthesis": "Synthesis",
    "/conviction": "Pipeline",
    "/screener": "Screener",
    "/radar": "Radar",
    "/setups": "Setups",
    "/factor-lab": "Factor Lab",
    "/research": "Research",
    "/inbox": "Inbox",
    "/chat": "Ask",
    "/appendix": "Appendix",
    "/client-report": "Client Report",
    "/methodology": "Methodology",
    "/admin/health": "Health",
  };
  return MAP[base] ?? base.replace("/", "").replace(/-/g, " ") ?? "Back";
}

/** Most recent tracked path that differs from `current` (order-independent
 *  of whether the tracker has recorded `current` yet). */
export function getPrevPath(current: string): string | null {
  const arr = read();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== current) return arr[i];
  }
  return null;
}

const EVENT = "pm:nav-history-change";

/** Mount once in the dashboard layout — records every route change. */
export function NavHistoryTracker() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const arr = read();
      if (arr[arr.length - 1] !== pathname) {
        arr.push(pathname);
        sessionStorage.setItem(KEY, JSON.stringify(arr.slice(-MAX)));
      }
      window.dispatchEvent(new Event(EVENT));
    } catch { /* private mode — back links just hide */ }
  }, [pathname]);
  return null;
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** SSR-safe read of the previous page (null on the server / first paint). */
export function usePrevPage(): { path: string; label: string } | null {
  const pathname = usePathname();
  const prevPath = useSyncExternalStore(
    subscribe,
    () => getPrevPath(pathname),
    () => null,
  );
  return prevPath ? { path: prevPath, label: pageLabel(prevPath) } : null;
}

/**
 * The reverse direction: a floating "← TICKER" chip on any page reached
 * from a stock page. Hidden on stock pages themselves (they carry their own
 * back control in the ticker rail).
 */
export function BackCrumb() {
  const pathname = usePathname();
  const prev = usePrevPage();
  if (pathname.startsWith("/stock/") || !prev || !prev.path.startsWith("/stock/")) return null;
  return (
    <button
      onClick={() => window.history.back()}
      className="fixed bottom-[76px] left-4 z-40 flex items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-2 shadow-card hover:bg-surface-hover hover:text-ink transition-colors md:bottom-4 print:hidden"
      title={`Return to the ${prev.label} stock page (restores your place)`}
    >
      ← {prev.label}
    </button>
  );
}
