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

export type NavGroup = {
  label: string;
  items: NavItem[];
  /** Hub accent, one hue per group — see the --color-hub-* tokens. Used for
   *  wayfinding only (rail active state, group label mark, the crumb). */
  hue: "today" | "portfolio" | "ideas" | "research";
};

/**
 * Nov 24 2026 hackathon scaffold: the rail is regrouped into the two sections
 * the team asked for — "Portfolio & Research" (views you drill into) and
 * "Tools" (click to generate). NOTHING was removed: every page that is not
 * yet placed by the team sits in the third group until they decide. The team
 * finalises the tab list in session; this is the starting point.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Portfolio & Research",
    hue: "portfolio",
    items: [
      { key: "snapshot", label: "Portfolio Snapshot", href: "/", icon: "pie" },
      { key: "brief", label: "Brief", href: "/brief", icon: "sun" },
      { key: "holdings", label: "Holdings", href: "/holdings", icon: "table", match: (p) => p === "/scoring" || p.startsWith("/stock/") },
      { key: "models", label: "Models", href: "/pim-model", icon: "layers" },
      { key: "performance", label: "Performance", href: "/aa-performance", icon: "trend", match: (p) => p === "/attribution" },
      { key: "strategists", label: "Strategists", href: "/strategists", icon: "chat" },
      { key: "ranked", label: "Market research", href: "/research", icon: "list" },
      { key: "monitors", label: "Monitors", href: "/monitors", icon: "shield" },
      { key: "watchlist", label: "Ideas", href: "/watchlist", icon: "spark" },
    ],
  },
  {
    label: "Tools",
    hue: "research",
    items: [
      { key: "pm-monthly", label: "PM Monthly", href: "/pm-monthly", icon: "mail" },
      { key: "client-report", label: "Client report", href: "/client-report", icon: "doc" },
      { key: "funds", label: "Fund one-pagers", href: "/funds", icon: "doc" },
      { key: "chat", label: "Ask", href: "/chat", icon: "chat" },
      { key: "inbox", label: "Inbox", href: "/inbox", icon: "inbox" },
    ],
  },
  {
    // Existing pages the team has not placed yet. Unchanged; nothing removed.
    label: "Not yet sorted",
    hue: "ideas",
    items: [
      { key: "positioning", label: "Positioning", href: "/portfolio", icon: "pie", match: (p) => p.startsWith("/portfolio") },
      { key: "review", label: "Review", href: "/review", icon: "calendar" },
      { key: "risk", label: "Risk", href: "/risk", icon: "shield" },
      { key: "thesis", label: "Thesis", href: "/thesis", icon: "filecheck" },
      { key: "themes", label: "Themes", href: "/themes", icon: "star" },
      { key: "journal", label: "Journal", href: "/journal", icon: "book" },
      { key: "synthesis", label: "Synthesis", href: "/synthesis", icon: "spark" },
      { key: "pipeline", label: "Pipeline", href: "/funnel", icon: "branch", match: (p) => p === "/conviction" },
      { key: "sources", label: "Research sources", href: "/research/sources", icon: "inbox" },
      { key: "hedging", label: "Hedging", href: "/hedging", icon: "umbrella" },
      { key: "monitor", label: "Watchers", href: "/monitor", icon: "eye" },
      { key: "redesign", label: "Redesign options", href: "/redesign", icon: "spark", match: (p) => p.startsWith("/redesign") },
    ],
  },
];

/** Rail footer utilities. Empty since the Nov 2026 regroup (Ask and Client
 *  report moved into Tools); kept so the footer code path is unchanged. */
export const NAV_UTILITIES: NavItem[] = [];

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

/** The hub hue for a route, for the crumb and any page-level accent. */
export function navHue(path: string): NavGroup["hue"] | null {
  const key = activeNavKey(path.split("?")[0]);
  return NAV_GROUPS.find((g) => g.items.some((i) => i.key === key))?.hue ?? null;
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
