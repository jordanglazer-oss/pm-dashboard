// Shared GICS sector palette — a MUTED qualitative scale tuned for the
// Precision Light system: 11 distinguishable hues at similar lightness /
// saturation so a sector breakdown reads as one calm family rather than a
// bag of primary colors. Applied via inline `style={{ background: ... }}`
// (hex) so it stays independent of the Tailwind token palette and renders
// identically on the dashboard and in the printable client report.
//
// When a sector name doesn't match (an upstream returns an unexpected
// string), colorForSector() falls back to a neutral slate so the chart still
// renders but the mismatch stays visible.

import { normalizeSector } from "./scoring";

export const SECTOR_COLORS_HEX: Record<string, string> = {
  Technology: "#6b73c4",               // muted indigo
  Financials: "#5a8fd0",               // muted blue
  "Health Care": "#a578c4",            // muted purple
  Industrials: "#7d8896",              // muted slate
  "Consumer Discretionary": "#dd9256", // muted orange
  "Consumer Staples": "#cfa94b",       // muted gold
  "Communication Services": "#5aa8cf", // muted sky
  Energy: "#d06c6c",                   // muted red
  Utilities: "#86b060",                // muted olive-green
  Materials: "#55aaaa",                // muted teal
  "Real Estate": "#cf82a8",            // muted pink
};

const FALLBACK_HEX = "#9aa3b0"; // neutral ink-3

/** Hex color for a sector (normalizes provider variants via normalizeSector). */
export function colorForSector(sector: string): string {
  const key = normalizeSector(sector);
  return SECTOR_COLORS_HEX[key] ?? FALLBACK_HEX;
}
