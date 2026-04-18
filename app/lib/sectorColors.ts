// Shared GICS sector color palette. Keep the hex values and the Tailwind
// class names in sync so the dashboard (Tailwind) and the printable client
// report (inline styles / hex) display the same sector in the same color.
//
// Palette rationale:
//   - Financials → blue (matches most industry conventions)
//   - Technology → indigo/purple (tech-accent tradition)
//   - Energy → red-orange (crude/fire association)
//   - Materials → cyan (matches iShares / SPDR material ETF palettes)
//   - Consumer Discretionary → orange, Consumer Staples → amber
//   - Health Care → purple (pharma ribbon tradition)
//   - Industrials → slate, Utilities → lime, Real Estate → pink
//
// When a sector name doesn't match (e.g. a provider returns an unexpected
// string), colorForSector() falls back to slate-400 so the chart still
// renders but the mismatch is visible.

import { normalizeSector } from "./scoring";

export const SECTOR_COLORS_HEX: Record<string, string> = {
  Technology: "#4f46e5",              // indigo-600
  Financials: "#2563eb",              // blue-600
  "Health Care": "#9333ea",           // purple-600
  Industrials: "#64748b",             // slate-500
  "Consumer Discretionary": "#f97316",// orange-500
  "Consumer Staples": "#f59e0b",      // amber-500
  "Communication Services": "#0ea5e9",// sky-500
  Energy: "#ef4444",                  // red-500
  Utilities: "#84cc16",               // lime-500
  Materials: "#06b6d4",               // cyan-500
  "Real Estate": "#ec4899",           // pink-500
};

export const SECTOR_COLORS_TW: Record<string, string> = {
  Technology: "bg-indigo-600",
  Financials: "bg-blue-600",
  "Health Care": "bg-purple-600",
  Industrials: "bg-slate-500",
  "Consumer Discretionary": "bg-orange-500",
  "Consumer Staples": "bg-amber-500",
  "Communication Services": "bg-sky-500",
  Energy: "bg-red-500",
  Utilities: "bg-lime-500",
  Materials: "bg-cyan-500",
  "Real Estate": "bg-pink-500",
};

const FALLBACK_HEX = "#94a3b8"; // slate-400
const FALLBACK_TW = "bg-slate-400";

/** Hex color for a sector (normalizes provider variants via normalizeSector). */
export function colorForSector(sector: string): string {
  const key = normalizeSector(sector);
  return SECTOR_COLORS_HEX[key] ?? FALLBACK_HEX;
}

/** Tailwind bg class for a sector (normalizes provider variants). */
export function twColorForSector(sector: string): string {
  const key = normalizeSector(sector);
  return SECTOR_COLORS_TW[key] ?? FALLBACK_TW;
}
