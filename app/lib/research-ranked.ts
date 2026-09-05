/**
 * Ranked research — the FIRST stage of the idea funnel.
 *
 * Folds every ticker-bearing list on the Research tab into one table, one row
 * per company, ranked by the PURE COUNT of lists the name is on. Confluence is
 * the signal; nothing else is weighted in (the weighted "confluence score" in
 * watchlist-candidates.ts was judged to add little over a plain count).
 *
 * Rules (agreed 2026-09-05):
 *   - Only Research-tab lists count. SIA / Boosted / MarketEdge feeds do NOT —
 *     they live on the Dashboard "Movers" panel instead.
 *   - Bearish lists (Fundstrat Bottom / SMID Bottom, sell-rated Alpha Picks)
 *     never add to the count; they're surfaced as a red flag on the row.
 *   - Currency comes from the LIST: RBC Equate Canada, RBCCM FEW and RBC
 *     Canadian Focus are all-TSX lists; Seeking Alpha can carry either; every
 *     other list is USD. A dual-listed name defaults to the Canadian ticker.
 *   - Rows are keyed on the cross-listing root so "CLS" and "CLS.TO" are ONE
 *     row (this is a research view, not position identity).
 *
 * Pure: no Redis, no fetch, no React. Client and server both import it; the
 * server loader lives in research-ranked-server.ts.
 */

import type { ResearchState, AlphaPickEntry } from "./defaults";
import { canonicalTicker, crossListingRoot } from "./ticker";
import type { ResearchRemovalStore } from "./research-removals";

/** Names on at least this many lists are the Suggested Watchlist (stage 2). */
export const SUGGESTED_MIN_LISTS = 2;

export type RankedListKey =
  | "newtonUpticks"
  | "fundstratTop"
  | "fundstratBottom"
  | "fundstratSmidTop"
  | "fundstratSmidBottom"
  | "fundstratLargeCapCore"
  | "fundstratSmidCore"
  | "alphaPicks"
  | "rbcCanadianFocus"
  | "rbcUsFocus"
  | "jpmUsAnalystFocus"
  | "rbccmFew"
  | "equateCad"
  | "equateUsd";

export type RankedListConfig = {
  key: RankedListKey;
  label: string;
  /** Chip text — short enough that six of them fit on one row. */
  short: string;
  /** CollapsibleSection prefKey on the Sources page (= its DOM id). */
  railKey: string;
  /** Every ticker on this list is a TSX listing. */
  canadian?: boolean;
  /** Presence on this list is a NEGATIVE view — excluded from the count. */
  bearish?: boolean;
};

export const RANKED_LISTS: RankedListConfig[] = [
  { key: "newtonUpticks", label: "Newton Upticks", short: "Upticks", railKey: "research.newton" },
  { key: "fundstratTop", label: "Fundstrat Top Ideas", short: "FS Top", railKey: "research.fsTop" },
  { key: "fundstratBottom", label: "Fundstrat Bottom Ideas", short: "FS Bottom", railKey: "research.fsBottom", bearish: true },
  { key: "fundstratSmidTop", label: "Fundstrat SMID Top", short: "FS SMID Top", railKey: "research.fsSmidTop" },
  { key: "fundstratSmidBottom", label: "Fundstrat SMID Bottom", short: "FS SMID Bottom", railKey: "research.fsSmidBottom", bearish: true },
  { key: "fundstratLargeCapCore", label: "Fundstrat Large-Cap Core", short: "FS LC Core", railKey: "research.lcCore" },
  { key: "fundstratSmidCore", label: "Fundstrat SMID Core", short: "FS SMID Core", railKey: "research.smidCore" },
  { key: "alphaPicks", label: "Seeking Alpha Picks", short: "Alpha Picks", railKey: "research.alpha" },
  { key: "rbcCanadianFocus", label: "RBC Canadian Focus", short: "RBC CA Focus", railKey: "research.rbcCa", canadian: true },
  { key: "rbcUsFocus", label: "RBC US Focus", short: "RBC US Focus", railKey: "research.rbcUs" },
  { key: "jpmUsAnalystFocus", label: "JPM US Analyst Focus", short: "JPM Focus", railKey: "research.jpm" },
  { key: "rbccmFew", label: "RBCCM Canadian FEW", short: "RBC FEW", railKey: "research.few", canadian: true },
  { key: "equateCad", label: "RBC Equate Canada (top decile)", short: "Equate CA", railKey: "research.equateCad", canadian: true },
  { key: "equateUsd", label: "RBC Equate US (top decile)", short: "Equate US", railKey: "research.equateUsd" },
];

