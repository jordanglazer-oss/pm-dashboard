/**
 * The SIA Charts transaction log → the PIM All-Equity book's ACTUAL holdings
 * over time (Nov 2026). Pure — no I/O.
 *
 * The export (Date, Symbol, Action, Units, Price — prices in C$) is an exact
 * units record of the book since 2018. It replaces the rebuild from model
 * target weights for "Contribution by holding", which could not see anything
 * before the dashboard's own trade log began (2026-04-13) and missed trades
 * that were never logged there.
 *
 * READ-ONLY use: nothing here, and nothing that calls it, writes a
 * performance series, a position, a model or a score.
 *
 * Units are expressed in TODAY'S share terms (a trade before a split is
 * multiplied by the split factor), because the price history they are valued
 * with is split-adjusted for all dates.
 */

export type SiaTxn = { date: string; symbol: string; action: "BUY" | "SELL"; units: number; price: number };

/** Splits needed to cumulate units correctly. factor = new shares per old share. */
export const SIA_SPLITS: Record<string, { date: string; factor: number }[]> = {
  GOOGL: [{ date: "2022-07-18", factor: 20 }],
  TSLA: [
    { date: "2020-08-31", factor: 5 },
    { date: "2022-08-25", factor: 3 },
  ],
  NVDA: [
    { date: "2021-07-20", factor: 4 },
    { date: "2024-06-10", factor: 10 },
  ],
  AAPL: [{ date: "2020-08-31", factor: 4 }],
  WMT: [{ date: "2024-02-26", factor: 3 }],
};

/** SIA names that differ from the dashboard's ticker for the same company. */
export const SIA_ALIASES: Record<string, string> = { ECHO: "SATS" };

/**
 * SIA symbol → the dashboard's form (which the price helper understands):
 * CLS.TO → CLS-T, XUS.U.TO → XUS.U, qqc.f.to → QQC.F-T, ARX.TO.IN1 → ARX-T,
 * LVGO.IN → LVGO; US names unchanged.
 */
export function siaSymbol(raw: string): string {
  let s = (raw || "").trim().toUpperCase().replace(/\.IN\d*$/, "");
  if (/\.U\.TO$/.test(s)) s = s.replace(/\.TO$/, "");
  else if (/\.TO$/.test(s)) s = s.replace(/\.TO$/, "-T");
  return SIA_ALIASES[s] ?? s;
}

const isoFromUs = (d: string): string | null => {
  const t = d.trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};
const num = (s: string) => parseFloat((s || "").replace(/[$,\s]/g, ""));

/** One CSV line → fields (handles quoted fields with commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse the export. Rows that cannot be read are reported, never guessed. */
export function parseSiaCsv(text: string): { txns: SiaTxn[]; problems: string[] } {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const problems: string[] = [];
  if (!lines.length) return { txns: [], problems: ["the file is empty"] };
  const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const iD = head.indexOf("date");
  const iS = head.indexOf("symbol");
  const iA = head.indexOf("action");
  const iU = head.indexOf("units");
  const iP = head.indexOf("price");
  if ([iD, iS, iA, iU, iP].some((i) => i < 0)) return { txns: [], problems: ["expected columns Date, Symbol, Action, Units, Price"] };
  const txns: SiaTxn[] = [];
  lines.slice(1).forEach((line, n) => {
    const f = splitCsvLine(line);
    const date = isoFromUs(f[iD] ?? "");
    const action = (f[iA] ?? "").trim().toUpperCase();
    const units = num(f[iU] ?? "");
    const price = num(f[iP] ?? "");
    const symbol = (f[iS] ?? "").trim();
    if (!date || !symbol || (action !== "BUY" && action !== "SELL") || !(units > 0) || !Number.isFinite(price) || price < 0) {
      if (problems.length < 20) problems.push("row " + (n + 2) + " could not be read: " + line.slice(0, 80));
      return;
    }
    txns.push({ date, symbol, action, units, price });
  });
  txns.sort((a, b) => a.date.localeCompare(b.date));
  return { txns, problems };
}

export type SplitTable = Record<string, { date: string; factor: number }[]>;

/** The built-in table merged with splits looked up at import time (same symbol + date counted once). */
export function mergeSplits(extra: SplitTable | null | undefined): SplitTable {
  const out: SplitTable = {};
  for (const src of [SIA_SPLITS, extra ?? {}]) {
    for (const [sym, list] of Object.entries(src)) {
      const cur = out[sym] ?? [];
      for (const x of list) if (x.factor > 0 && x.factor !== 1 && !cur.some((c) => c.date === x.date)) cur.push(x);
      out[sym] = cur.sort((m, n) => m.date.localeCompare(n.date));
    }
  }
  return out;
}

/** Product of the split factors that took effect AFTER the date (today's shares per share traded then). */
export function splitFactorAfter(symbol: string, date: string, splits: SplitTable = SIA_SPLITS): number {
  return (splits[symbol] ?? []).reduce((f, x) => (x.date > date ? f * x.factor : f), 1);
}

export type UnitStep = { from: string; units: number };
export type SiaPosition = {
  symbol: string;
  /** Units held after the close of `from`, in today's share terms. */
  steps: UnitStep[];
  /** C$ trade prices in today's share terms — a fallback when no market price exists. */
  tradePrices: { date: string; price: number }[];
  /** Last day this name traded in the log. */
  lastTrade: string;
  /** Days on which the running total fell meaningfully below zero (a corporate action not on file); it is reset to zero there. */
  negativeOn: string[];
};

/**
 * Cumulate the log into each name's units over time. A day's trades are
 * netted first (a sell listed before a same-day buy is not a short). A total
 * that still ends a day below zero is reset to zero and reported: small ones
 * are reinvested fund distributions, large ones a split or merger the split
 * table does not know.
 */
