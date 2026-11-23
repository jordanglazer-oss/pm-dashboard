/**
 * In favour / out of favour (Nov 2026, meeting item 10).
 *
 * For names we own, watch, or that sit high on the ranked research lists:
 * relative performance versus the S&P 500 over 1 / 3 / 6 / 12 months and the
 * distance from the 52-week high, read into one plain label. Purpose: spot
 * good companies while they are out of favour, and flag holdings that are
 * back in favour as possible switch candidates. Built on PRICES only — the
 * composite score plays no part.
 *
 * Pure — no Redis, no fetch. The thresholds below are the whole rule.
 */

export const FAVOUR_RULES = {
  /** Out of favour: lagging the S&P by this much over 6 (or 12) months AND this far off the high. */
  outRel6: -10,
  outRel12: -15,
  outFromHigh: -20,
  /** In favour: ahead of the S&P by this much over 6 months AND within this of the high. */
  inRel6: 10,
  inFromHigh: -7,
  /** Turning: the last month against the longer trend. */
  turn1m: 5,
  /** Trading days needed for a 6-month read. */
  minDays: 126,
};

export type FavourState = "in" | "recovering" | "neutral" | "slipping" | "out" | "thin";
export const FAVOUR_LABEL: Record<FavourState, string> = {
  in: "In favour",
  recovering: "Coming back into favour",
  neutral: "Neutral",
  slipping: "Losing favour",
  out: "Out of favour",
  thin: "Not enough history",
};

export type Series = { dates: string[]; adj: number[] };
export type FavourRead = {
  state: FavourState;
  /** Return minus the S&P 500's return over the same days, in points. */
  rel: { m1: number | null; m3: number | null; m6: number | null; m12: number | null };
  /** Last close versus the highest close of the past year, % (0 = at the high). */
  fromHighPct: number | null;
  reasons: string[];
};

const r1 = (n: number) => parseFloat(n.toFixed(1));
/** Value on the last date on or before `d`. */
function at(s: Series, d: string): number | null {
  let lo = 0, hi = s.dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? s.adj[ans] : null;
}
const monthsBack = (iso: string, m: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString().slice(0, 10);
};

/** Read one name against the index. `stock` and `index` are daily closes, oldest first. */
export function readFavour(stock: Series, index: Series): FavourRead {
  const n = stock.dates.length;
  const empty: FavourRead = { state: "thin", rel: { m1: null, m3: null, m6: null, m12: null }, fromHighPct: null, reasons: ["Less than six months of price history"] };
  if (n < 2 || index.dates.length < 2) return empty;
  const lastDate = stock.dates[n - 1];
  const last = stock.adj[n - 1];
  const idxLast = at(index, lastDate);
  const rel = (m: number): number | null => {
    const from = monthsBack(lastDate, m);
    if (stock.dates[0] > from) return null; // series does not reach back that far
    const s0 = at(stock, from), i0 = at(index, from);
    if (!s0 || !i0 || !idxLast || !(s0 > 0) || !(i0 > 0)) return null;
    return r1((last / s0 - 1) * 100 - (idxLast / i0 - 1) * 100);
  };
  const yearAgo = monthsBack(lastDate, 12);
  let high = 0;
  for (let i = 0; i < n; i++) if (stock.dates[i] >= yearAgo && stock.adj[i] > high) high = stock.adj[i];
  const fromHighPct = high > 0 ? r1((last / high - 1) * 100) : null;
  const out: FavourRead = { state: "neutral", rel: { m1: rel(1), m3: rel(3), m6: rel(6), m12: rel(12) }, fromHighPct, reasons: [] };
  const { m1, m3, m6, m12 } = out.rel;
  if (n < FAVOUR_RULES.minDays || m6 == null || fromHighPct == null) return { ...out, state: "thin", reasons: ["Less than six months of price history"] };

  const R = FAVOUR_RULES;
  const pts = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} pts`;
  const isOut = fromHighPct <= R.outFromHigh && (m6 <= R.outRel6 || (m12 != null && m12 <= R.outRel12));
  const isIn = m6 >= R.inRel6 && fromHighPct >= R.inFromHigh;
  const weakLong = m6 < 0 || (m12 != null && m12 < 0);
  const strongLong = m6 > 0 && (m12 == null || m12 > 0);

  if (weakLong && m1 != null && m3 != null && m1 >= R.turn1m && m3 > 0) {
    out.state = "recovering";
    out.reasons.push(`Lagged the S&P 500 over 6 months (${pts(m6)}) but ahead over the last month (${pts(m1)}) and 3 months (${pts(m3)})`);
  } else if (isOut) {
    out.state = "out";
    out.reasons.push(`${Math.abs(fromHighPct).toFixed(0)}% below its 52-week high`, `${pts(m6)} versus the S&P 500 over 6 months${m12 != null ? `, ${pts(m12)} over 12` : ""}`);
  } else if (strongLong && m1 != null && m3 != null && m1 <= -R.turn1m && m3 < 0) {
    out.state = "slipping";
    out.reasons.push(`Ahead of the S&P 500 over 6 months (${pts(m6)}) but behind over the last month (${pts(m1)}) and 3 months (${pts(m3)})`);
  } else if (isIn) {
    out.state = "in";
    out.reasons.push(`${pts(m6)} versus the S&P 500 over 6 months`, fromHighPct >= -0.5 ? "at its 52-week high" : `${Math.abs(fromHighPct).toFixed(0)}% below its 52-week high`);
  } else {
    out.reasons.push(`${pts(m6)} versus the S&P 500 over 6 months, ${Math.abs(fromHighPct).toFixed(0)}% below its 52-week high`);
  }
  return out;
}

export type FavourGroup = "Portfolio" | "Watchlist" | "Ranked";
/** What the label means for the decision, per the meeting note. */
export function favourNote(state: FavourState, group: FavourGroup): string {
  if (group === "Portfolio" && (state === "in" || state === "recovering")) return "Back in favour — a possible switch candidate";
  if (group !== "Portfolio" && state === "out") return "Out of favour — worth a look if the quality is there";
  if (group !== "Portfolio" && state === "recovering") return "Turning up from out of favour";
  if (group === "Portfolio" && state === "out") return "Out of favour — check the thesis still holds";
  return "";
}
