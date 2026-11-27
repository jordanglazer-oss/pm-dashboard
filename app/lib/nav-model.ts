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
  /** "Removed" pages only: the kept page this content is proposed to move into. */
  mergeInto?: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
  /** Hub accent, one hue per group — see the --color-hub-* tokens. Used for
   *  wayfinding only (rail active state, group label mark, the crumb). */
  hue: "today" | "portfolio" | "ideas" | "research";
};

/**
 * Nov 26 2026 team session: the rail the team agreed on. "Portfolio &
 * Research" and "Tools" are the pages being kept; "Other" holds working pages
 * the team has not placed (they are still needed to run the book); "Removed"
 * holds pages leaving the dashboard — STILL REACHABLE on the preview so the
 * team can pick what to roll into a kept page. `mergeInto` names the kept
 * page that content is proposed for. NOTHING is deleted and no stored data
 * changes when a page moves groups.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Portfolio & Research",
    hue: "portfolio",
    items: [
      { key: "snapshot", label: "Portfolio Snapshot", href: "/", icon: "pie" },
      { key: "brief", label: "Market Brief", href: "/brief", icon: "sun" },
      { key: "hedging", label: "Hedging", href: "/hedging", icon: "umbrella" },
      { key: "strategists", label: "Strategists", href: "/strategists", icon: "chat" },
      { key: "sentiment", label: "Sentiment", href: "/sentiment", icon: "shield" },
      { key: "performance", label: "Performance", href: "/aa-performance", icon: "trend", match: (p) => p === "/attribution" },
      { key: "holdings", label: "Holdings", href: "/holdings", icon: "table", match: (p) => p.startsWith("/stock/") },
      { key: "watchlist", label: "Ideas", href: "/watchlist", icon: "spark" },
    ],
  },
  {
    label: "Tools",
    hue: "research",
    items: [
      { key: "client-report", label: "Client Report", href: "/client-report", icon: "doc" },
      { key: "pm-monthly", label: "PM Monthly", href: "/pm-monthly", icon: "mail" },
      { key: "funds", label: "Fund One-Pagers", href: "/funds", icon: "doc" },
      { key: "chat", label: "Ask", href: "/chat", icon: "chat" },
      { key: "models", label: "Models", href: "/pim-model", icon: "layers" },
    ],
  },
  {
    // Working pages the team has not placed. Still needed to run the book; unchanged.
    label: "Other",
    hue: "ideas",
    items: [
      { key: "positioning", label: "Positioning", href: "/portfolio", icon: "pie", match: (p) => p.startsWith("/portfolio") },
      { key: "review", label: "Review", href: "/review", icon: "calendar" },
      { key: "sources", label: "Research sources", href: "/research/sources", icon: "inbox" },
      { key: "inbox", label: "Inbox", href: "/inbox", icon: "inbox" },
      { key: "monitor", label: "Watchers", href: "/monitor", icon: "eye" },
    ],
  },
  {
    // Leaving the dashboard. Reachable on the preview until the team signs off; data untouched.
    label: "Removed",
    hue: "today",
    items: [
      { key: "ranked", label: "Market Research", href: "/research", icon: "list", mergeInto: "Holdings, Ideas" },
      { key: "monitors", label: "Monitors", href: "/monitors", icon: "shield", mergeInto: "Sentiment, Strategists" },
      { key: "thesis", label: "Thesis", href: "/thesis", icon: "filecheck", mergeInto: "Holdings" },
      { key: "journal", label: "Journal", href: "/journal", icon: "book", mergeInto: "Holdings" },
      { key: "themes", label: "Themes", href: "/themes", icon: "star", mergeInto: "Holdings" },
      { key: "pipeline", label: "Pipeline", href: "/funnel", icon: "branch", match: (p) => p === "/conviction", mergeInto: "Ideas" },
      { key: "risk", label: "Risk", href: "/risk", icon: "shield", mergeInto: "Portfolio Snapshot" },
      { key: "scoring", label: "PIM Scoring", href: "/scoring", icon: "table" },
      { key: "synthesis", label: "Synthesis", href: "/synthesis", icon: "spark" },
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
