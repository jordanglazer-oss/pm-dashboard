"use client";

import { useStocks } from "./StockContext";

/**
 * Persisted collapse/expand state for any collapsible section. Backed by
 * pm:ui-prefs (via uiPrefs/setUiPref), so the choice survives tab navigation
 * AND page refresh AND syncs across devices — unlike a local useState, which
 * resets every time the component unmounts.
 *
 * Usage: const [collapsed, toggle] = useCollapsed("changeMonitor.collapsed");
 * Default is EXPANDED (collapsed = false) until the user collapses it.
 */
export function useCollapsed(key: string): [boolean, () => void] {
  const { uiPrefs, setUiPref } = useStocks();
  const collapsed = uiPrefs[key] === "1";
  const toggle = () => setUiPref(key, collapsed ? "0" : "1");
  return [collapsed, toggle];
}