export type RankedListRef = {
  key: RankedListKey;
  label: string;
  short: string;
  railKey: string;
  /** Rank within the list when it publishes one (Equate composite rank). */
  rank?: number;
  dateAdded?: string;
};

export type HeldBucket = "Portfolio" | "Watchlist";

export type RankedRow = {
  /** Cross-listing root — the row identity. */
  key: string;
  /** Canonical display ticker; the Canadian form when the name is TSX-listed. */
  ticker: string;
  name: string;
  sector: string;
  currency: "CAD" | "USD";
  /** Bullish lists only. */
  listCount: number;
  lists: RankedListRef[];
  /** Bearish lists (never counted) — rendered as a flag. */
  bearish: RankedListRef[];
  /** Set when pm:stocks already tracks the company (Portfolio wins). */
  held?: HeldBucket;
  /** The stored pm:stocks ticker for a held name (for links + dedupe). */
  heldTicker?: string;
};

export type HeldStockLike = { ticker: string; bucket?: string; name?: string; sector?: string };

type Cited = { ticker: string; canonical: string; ref: RankedListRef; bearish: boolean; canadian: boolean; name?: string; sector?: string };

function isSellRated(p: AlphaPickEntry): boolean {
  const r = (p.rating ?? "").toLowerCase();
  return !!(p as { manualSell?: boolean }).manualSell || r.includes("sell");
}

/** Every citation across every ranked list, one per (list, ticker). */
function collectCitations(research: Partial<ResearchState>): Cited[] {
  const out: Cited[] = [];
  for (const cfg of RANKED_LISTS) {
    const list = research[cfg.key];
    if (!Array.isArray(list)) continue;
    const seenInList = new Set<string>();
    for (const raw of list as Array<Record<string, unknown>>) {
      const t = typeof raw?.ticker === "string" ? raw.ticker.trim() : "";
      if (!t) continue;
      const canonical = canonicalTicker(t);
      if (!canonical || seenInList.has(canonical)) continue;
      seenInList.add(canonical);
      // A sell-rated Alpha Pick is a bearish view, not a nomination.
      const bearish = cfg.bearish || (cfg.key === "alphaPicks" && isSellRated(raw as unknown as AlphaPickEntry));
      const rank = typeof raw.equateRank === "number" ? raw.equateRank : undefined;
      const dateAdded = typeof raw.dateAdded === "string" ? raw.dateAdded : undefined;
      out.push({
        ticker: t,
        canonical,
        ref: { key: cfg.key, label: cfg.label, short: bearish && cfg.key === "alphaPicks" ? "Alpha Picks (Sell)" : cfg.short, railKey: cfg.railKey, rank, dateAdded },
        bearish,
        canadian: !!cfg.canadian,
        name: typeof raw.name === "string" ? raw.name : undefined,
        sector: typeof raw.sector === "string" ? raw.sector : undefined,
      });
    }
  }
  return out;
}

/**
 * Build the ranked table. `stocks` is pm:stocks (any subset of fields) and is
 * used ONLY to badge held names and to prefer the app's own name/sector.
 */
