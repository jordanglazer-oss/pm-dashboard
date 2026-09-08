/**
 * Which top-level hub a route belongs to. ONE table, shared by the nav bar
 * (active-tab highlight, arrow-key hub cycling) and the back crumb (which
 * only appears when you have CROSSED hubs — a Portfolio→Positioning hop is
 * a sibling move the sub-tab bar already covers, but Brief→Performance
 * leaves the Brief with no way back except the nav).
 */

export type Hub = "Brief" | "Portfolio" | "Ideas" | "Research" | "More";

const ALIASES: Record<string, Hub> = {
  // Portfolio segments
  "/": "Portfolio",
  "/scoring": "Portfolio",
  "/portfolio": "Portfolio",
  "/pim-model": "Portfolio",
  "/aa-performance": "Portfolio",
  "/attribution": "Portfolio",
  "/risk": "Portfolio",
  "/thesis": "Portfolio",
  "/journal": "Portfolio",
  // Ideas segments
  "/synthesis": "Ideas",
  "/funnel": "Ideas",
  "/conviction": "Ideas",
  "/screener": "Ideas",
  "/radar": "Ideas",
  "/setups": "Ideas",
  "/factor-lab": "Ideas",
  // Research segments
  "/research": "Research",
  "/research/sources": "Research",
  "/inbox": "Research",
  // Brief segments
  "/brief": "Brief",
  "/hedging": "Brief",
  // More
  "/chat": "More",
  "/appendix": "More",
  "/client-report": "More",
  "/methodology": "More",
  "/admin/health": "More",
};

/** Sub-tab aliases the nav highlights (everything except the hub roots). */
export const TAB_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(ALIASES).filter(([p]) => !["/", "/brief", "/synthesis", "/research"].includes(p))
);

export function hubOf(path: string): Hub {
  const base = path.split("?")[0];
  if (base.startsWith("/stock/")) return "Portfolio";
  return ALIASES[base] ?? "More";
}
