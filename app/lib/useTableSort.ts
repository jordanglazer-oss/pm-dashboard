"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Click-to-sort for the Suggested Watchlist and Setups tables.
 *
 * Shared rather than written twice: the two tables want identical behaviour,
 * and a second copy is how "sorting works differently on one tab" starts.
 *
 * Sorting is by an EXTRACTED VALUE, not by the rendered string. A score of 9
 * must not sort below 10 because "9" > "1" as text, and a null must sink to
 * the bottom whichever direction is active rather than pretending to be zero —
 * "no reading" is not "the lowest reading".
 */

export type SortDir = "asc" | "desc";
export type SortValue = string | number | null | undefined;

export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => SortValue>,
  initialKey: string,
  initialDir: SortDir = "desc",
) {
  const [key, setKey] = useState(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const toggle = useCallback(
    (k: string) => {
      if (k === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
      else {
        setKey(k);
        // Text reads naturally A-Z; numbers are almost always wanted biggest
        // first, so the default direction follows the column's type.
        setDir(typeof accessors[k]?.(rows[0]) === "string" ? "asc" : "desc");
      }
    },
    [key, accessors, rows],
  );

  const sorted = useMemo(() => {
    const get = accessors[key];
    if (!get) return rows;
    const mult = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      // Missing values always sink, regardless of direction.
      const aMissing = va == null || va === "";
      const bMissing = vb == null || vb === "";
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
      return String(va).localeCompare(String(vb)) * mult;
    });
  }, [rows, accessors, key, dir]);

  /** Header arrow — only on the active column, so the table says what it did. */
  const arrow = useCallback((k: string) => (k === key ? (dir === "asc" ? " ▲" : " ▼") : ""), [key, dir]);

  return { sorted, key, dir, toggle, arrow };
}

/**
 * CAD or USD from the ticker alone.
 *
 * The same suffix rule the model parsers use (.TO / -T / .U). Candidates come
 * from research lists that do not all publish a currency field, so the symbol
 * is the only thing reliably present — and it is what the rest of the app
 * already keys on.
 */
export function currencyOf(ticker: string): "CAD" | "USD" {
  const t = ticker.toUpperCase();
  if (t.endsWith(".U")) return "USD";
  return t.endsWith(".TO") || t.endsWith("-T") ? "CAD" : "USD";
}
