/**
 * Mutual fund NAVs, distributions and total return (Nov 2026).
 *
 * WHY THIS EXISTS. A mutual fund's NAV falls by the amount of every
 * distribution it pays, so a return taken from the plain NAV understates what
 * an investor earned. Until 2026-11-24 every fund return in the dashboard was
 * taken from the plain NAV (the old comments said the NAV "already reflects
 * reinvested distributions" — it does not). Checked that day, 2026 year to
 * date: FID5982 +32.1% on plain NAV vs +38.0% with its distribution
 * reinvested (FactSet +37.93%); DYN3361 −5.1% vs +4.07% (FactSet +4.07%).
 *
 * THE RULE FROM HERE ON
 *   - A fund's PRICE (what a unit costs today, what a trade settles at) is the
 *     plain NAV. It was always right and is unchanged.
 *   - A fund's RETURN over any period uses the NAV with distributions
 *     reinvested — the same basis as the Yahoo adjusted closes used for
 *     stocks and ETFs, and the basis FactSet reports.
 *
 * SOURCE. The Globe and Mail / Barchart end-of-day feed the app has always
 * used for fund prices. Asked with `dividends=true&backadjust=true` it
 * returns the distribution-adjusted series; the day-to-day ratio of that
 * series is the fund's total return for the day. It is an unofficial feed
 * (no licence, no guarantee) — see docs/fund-data-source-handoff.md for the
 * licensed alternatives being evaluated — which is why the dashboard also
 * keeps its OWN log of every NAV and distribution (app/lib/fund-nav-log.ts).
 *
 * Pure fetch + arithmetic. No Redis.
 */

export type NavPoint = { date: string; nav: number };

export type FundDistribution = {
  /** The day the NAV went ex-distribution (YYYY-MM-DD). */
  date: string;
  /** The distribution as a % of that day's NAV. */
  pctOfNav: number;
  /** Approximate amount per unit, in the fund's currency (pctOfNav × that day's NAV). */
  perUnit: number;
};

/** FUNDSERV code (Canadian mutual fund): FID5982, RBF1083, DYN3361, with or without "-T". */
export const isFundCode = (s: string) => /^[A-Z]{2,4}\d{2,5}(-T)?$/i.test(s);
export const bareFundCode = (s: string) => s.replace(/-T$/i, "").toUpperCase();

const FEED = "https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Referer: "https://www.theglobeandmail.com/" };

/** The feed's query for one fund. `adjusted` = distributions reinvested (for RETURNS); plain = the NAV as printed (for PRICES). */
export function fundFeedUrl(code: string, opts: { records: number; adjusted: boolean; order?: "asc" | "desc" }): string {
  const flags = opts.adjusted ? "dividends=true&backadjust=true" : "dividends=false&backadjust=false";
  return `${FEED}?symbol=${encodeURIComponent(`${bareFundCode(code)}.CF`)}&data=daily&maxrecords=${opts.records}&volume=contract&order=${opts.order ?? "asc"}&${flags}`;
}

/** Parse the feed's CSV ("SYM.CF,DATE,OPEN,HIGH,LOW,CLOSE,VOLUME") into ascending points. */
export function parseFundFeed(text: string): NavPoint[] {
  const out: NavPoint[] = [];
  for (const line of text.trim().split("\n")) {
    const p = line.split(",");
    if (p.length < 6) continue;
    const nav = parseFloat(p[5]);
    let date = p[1]?.trim() ?? "";
    // The feed has used both YYYY-MM-DD and M/D/YYYY.
    const slash = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) date = `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(nav) || nav <= 0) continue;
    out.push({ date, nav });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** One fund's NAV history, ascending. Empty on any failure (never throws). */
export async function fetchFundNav(code: string, opts: { records: number; adjusted: boolean }): Promise<NavPoint[]> {
  try {
    const res = await fetch(fundFeedUrl(code, opts), { cache: "no-store", headers: HEADERS });
    if (!res.ok) return [];
    return parseFundFeed(await res.text());
  } catch {
    return [];
  }
}

/**
 * Distributions, read off the two series: on an ex-distribution day the ratio
 * (adjusted ÷ plain) steps up, by the distribution's share of the NAV.
 * Steps under 0.05% are rounding, not distributions.
 */
export function findDistributions(plain: NavPoint[], adjusted: NavPoint[]): FundDistribution[] {
  const adj = new Map(adjusted.map((p) => [p.date, p.nav]));
  const out: FundDistribution[] = [];
  let prev: number | null = null;
  for (const p of plain) {
    const a = adj.get(p.date);
    if (a == null) continue;
    const ratio = a / p.nav;
    if (prev != null) {
      const step = ratio / prev - 1;
      if (step > 0.0005) out.push({ date: p.date, pctOfNav: +(step * 100).toFixed(4), perUnit: +(p.nav * step).toFixed(5) });
    }
    prev = ratio;
  }
  return out;
}

/**
 * A total-return index built from PLAIN NAVs plus distributions — the
 * dashboard's own arithmetic, independent of the feed's adjusted series:
 * each day grows by (NAV today + any distribution today) ÷ NAV the day before.
 * Starts at the first NAV. Used to check the feed against our log.
 */
export function totalReturnIndex(plain: NavPoint[], dists: FundDistribution[]): NavPoint[] {
  const paid = new Map(dists.map((d) => [d.date, d.perUnit]));
  const out: NavPoint[] = [];
  let value = 0;
  for (let i = 0; i < plain.length; i++) {
    if (i === 0) value = plain[0].nav;
    else value *= (plain[i].nav + (paid.get(plain[i].date) ?? 0)) / plain[i - 1].nav;
    out.push({ date: plain[i].date, nav: value });
  }
  return out;
}

/** % return from the last point on or before `from` to the last point. Null when the series does not reach `from` (within a week). */
export function returnSinceDate(series: NavPoint[], from: string): number | null {
  if (series.length < 2) return null;
  let base: NavPoint | null = null;
  for (const p of series) {
    if (p.date <= from) base = p;
    else break;
  }
  if (!base || Date.parse(from) - Date.parse(base.date) > 7 * 86_400_000) return null;
  return (series[series.length - 1].nav / base.nav - 1) * 100;
}

/** Year-to-date % return: from the last point of the prior calendar year. */
export function ytdReturn(series: NavPoint[]): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const base = series.filter((p) => p.date < `${last.date.slice(0, 4)}-01-01`).pop();
  return base ? (last.nav / base.nav - 1) * 100 : null;
}
