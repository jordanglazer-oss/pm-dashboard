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

/**
 * Persisted OPEN state — the mirror of `useCollapsed` for sections whose
 * natural default is a boolean you choose per call site (a tile that starts
 * open, a "show every row" expander that starts closed).
 *
 * Backed by the same pm:ui-prefs store, so the choice survives a refresh and
 * follows the PM across devices. Reading an unset key never writes, so the
 * default stays purely presentational until the user actually toggles.
 *
 * Usage: const [open, toggle] = usePersistedOpen("stock.factorLens.open", true);
 */
export function usePersistedOpen(key: string, defaultOpen = true): [boolean, () => void] {
  const { uiPrefs, setUiPref } = useStocks();
  const stored = uiPrefs[key];
  const open = stored === undefined ? defaultOpen : stored === "1";
  const toggle = () => setUiPref(key, open ? "0" : "1");
  return [open, toggle];
}
