/**
 * Ideas — ONE list (Nov 26 2026 team session): every name we do not own that
 * came from somewhere: our watchlist, the Suggested store, any research
 * list, or the SIA movers (names gaining relative strength). Pure — no I/O. READ-ONLY: merges what is already on file, stores
 * nothing, and never feeds a score, a weight or a trade.
 *
 * A name that is on NO source list and has been off them (or on the
 * watchlist) for longer than `dropAfterDays` leaves the active view unless
 * pinned. It moves to the archive view; nothing is deleted.
 */

import type { RankedRow } from "./research-ranked";
import type { RankedHistory } from "./ranked-source-history";

export type IdeaStockLike = { ticker: string; name?: string; bucket?: string; sector?: string; watch?: { addedOn?: string } | null; suggestedSince?: string };
export type Idea = {
  key: string;
  ticker: string;
  name: string;
  sector: string;
  /** Where it came from: list short names, plus "Watchlist" / "Suggested". */
  sources: string[];
  /** Bullish research lists it is on now. */
  listCount: number;
  /** Bearish lists it is on (a flag, never counted). */
  bearish: string[];
  onWatchlist: boolean;
  /** Last day it was on any list, or the day it joined the watchlist; null when unknown. */
  lastSeen: string | null;
  /** Off every list for longer than the cut-off, and not pinned. */
  stale: boolean;
  pinned: boolean;
};

const root = (t: string) => t.trim().toUpperCase().replace(/(-T|\.TO|\.U|-U\.TO)$/i, "");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export type IdeaMover = { ticker: string; wChg?: number; smax?: number | null; sector?: string | null };

export function buildIdeas(opts: { ranked: RankedRow[]; watchlist: IdeaStockLike[]; suggested: IdeaStockLike[]; history: RankedHistory | null; pinned: string[]; today: string; dropAfterDays: number; movers?: IdeaMover[]; held?: string[] }): Idea[] {
  const { ranked, watchlist, suggested, history, today, dropAfterDays } = opts;
  const pinned = new Set(opts.pinned.map(root));
  const out = new Map<string, Idea>();
  const get = (ticker: string, name: string, sector: string): Idea => {
    const k = root(ticker);
    let i = out.get(k);
    if (!i) {
      i = { key: k, ticker, name: name || ticker, sector: sector || "", sources: [], listCount: 0, bearish: [], onWatchlist: false, lastSeen: null, stale: false, pinned: pinned.has(k) };
      out.set(k, i);
    }
    return i;
  };
  for (const r of ranked) {
    if (r.held === "Portfolio") continue; // an idea is a name we do not own
    const i = get(r.heldTicker ?? r.ticker, r.name, r.sector);
    i.listCount = r.listCount;
    for (const l of r.lists) if (!i.sources.includes(l.short)) i.sources.push(l.short);
    i.bearish = r.bearish.map((b) => b.short);
  }
  for (const s of suggested) {
    const i = get(s.ticker, s.name ?? "", s.sector ?? "");
    if (!i.sources.includes("Suggested")) i.sources.push("Suggested");
    if (s.suggestedSince && (!i.lastSeen || s.suggestedSince > i.lastSeen)) i.lastSeen = s.suggestedSince.slice(0, 10);
  }
  for (const s of watchlist) {
    const i = get(s.ticker, s.name ?? "", s.sector ?? "");
    i.ticker = s.ticker;
    if (s.name) i.name = s.name;
    i.onWatchlist = true;
    if (!i.sources.includes("Watchlist")) i.sources.unshift("Watchlist");
    const added = s.watch?.addedOn;
    if (added && (!i.lastSeen || added > i.lastSeen)) i.lastSeen = added;
  }
  // SIA movers: names gaining relative strength in the latest SIA export. A source of its own, seen today.
  const heldRoots = new Set((opts.held ?? []).map(root));
  for (const m of opts.movers ?? []) {
    if (!m?.ticker || heldRoots.has(root(m.ticker))) continue;
    const i = get(m.ticker, "", m.sector ?? "");
    if (!i.sources.includes("SIA mover")) i.sources.push("SIA mover");
    i.lastSeen = today;
  }
  for (const i of out.values()) {
    if (i.sources.includes("SIA mover") && i.listCount === 0) continue;
    if (i.listCount > 0) {
      i.lastSeen = today;
      continue;
    }
    // Off every list: the last day it was on one, from the list history.
    const h = history?.tickers?.[i.key];
    for (const spans of Object.values(h?.lists ?? {})) for (const sp of spans ?? []) {
      const d = sp.to ?? today;
      if (!i.lastSeen || d > i.lastSeen) i.lastSeen = d;
    }
    i.stale = !i.pinned && i.lastSeen != null && daysBetween(i.lastSeen, today) > dropAfterDays;
  }
  return [...out.values()];
}