export function rankResearch(research: Partial<ResearchState>, stocks: HeldStockLike[] = []): RankedRow[] {
  const heldByRoot = new Map<string, HeldStockLike>();
  for (const s of stocks) {
    if (!s?.ticker) continue;
    const root = crossListingRoot(s.ticker);
    const prev = heldByRoot.get(root);
    // Portfolio beats Watchlist when both forms of a dual-listed name are tracked.
    if (!prev || (prev.bucket !== "Portfolio" && s.bucket === "Portfolio")) heldByRoot.set(root, s);
  }

  const groups = new Map<string, Cited[]>();
  for (const c of collectCitations(research)) {
    const root = crossListingRoot(c.canonical);
    if (!root) continue;
    const g = groups.get(root);
    if (g) g.push(c);
    else groups.set(root, [c]);
  }

  const rows: RankedRow[] = [];
  for (const [root, cites] of groups) {
    const held = heldByRoot.get(root);
    const heldCanonical = held ? canonicalTicker(held.ticker) : "";
    // Canadian if any Canadian list cites it, any citation already carries the
    // TSX suffix, or the book holds the .TO form. Dual-listed → Canadian ticker.
    const canadian =
      cites.some((c) => c.canadian || c.canonical.endsWith(".TO")) || heldCanonical.endsWith(".TO");
    const ticker = canadian ? `${root}.TO` : root;
    // Dedupe list refs by key (a list can't nominate twice, but a US + CA
    // citation of the same company from one list would otherwise double up).
    const lists = new Map<RankedListKey, RankedListRef>();
    const bearish = new Map<RankedListKey, RankedListRef>();
    for (const c of cites) (c.bearish ? bearish : lists).set(c.ref.key, c.ref);
    const name = held?.name || cites.find((c) => c.name)?.name || "";
    const sector = held?.sector || cites.find((c) => c.sector)?.sector || "";
    rows.push({
      key: root,
      ticker,
      name: name && name !== ticker ? name : "",
      sector,
      currency: canadian ? "CAD" : "USD",
      listCount: lists.size,
      lists: [...lists.values()],
      bearish: [...bearish.values()],
      held: held ? (held.bucket === "Portfolio" ? "Portfolio" : "Watchlist") : undefined,
      heldTicker: held?.ticker,
    });
  }

  rows.sort((a, b) => {
    if (b.listCount !== a.listCount) return b.listCount - a.listCount;
    if (a.bearish.length !== b.bearish.length) return a.bearish.length - b.bearish.length;
    return a.ticker.localeCompare(b.ticker);
  });
  return rows;
}

export type FellOffRow = {
  key: string;
  ticker: string;
  /** Labels of the lists it was dropped from, most recent first. */
  droppedFrom: string[];
  /** Most recent drop date (YYYY-MM-DD). */
  lastDroppedOn: string;
};

/**
 * Names that were dropped from a list recently and are now on NO list. Names
 * still on other lists are not "fallen off" — they show in the main table
 * with one fewer chip. Sourced from the append-only pm:research-removals log.
 */
export function fellOffRows(removals: ResearchRemovalStore, current: RankedRow[], days = 45): FellOffRow[] {
  const live = new Set(current.filter((r) => r.listCount > 0 || r.bearish.length > 0).map((r) => r.key));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const byRoot = new Map<string, FellOffRow>();
  const dates = Object.keys(removals ?? {}).filter((d) => d >= cutoff).sort().reverse();
  for (const date of dates) {
    for (const e of removals[date] ?? []) {
      if (!e?.ticker) continue;
      const canonical = canonicalTicker(e.ticker);
      const root = crossListingRoot(canonical);
      if (!root || live.has(root)) continue;
      const prev = byRoot.get(root);
      const label = e.sourceLabel || e.source;
      if (prev) {
        if (!prev.droppedFrom.includes(label)) prev.droppedFrom.push(label);
      } else {
        byRoot.set(root, { key: root, ticker: canonical, droppedFrom: [label], lastDroppedOn: date });
      }
    }
  }
  return [...byRoot.values()].sort((a, b) => b.lastDroppedOn.localeCompare(a.lastDroppedOn));
}
