import { getRedis } from "@/app/lib/redis";
import { easternToday } from "@/app/lib/date-eastern";

/**
 * Active hedge-position ledger (pm:hedges) — GROUND TRUTH for whether the book
 * actually has protection on. The morning brief previously inferred "hedge is
 * on" from its own prior HOLD call, so a one-time ADD recommendation drifted
 * into perpetual HOLD even though nothing was ever implemented. This store
 * records what the PM ACTUALLY did (strike, premium, tenor, entry spot), so:
 *   - the brief only says HOLD when a real position exists,
 *   - and each hedge's cost/performance can be tracked over its life.
 *
 * User-owned data — never seed/clobber; GET returns [] on miss, POST replaces
 * the full array (the client manages add/close/edit and persists the whole
 * list, same pattern as pm:stocks).
 */

export const HEDGES_KEY = "pm:hedges";

export type HedgePosition = {
  id: string;
  status: "active" | "closed";
  /** ISO date the protection was put on. */
  implementedAt: string;
  /** Option expiry (YYYY-MM-DD) — drives the days-to-expiry + expired check. */
  expiry?: string;
  /** Free-text tenor as recommended, e.g. "3 months". */
  tenorLabel?: string;
  /** Strike distance out-of-the-money, in percent (e.g. 7 = 7% OTM put). */
  strikePctOtm?: number;
  /** Absolute strike price, if the PM entered it. */
  strikePrice?: number;
  /** SPY spot at entry — anchors the premium-%-of-spot and later P&L. */
  spotAtEntry?: number;
  /** Premium paid, as % of spot (matches how the brief quotes cheapness). */
  premiumPctOfSpot?: number;
  /** Premium paid per contract, in $ (option price × 100 is notional). */
  premiumUsd?: number;
  /** Number of contracts, if tracked. */
  contracts?: number;
  notes?: string;
  // ── Close / performance ──
  closedAt?: string;
  /** Premium the position was closed/sold at, per contract in $. */
  closePremiumUsd?: number;
  closeNote?: string;
};

export type HedgesState = { hedges: HedgePosition[] };

/** A hedge is PROTECTING today when it's not closed and not past expiry. */
export function isActiveHedge(h: HedgePosition, todayIso: string = easternToday()): boolean {
  if (h.status !== "active") return false;
  if (h.expiry && /^\d{4}-\d{2}-\d{2}$/.test(h.expiry) && h.expiry < todayIso) return false;
  return true;
}

/** Realized P&L in $ (close − entry premium), or null if unknown. premiumUsd
 *  is the quoted option price, so one contract = ×100 shares of notional. */
export function realizedPnlUsd(h: HedgePosition): number | null {
  if (h.status !== "closed" || h.premiumUsd == null || h.closePremiumUsd == null) return null;
  const total = (h.closePremiumUsd - h.premiumUsd) * 100 * (h.contracts ?? 1);
  return Math.round(total * 100) / 100;
}

function parse(raw: string | null): HedgePosition[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as HedgesState | HedgePosition[];
    const arr = Array.isArray(j) ? j : Array.isArray(j?.hedges) ? j.hedges : [];
    return arr.filter((h) => h && typeof h.id === "string");
  } catch {
    return [];
  }
}

/** Read the full ledger (read-only). Empty on miss/error. */
export async function loadHedges(): Promise<HedgePosition[]> {
  const redis = await getRedis();
  return parse(await redis.get(HEDGES_KEY));
}

/** One-line description for prompt / UI, e.g. "3-month 7% OTM SPY put,
 *  entered 2026-07-20 @ 1.20% of spot ($6.05), expires 2026-10-17". */
export function describeHedge(h: HedgePosition): string {
  const bits: string[] = [];
  if (h.tenorLabel) bits.push(h.tenorLabel);
  if (h.strikePctOtm != null) bits.push(`${h.strikePctOtm}% OTM`);
  bits.push("SPY put");
  let s = bits.join(" ");
  if (h.implementedAt) s += `, entered ${h.implementedAt.slice(0, 10)}`;
  const cost: string[] = [];
  if (h.premiumPctOfSpot != null) cost.push(`${h.premiumPctOfSpot.toFixed(2)}% of spot`);
  if (h.premiumUsd != null) cost.push(`$${h.premiumUsd.toFixed(2)}`);
  if (cost.length) s += ` @ ${cost.join(" / ")}`;
  if (h.contracts != null) s += `, ${h.contracts} contract${h.contracts === 1 ? "" : "s"}`;
  if (h.expiry) s += `, expires ${h.expiry}`;
  return s;
}
