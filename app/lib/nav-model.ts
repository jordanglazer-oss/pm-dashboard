/**
 * The workspace rail: every destination, grouped, in one table. Routes are
 * unchanged from the streamline nav — only the presentation moved from four
 * top tabs + per-hub segment rows to one always-visible rail. Ideas'
 * Funnel/Conviction are reached through "Pipeline" (/funnel, which links on
 * to /conviction) and Screener/Radar/Setups/Factor Lab through "Screen"
 * (/screener, with a mode switch rendered by IdeasTabs).
 */

export type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: string;
  /** Route predicates that highlight this item beyond its own href. */
  match?: (path: string) => boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Today",
    items: [
      { key: "brief", label: "Brief", href: "/brief", icon: "sun" },
      { key: "hedging", label: "Hedging", href: "/hedging", icon: "umbrella" },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { key: "holdings", label: "Holdings", href: "/", icon: "table", match: (p) => p === "/scoring" || p.startsWith("/stock/") },
      { key: "positioning", label: "Positioning", href: "/portfolio", icon: "pie", match: (p) => p.startsWith("/portfolio") },
      { key: "models", label: "Models", href: "/pim-model", icon: "layers" },
      { key: "performance", label: "Performance", href: "/aa-performance", icon: "trend", match: (p) => p === "/attribution" },
      { key: "risk", label: "Risk", href: "/risk", icon: "shield" },
      { key: "thesis", label: "Thesis", href: "/thesis", icon: "filecheck" },
      { key: "journal", label: "Journal", href: "/journal", icon: "book" },
    ],
  },
  {
    label: "Ideas",
    items: [
      { key: "synthesis", label: "Synthesis", href: "/synthesis", icon: "spark" },
      { key: "pipeline", label: "Pipeline", href: "/funnel", icon: "branch", match: (p) => p === "/conviction" },
      { key: "screen", label: "Screen", href: "/screener", icon: "filter", match: (p) => p === "/radar" || p === "/setups" || p === "/factor-lab" || p.startsWith("/screener/") },
    ],
  },
  {
    label: "Research",
    items: [
      { key: "ranked", label: "Ranked", href: "/research", icon: "list" },
      { key: "sources", label: "Sources", href: "/research/sources", icon: "inbox" },
      { key: "inbox", label: "Inbox", href: "/inbox", icon: "mail" },
    ],
  },
];

/** Rail footer: utilities that are not a hub page. */
export const NAV_UTILITIES: NavItem[] = [
  { key: "chat", label: "Ask", href: "/chat", icon: "chat" },
  { key: "client-report", label: "Client report", href: "/client-report", icon: "doc" },
];

/** Under the System popover, with the health rows. */
export const SYSTEM_LINKS: { label: string; href: string }[] = [
  { label: "Health", href: "/admin/health" },
  { label: "Methodology", href: "/methodology" },
  { label: "Appendix", href: "/appendix" },
];

const ALL_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_UTILITIES];

export function activeNavKey(path: string): string | null {
  const base = path.split("?")[0];
  for (const it of ALL_ITEMS) {
    if (it.href === base) return it.key;
  }
  for (const it of ALL_ITEMS) {
    if (it.match && it.match(base)) return it.key;
  }
  return null;
}

/** "Portfolio" / "Holdings" for the top bar crumb + title. */
export function navCrumb(path: string): { group: string; title: string } {
  const base = path.split("?")[0];
  const key = activeNavKey(base);
  for (const g of NAV_GROUPS) {
    const it = g.items.find((i) => i.key === key);
    if (it) return { group: g.label, title: it.label };
  }
  const util = NAV_UTILITIES.find((i) => i.key === key);
  if (util) return { group: "Workspace", title: util.label };
  const sys = SYSTEM_LINKS.find((l) => l.href === base);
  if (sys) return { group: "System", title: sys.label };
  return { group: "Workspace", title: base.replace("/", "").replace(/-/g, " ") || "Home" };
}
