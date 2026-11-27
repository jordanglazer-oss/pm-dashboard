/**
 * The Hedging page's standard measure (Nov 26 2026 team session): the cost of
 * a SPY put — by default 3 months out, 5% out of the money — as a % of the
 * exposure protected (premium ÷ SPY at the quote's time), with its change
 * week over week and month over month and its average over about 3 months.
 * Pure — no I/O. Strike and term are settings (pm:ui-prefs on the page).
 */

export type HeadlineStrike = "atm" | "otm5" | "otm10";
export const HEADLINE_STRIKES: { id: HeadlineStrike; label: string }[] = [
  { id: "atm", label: "at the money" },
  { id: "otm5", label: "5% out of the money" },
  { id: "otm10", label: "10% out of the money" },
];
export const HEADLINE_DEFAULT = { months: 3, strike: "otm5" as HeadlineStrike };

type Quote = { expiry: string; atmPremium: number | null; otm5Premium: number | null; otm10Premium: number | null };
type Snap = { date: string; spotPrice: number; quotes: Quote[] };

const premiumOf = (q: Quote, s: HeadlineStrike) => (s === "atm" ? q.atmPremium : s === "otm5" ? q.otm5Premium : q.otm10Premium);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Cost as % of spot for the expiry nearest `months` out from the snapshot's own date; null when not priced. */
export function costPct(snap: Snap, months: number, strike: HeadlineStrike): { pct: number; expiry: string; daysOut: number } | null {
  if (!(snap.spotPrice > 0) || !snap.quotes?.length) return null;
  const target = months * 30.4;
  const priced = snap.quotes.map((q) => ({ q, d: days(snap.date, q.expiry), p: premiumOf(q, strike) })).filter((x) => x.d > 0 && x.p != null && x.p > 0);
  if (!priced.length) return null;
  const best = priced.reduce((a, b) => (Math.abs(b.d - target) < Math.abs(a.d - target) ? b : a));
  // A quote more than 45 days away from the term asked for is not that term.
  if (Math.abs(best.d - target) > 45) return null;
  return { pct: ((best.p as number) / snap.spotPrice) * 100, expiry: best.q.expiry, daysOut: best.d };
}

/** The saved snapshot closest to `daysAgo` before `asOf`, within the tolerance. */
function nearest(history: Snap[], asOf: string, daysAgo: number, tol: number): Snap | null {
  let best: Snap | null = null;
  let diff = Infinity;
  for (const s of history) {
    const d = Math.abs(days(s.date, asOf) - daysAgo);
    if (s.date < asOf && d <= tol && d < diff) {
      best = s;
      diff = d;
    }
  }
  return best;
}

export type Headline = {
  pct: number | null;
  expiry: string | null;
  daysOut: number | null;
  asOf: string;
  weekAgo: { pct: number; date: string } | null;
  monthAgo: { pct: number; date: string } | null;
  /** Average over the saved days in the last ~92 days (needs at least 5), and how many days it is built on. */
  avg3m: { pct: number; days: number } | null;
  /** "low" / "near" / "high" vs that average (±10%); null without an average. */
  vsAvg: "low" | "near" | "high" | null;
};

export function hedgeHeadline(now: Snap, history: Snap[], months = HEADLINE_DEFAULT.months, strike: HeadlineStrike = HEADLINE_DEFAULT.strike): Headline {
  const cur = costPct(now, months, strike);
  const at = (daysAgo: number, tol: number) => {
    const s = nearest(history, now.date, daysAgo, tol);
    const c = s ? costPct(s, months, strike) : null;
    return s && c ? { pct: c.pct, date: s.date } : null;
  };
  const window = history.filter((s) => s.date < now.date && days(s.date, now.date) <= 92).map((s) => costPct(s, months, strike)?.pct).filter((v): v is number => v != null);
  const avg3m = window.length >= 5 ? { pct: window.reduce((a, b) => a + b, 0) / window.length, days: window.length } : null;
  const vsAvg = cur && avg3m ? (cur.pct < avg3m.pct * 0.9 ? "low" : cur.pct > avg3m.pct * 1.1 ? "high" : "near") : null;
  return { pct: cur?.pct ?? null, expiry: cur?.expiry ?? null, daysOut: cur?.daysOut ?? null, asOf: now.date, weekAgo: at(7, 3), monthAgo: at(30, 6), avg3m, vsAvg };
}
