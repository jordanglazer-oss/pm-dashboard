/**
 * Watchlist plan (Nov 2026, meeting item 8) — the watchlist as a decision
 * tool: for each name, why we would own it, the price we would pay, what
 * would make us drop it, and when / by whom / at what price it was added.
 *
 * Stored on the stock record as the optional `watch` object (pm:stocks,
 * saved through the existing single-record `updateStockFields` path). Every
 * field is optional and nothing is ever filled in automatically: the target
 * buy price is the PM's number.
 *
 * Pure — no Redis, no fetch, no React.
 */

export type WatchlistPlan = {
  /** A few reasons to own it. */
  thesis?: string;
  /** The price we would be willing to buy at (the stock's trading currency). */
  targetBuyPrice?: number;
  /** What would make us drop it. */
  breakers?: string;
  /** YYYY-MM-DD the name went on the watchlist — blank when not known. */
  addedOn?: string;
  /** Price on the day it was added. */
  priceAtAdd?: number;
  /** Who added it (free text). */
  addedBy?: string;
};

export type WatchStockLike = { ticker: string; name?: string; bucket?: string; watch?: WatchlistPlan };

export type WatchRow = {
  ticker: string;
  name: string;
  plan: WatchlistPlan;
  price: number | null;
  /** % change since it was added (null without a price at add). */
  sinceAddPct: number | null;
  /** % the price is above the target buy price (≤ 0 = at or below target). */
  aboveTargetPct: number | null;
  /** At or below the target buy price. */
  atTarget: boolean;
};

const pct = (now: number, then: number) => parseFloat(((now / then - 1) * 100).toFixed(2));
const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Watchlist rows, the names DOWN THE MOST since added first (we buy quality
 *  when it is out of favour); names with no price-at-add follow, A–Z. */
export function watchRows(stocks: WatchStockLike[], prices: Record<string, number | null | undefined>): WatchRow[] {
  const rows = stocks
    .filter((s) => s.bucket === "Watchlist")
    .map((s): WatchRow => {
      const plan = s.watch ?? {};
      const price = pos(prices[s.ticker]) ? (prices[s.ticker] as number) : null;
      const sinceAddPct = price != null && pos(plan.priceAtAdd) ? pct(price, plan.priceAtAdd) : null;
      const aboveTargetPct = price != null && pos(plan.targetBuyPrice) ? pct(price, plan.targetBuyPrice) : null;
      return { ticker: s.ticker, name: s.name ?? "", plan, price, sinceAddPct, aboveTargetPct, atTarget: aboveTargetPct != null && aboveTargetPct <= 0 };
    });
  return rows.sort((a, b) => {
    if (a.sinceAddPct != null && b.sinceAddPct != null) return a.sinceAddPct - b.sinceAddPct;
    if (a.sinceAddPct != null) return -1;
    if (b.sinceAddPct != null) return 1;
    return a.ticker.localeCompare(b.ticker);
  });
}

/** Names already used in "Added by" across the book, most used first — offered as suggestions. */
export function addedByOptions(stocks: WatchStockLike[]): string[] {
  const n = new Map<string, number>();
  for (const s of stocks) {
    const who = s.watch?.addedBy?.trim();
    if (who) n.set(who, (n.get(who) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

export type WatchAlert = { rule: "target-reached" | "new-on-lists"; priority: "medium" | "low"; ticker: string; title: string; detail: string; suggestion: string; dedupeKey: string };

/** The alert rules (no AI). `newOnLists` = for a ticker, the labels of the
 *  bullish lists it joined in the last week when it now sits on 2+ lists. */
export function watchAlerts(rows: WatchRow[], newOnLists: Record<string, { count: number; joined: string[] }>, month: string): WatchAlert[] {
  const out: WatchAlert[] = [];
  for (const r of rows) {
    if (r.atTarget && r.price != null && pos(r.plan.targetBuyPrice))
      out.push({
        rule: "target-reached", priority: "medium", ticker: r.ticker,
        title: `${r.ticker} is at or below its target buy price`,
        detail: `${r.name || r.ticker} last traded at ${r.price.toFixed(2)}, against the target buy price of ${r.plan.targetBuyPrice.toFixed(2)} set on the watchlist${r.plan.thesis ? `. Why we would own it: ${r.plan.thesis.slice(0, 300)}` : ""}${r.plan.breakers ? ` What would make us drop it: ${r.plan.breakers.slice(0, 200)}` : ""}`,
        suggestion: "Re-read the thesis and the breakers, then decide: buy, wait, or move the target.",
        dedupeKey: `watchlist-target-${r.ticker.toUpperCase()}-${month}`,
      });
    const n = newOnLists[r.ticker];
    if (n && n.count >= 2 && n.joined.length)
      out.push({
        rule: "new-on-lists", priority: "low", ticker: r.ticker,
        title: `${r.ticker} (watchlist) is newly on ${n.count} research lists`,
        detail: `${r.name || r.ticker} joined ${n.joined.join(", ")} in the last week and is now on ${n.count} bullish lists.`,
        suggestion: "Worth a fresh look — and worth checking it is not simply getting crowded.",
        dedupeKey: `watchlist-lists-${r.ticker.toUpperCase()}-${month}`,
      });
  }
  return out;
}
