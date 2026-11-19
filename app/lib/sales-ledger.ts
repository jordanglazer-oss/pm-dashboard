import type { getRedis } from "./redis";

/**
 * Sales ledger (Nov 2026) — `pm:pim-sales-ledger`, APPEND-ONLY.
 *
 * Why it exists: the trade log (pm:pim-portfolio-state) stores a sale's price
 * and target weight but NOT how many units were sold or the average cost at
 * that moment, and pm:pim-positions keeps only the CURRENT units + cost. So a
 * realized gain could never be computed after the fact. This ledger captures,
 * at the moment any write REDUCES a position's units, the units before /
 * after, the average cost (C$ per unit) and the whole book as it stood, so a
 * later report can join the sale price from the trade log and express the
 * realized gain as a % of the book.
 *
 * Written from the two places positions are saved: PUT /api/kv/pim-positions
 * (every browser path) and the staged-rebalance commit. It is a write-ASIDE:
 * it never changes what is saved to pm:pim-positions and a failure here is
 * swallowed, so it can never block or alter a trade.
 *
 * An entry is a FACT about units, not proof of a trade: "Edit positions" that
 * lowers a weight is recorded too. Readers must pair an entry with a sell in
 * the trade log (same book, symbol, day) before calling it a realized sale.
 *
 * Shape: { events: SaleEvent[] } oldest first, capped at MAX_EVENTS (oldest
 * dropped). BACKED UP (not in the backup exclude list). Losing it loses the
 * ability to tally realized gains for sales made before the loss.
 */

export const SALES_LEDGER_KEY = "pm:pim-sales-ledger";
const MAX_EVENTS = 1500;

type Pos = { symbol: string; units: number; costBasis: number };
export type LedgerBook = { groupId: string; profile: string; positions?: Pos[] };

export type SaleEvent = {
  id: string;
  /** ISO time the write happened. */
  at: string;
  /** Eastern date of the write (or the staged rebalance's as-of date). */
  date: string;
  groupId: string;
  profile: string;
  source: "client" | "staged-rebalance";
  sales: { symbol: string; unitsBefore: number; unitsAfter: number; costBasis: number }[];
  /** The whole book BEFORE the write — lets a report value the book that day. */
  bookBefore: Pos[];
};

const easternDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Every book (present both before and after) where at least one position's units went DOWN. */
export function diffSales(before: LedgerBook[], after: LedgerBook[], source: SaleEvent["source"], asOf?: string): SaleEvent[] {
  const now = new Date();
  const out: SaleEvent[] = [];
  for (const b of before) {
    const a = after.find((x) => x.groupId === b.groupId && x.profile === b.profile);
    if (!a || !Array.isArray(b.positions) || !Array.isArray(a.positions)) continue;
    const afterUnits = new Map(a.positions.map((p) => [p.symbol, num(p.units)]));
    const sales = b.positions
      .map((p) => ({ symbol: p.symbol, unitsBefore: num(p.units), unitsAfter: afterUnits.get(p.symbol) ?? 0, costBasis: num(p.costBasis) }))
      // Ignore rounding noise: a real reduction is > 0.0005 units AND > 0.01% of the holding.
      .filter((s) => s.unitsBefore > 0 && s.unitsBefore - s.unitsAfter > 0.0005 && (s.unitsBefore - s.unitsAfter) / s.unitsBefore > 0.0001);
    if (!sales.length) continue;
    out.push({
      id: `${now.getTime().toString(36)}-${b.groupId}-${b.profile}-${Math.random().toString(36).slice(2, 7)}`,
      at: now.toISOString(),
      date: asOf ?? easternDate(now),
      groupId: b.groupId,
      profile: b.profile,
      source,
      sales,
      bookBefore: b.positions.filter((p) => num(p.units) > 0).map((p) => ({ symbol: p.symbol, units: num(p.units), costBasis: num(p.costBasis) })),
    });
  }
  return out;
}

/** Append events (read-merge-write, keeps unknown top-level fields). NEVER throws. */
export async function appendSales(redis: Awaited<ReturnType<typeof getRedis>>, events: SaleEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    const raw = await redis.get(SALES_LEDGER_KEY);
    let store: { events: SaleEvent[] } & Record<string, unknown> = { events: [] };
    if (raw) {
      const parsed = JSON.parse(raw); // a corrupt blob throws → caught below, nothing overwritten
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) return; // unexpected shape: leave it alone
      store = parsed;
    }
    const next = [...store.events, ...events];
    await redis.set(SALES_LEDGER_KEY, JSON.stringify({ ...store, events: next.slice(Math.max(0, next.length - MAX_EVENTS)), updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.error("[sales-ledger] append failed (positions write unaffected):", e);
  }
}