export function siaPositions(txns: SiaTxn[], splits: SplitTable = SIA_SPLITS): SiaPosition[] {
  const by = new Map<string, SiaTxn[]>();
  for (const t of txns) {
    const sym = siaSymbol(t.symbol);
    by.set(sym, [...(by.get(sym) ?? []), t]);
  }
  const out: SiaPosition[] = [];
  for (const [symbol, list] of by) {
    const sorted = [...list].sort((m, n) => m.date.localeCompare(n.date));
    let u = 0;
    let peak = 0;
    const steps: UnitStep[] = [];
    const tradePrices: { date: string; price: number }[] = [];
    const negativeOn: string[] = [];
    for (let i = 0; i < sorted.length; ) {
      const day = sorted[i].date;
      const f = splitFactorAfter(symbol, day, splits);
      let lastPx = 0;
      for (; i < sorted.length && sorted[i].date === day; i++) {
        const t = sorted[i];
        u += (t.action === "BUY" ? 1 : -1) * t.units * f;
        if (t.price > 0) lastPx = t.price / f;
      }
      if (u < 0) {
        if (Math.abs(u) > Math.max(1, peak * 0.02)) negativeOn.push(day);
        u = 0;
      }
      peak = Math.max(peak, u);
      // A sliver left after a full sale (fractional fund units, rounding) is not a position.
      const held = u > 1e-6 && u > peak * 0.005 ? u : 0;
      if (held === 0) {
        u = 0;
        peak = 0;
      }
      steps.push({ from: day, units: held });
      if (lastPx > 0) tradePrices.push({ date: day, price: lastPx });
    }
    out.push({ symbol, steps, tradePrices, lastTrade: sorted[sorted.length - 1].date, negativeOn });
  }
  return out;
}

/** Units held for the return of the day AFTER `prev`. */
export function unitsAt(steps: UnitStep[], prev: string): number {
  let u = 0;
  for (const s of steps) {
    if (s.from > prev) break;
    u = s.units;
  }
  return u;
}

export type PricePoints = { dates: string[]; adj: number[] };

/**
 * A holding's C$ price series for valuing and for returns: the market series
 * where it exists, and the log's own trade prices on days the market series
 * does not cover (a delisted or unpriced name), so a sale still shows its
 * result. `market` must already be in C$.
 */
export function mergedPrices(market: PricePoints, trades: { date: string; price: number }[]): PricePoints {
  if (!market.dates.length) {
    const t = [...trades].sort((m, n) => m.date.localeCompare(n.date));
    return { dates: t.map((x) => x.date), adj: t.map((x) => x.price) };
  }
  const first = market.dates[0];
  const last = market.dates[market.dates.length - 1];
  const m = new Map<string, number>();
  for (const t of trades) if (t.date < first || t.date > last) m.set(t.date, t.price);
  market.dates.forEach((d, i) => m.set(d, market.adj[i]));
  const dates = [...m.keys()].sort();
  return { dates, adj: dates.map((d) => m.get(d)!) };
}

const onOrBefore = (p: PricePoints, d: string): number | null => {
  let v: number | null = null;
  for (let i = 0; i < p.dates.length && p.dates[i] <= d; i++) v = p.adj[i];
  return v;
};

/** Days a price may be carried forward before a holding counts as unpriced (a delisted or merged name still "held" in the log). */
export const STALE_PRICE_DAYS = 12;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Each holding's ACTUAL weight for every day of the calendar: units held ×
 * C$ price at the prior close ÷ the book's value at that close. Weights drift
 * with prices exactly as the real book did. weights[i][t-1] is holding i's
 * weight for the return of calendar[t]. A holding whose last price is more
 * than STALE_PRICE_DAYS old is left out for that day (and listed), never
 * carried at a stale value.
 */
export function actualWeights(calendar: string[], holdings: { steps: UnitStep[]; prices: PricePoints }[]): { weights: number[][]; staleDays: number[] } {
  const n = calendar.length - 1;
  const weights = holdings.map(() => new Array<number>(Math.max(0, n)).fill(0));
  const staleDays = holdings.map(() => 0);
  const lastDate = holdings.map((h) => h.prices.dates[h.prices.dates.length - 1] ?? null);
  for (let t = 1; t <= n; t++) {
    const prev = calendar[t - 1];
    let total = 0;
    const vals = holdings.map((h, i) => {
      const u = unitsAt(h.steps, prev);
      if (!(u > 0)) return 0;
      const p = onOrBefore(h.prices, prev);
      const ld = lastDate[i];
      if (p == null || !(p > 0) || (ld != null && ld < prev && dayDiff(ld, prev) > STALE_PRICE_DAYS)) {
        staleDays[i]++;
        return 0;
      }
      return u * p;
    });
    for (const v of vals) total += v;
    if (total > 0) vals.forEach((v, i) => (weights[i][t - 1] = v / total));
  }
  return { weights, staleDays };
}

/** A quick, human-checkable summary of a parsed log (for the import preview). */
export function siaSummary(txns: SiaTxn[], splits: SplitTable = SIA_SPLITS) {
  const pos = siaPositions(txns, splits);
  const last = txns[txns.length - 1]?.date ?? null;
  const heldAtEnd = last
    ? pos
        .filter((p) => unitsAt(p.steps, last) > 0)
        .map((p) => p.symbol)
        .sort()
    : [];
  return {
    rows: txns.length,
    first: txns[0]?.date ?? null,
    last,
    symbols: pos.length,
    tradeDays: new Set(txns.map((t) => t.date)).size,
    heldAtEnd,
    resetToZero: pos
      .filter((p) => p.negativeOn.length)
      .map((p) => p.symbol + " (" + p.negativeOn[0] + ")")
      .sort(),
  };
}
