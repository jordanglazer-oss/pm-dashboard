/**
 * Contribution by holding over ANY date range (Nov 2026) — the pure maths.
 * No I/O here; `range-attribution-load.ts` reads the data and calls this.
 *
 * The book is the PIM group's EQUITY class (the All-Equity model). For each
 * trading day:   contribution = weight in effect × that day's C$ total return
 * and the daily contributions are linked through the book's own growth, so
 * the holdings' contributions ADD UP EXACTLY to the estimated book return
 * for the range (no unexplained residual inside the estimate).
 *
 * Weights are TIME-VARYING: a step schedule per holding built from the trade
 * log — a holding's weight changes at the close of the day its target
 * changed, is zero before it was bought and after it was sold. Between two
 * changes the weight is HELD AT ITS TARGET (it does not drift with prices),
 * which is the main approximation and why the result is labelled a
 * model-level estimate and reconciled against the recorded series.
 */

export type Sleeve = "core" | "thematic" | "stocks";
export const SLEEVE_LABELS: Record<Sleeve, string> = { core: "Core", thematic: "Managed Alpha", stocks: "Individual Stocks" };

export type PriceSeries = { dates: string[]; adj: number[] };
/** `weight` (fraction of the equity class) applies to the returns of every day AFTER `from`. */
export type WeightStep = { from: string; weight: number };

export type HoldingInput = {
  symbol: string;
  name?: string;
  sleeve: Sleeve;
  currency: "CAD" | "USD";
  steps: WeightStep[];
  /** When present, the ACTUAL weight for the return of calendar[t] at index t-1 (from real units); `steps` is then ignored. */
  dailyWeights?: number[];
  prices: PriceSeries;
  /** Plain-language notes on how this holding's weights were derived. */
  notes?: string[];
};

export type HoldingContribution = {
  symbol: string;
  name?: string;
  sleeve: Sleeve;
  currency: "CAD" | "USD";
  /** Percentage points of the book's return over the range. */
  contributionPct: number;
  /** Average weight over the days it was held, % of the equity class. */
  avgWeightPct: number;
  /** C$ total return over the days it was held, %. */
  returnPct: number | null;
  daysHeld: number;
  heldFrom: string | null;
  heldTo: string | null;
  /** held = still held at the end of the range; closed = sold inside it. */
  status: "held" | "closed";
  openedInRange: boolean;
  /** Days it had a weight but no price — counted as a 0% day. */
  missingPriceDays: number;
  notes: string[];
};

export type SleeveTotal = { sleeve: Sleeve; label: string; contributionPct: number; avgWeightPct: number; returnPct: number | null; holdings: number };

export type RangeAttribution = {
  base: string;
  end: string;
  days: number;
  /** Compounded Σ weight × return — what the contributions add up to. */
  estimatedReturnPct: number;
  /** Average of the daily sum of weights on file (100 = fully accounted for). */
  avgWeightCoveredPct: number;
  holdings: HoldingContribution[];
  sleeves: SleeveTotal[];
  /** Each day's estimated return (fractions) for the book, Core and everything outside Core — for a month-by-month check against the record. */
  daily: { date: string; book: number; core: number | null; nonCore: number | null }[];
  /** Managed Alpha + Individual Stocks together (= the recorded Total Alpha book). */
  nonCore: { contributionPct: number; avgWeightPct: number; returnPct: number | null };
  top: HoldingContribution[];
  bottom: HoldingContribution[];
};

const r4 = (n: number) => parseFloat(n.toFixed(4));
const START = "0000-00-00";

/** Last value on or before `date`; null when the series starts later. */
export function onOrBefore(s: PriceSeries, date: string): number | null {
  let v: number | null = null;
  for (let i = 0; i < s.dates.length && s.dates[i] <= date; i++) v = s.adj[i];
  return v;
}

/** The weight in effect for the return of the day AFTER `prev`. */
export function weightAt(steps: WeightStep[], prev: string): number {
  let w = 0;
  for (const s of steps) if (s.from <= prev) w = s.weight;
  return w > 0 ? w : 0;
}

/**
 * One event from the trade log, as the schedule needs it.
 *   rebalance — the log carries the holding's model weight after the trade
 *               (`weight`, already converted to a fraction of the equity class).
 *   trade     — a buy / sell / switch, where the log carries only the weight
 *               that MOVED (`moved`): the weight sold, or the weight a switch
 *               transferred into the name bought. 0 = not on file (a plain buy).
 */
export type TradeEvent =
  | { date: string; kind: "rebalance"; direction: "buy" | "sell"; weight: number }
  | { date: string; kind: "trade"; direction: "buy" | "sell"; moved: number };

/**
 * Turn a holding's trade-log events into a weight schedule.
 *   - A rebalance sets the weight from that day's close.
 *   - A sell lowers it by the weight sold (to zero for a full sale); a switch
 *     raises the name bought by the weight transferred.
 *   - A plain buy carries no weight in the log: the next weight on file for
 *     the name (else today's model weight) is used from the buy date — noted.
 *   - Before the first event the weight is 0 for a name first BOUGHT in the
 *     log; a name held before the log begins (held at the tracking start, or
 *     whose first event is a sale) starts at the earliest weight that can be
 *     inferred — noted as an assumption.
 */
export function scheduleFromTrades(events: TradeEvent[], opts: { currentWeight: number | null; heldAtTrackingStart: boolean }): { steps: WeightStep[]; notes: string[] } {
  const notes: string[] = [];
  const ev = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i)
    .map((x) => x.e);
  const steps: WeightStep[] = [];
  const current = opts.currentWeight && opts.currentWeight > 0 ? opts.currentWeight : null;
  if (!ev.length) {
    if (current) {
      steps.push({ from: START, weight: current });
      notes.push("no trades on file — today's model weight used for the whole period");
    }
    return { steps, notes };
  }
  const nextKnown = (from: number): number | null => {
    for (let j = from; j < ev.length; j++) {
      const x = ev[j];
      if (x.kind === "rebalance" && x.weight > 0) return x.weight;
    }
    return current;
  };
  const first = ev[0];
  let w: number | null = 0;
  if (opts.heldAtTrackingStart || first.direction === "sell") {
    if (first.kind === "trade" && first.direction === "sell" && first.moved > 0) {
      // A full sale unless the name is still in the model with nothing bought since.
      const boughtLater = ev.slice(1).some((x) => x.direction === "buy");
      w = current && !boughtLater ? current + first.moved : first.moved;
    } else w = nextKnown(0);
    if (w && w > 0) {
      steps.push({ from: START, weight: w });
      notes.push(`held before its first trade on file (${first.date}) — the weight before then is inferred from that trade`);
    } else {
      w = null;
      notes.push(`held before its first trade on file (${first.date}) but no weight is on file for that time — not counted before then`);
    }
  }
  ev.forEach((e, i) => {
    if (e.kind === "rebalance") w = Math.max(0, e.weight);
    else if (e.direction === "sell") {
      if (e.moved > 0) w = Math.max(0, (w ?? 0) - e.moved);
      else if (i === ev.length - 1 && !current) w = 0;
      else {
        notes.push(`the sale on ${e.date} has no weight on file — weight left unchanged`);
        return;
      }
    } else if (e.moved > 0) w = (w ?? 0) + e.moved;
    else {
      const k = nextKnown(i + 1);
      if (k == null) {
        notes.push(`bought on ${e.date} with no weight on file — not counted from that purchase`);
        return;
      }
      if (w == null || w <= 0) {
        w = k;
        notes.push(`bought on ${e.date} with no weight on file — the next weight on file (${(k * 100).toFixed(2)}%) is used from that date`);
      }
    }
    if (w != null && w < 1e-6) w = 0;
    steps.push({ from: e.date, weight: w ?? 0 });
  });
  return { steps, notes };
}

/** What the WHOLE trade log tells us, beyond one symbol's own rows. */
export type LogContext = {
  /** The first full rebalance in the log — the earliest day the book is known. */
  firstRebalance: string | null;
  /** Every full-rebalance day, ascending. A rebalance lists EVERY holding. */
  rebalanceDates: string[];
  /** The usual weight of a one-for-one switch that day (null when none carries one). */
  switchWeightOn: (date: string) => number | null;
};

/**
 * scheduleFromTrades plus three facts only the whole log can supply (Nov 2026,
 * after the first real-data check showed the estimate +4.5 pts off):
 *
 *  1. (WITHDRAWN) An earlier version treated every name in the log's first
 *     rebalance as held before it. The PM confirmed that is wrong: a "buy"
 *     there was a real first purchase (TPL, PWR), so the row's direction
 *     stands — "sell" = held before, "buy" = bought that day. What was held
 *     BEFORE the log starts is simply not on file, so the loader does not
 *     estimate holdings for those days at all.
 *  2. A switch buy logged with no weight takes that day's usual switch weight.
 *  3. A rebalance lists every holding, so a name that is ABSENT from a later
 *     rebalance had left by then: if its last row is a sale, that sale was a
 *     full one; if it was never sold on file, it is counted until that
 *     rebalance — noted either way.
 */
export function scheduleWithLog(events: TradeEvent[], opts: { currentWeight: number | null; heldAtTrackingStart: boolean }, ctx: LogContext): { steps: WeightStep[]; notes: string[] } {
  const extra: string[] = [];
  const ev = events.map((e) => {
    if (e.kind === "trade" && e.direction === "buy" && !(e.moved > 0)) {
      const w = ctx.switchWeightOn(e.date);
      if (w && w > 0) {
        extra.push(`bought on ${e.date} with no weight on file — that day's usual switch weight (${(w * 100).toFixed(2)}%) is used`);
        return { ...e, moved: w };
      }
    }
    return e;
  });
  const base = scheduleFromTrades(ev, { currentWeight: opts.currentWeight, heldAtTrackingStart: opts.heldAtTrackingStart });
  const steps = base.steps.map((x) => ({ ...x }));
  const notes = [...base.notes];
  const held = !!opts.currentWeight && opts.currentWeight > 0;
  const sorted = [...ev].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  if (!held && last && steps.length) {
    const lastStep = steps[steps.length - 1];
    const nextReb = ctx.rebalanceDates.find((d) => d > last.date);
    if (nextReb && lastStep.weight > 0) {
      if (last.kind === "trade" && last.direction === "sell") {
        lastStep.weight = 0;
        extra.push(`the sale on ${last.date} is treated as a full sale — the name is absent from the ${nextReb} rebalance`);
      } else {
        steps.push({ from: nextReb, weight: 0 });
        extra.push(`left the model before the ${nextReb} rebalance with no sale on file — counted until then`);
      }
    }
  }
  return { steps, notes: [...notes, ...extra] };
}

/**
 * @param calendar trading days, ascending; calendar[0] is the BASE close and
 *                 every later date is a day whose return is attributed.
 * @param fx       USD/CAD closes (C$ per US$); needed when any holding is USD.
 */
export function computeRangeAttribution(calendar: string[], holdings: HoldingInput[], fx: PriceSeries | null): RangeAttribution {
  const n = calendar.length - 1;
  const cad = (h: HoldingInput, d: string): number | null => {
    const p = onOrBefore(h.prices, d);
    if (p == null || !(p > 0)) return null;
    if (h.currency !== "USD") return p;
    const f = fx ? onOrBefore(fx, d) : null;
    return f == null || !(f > 0) ? null : p * f;
  };
  const acc = holdings.map(() => ({ contrib: 0, wSum: 0, days: 0, growth: 1, first: null as string | null, last: null as string | null, missing: 0 }));
  const sleeves: Sleeve[] = ["core", "thematic", "stocks"];
  const sAcc: Record<Sleeve, { growth: number; wSum: number; days: number }> = { core: { growth: 1, wSum: 0, days: 0 }, thematic: { growth: 1, wSum: 0, days: 0 }, stocks: { growth: 1, wSum: 0, days: 0 } };
  const nc = { growth: 1, wSum: 0, days: 0 };
  const daily: RangeAttribution["daily"] = [];
  let G = 1;
  let covered = 0;

  for (let t = 1; t <= n; t++) {
    const prev = calendar[t - 1];
    const d = calendar[t];
    let R = 0;
    let wTotal = 0;
    const sDay: Record<Sleeve, { w: number; wr: number }> = { core: { w: 0, wr: 0 }, thematic: { w: 0, wr: 0 }, stocks: { w: 0, wr: 0 } };
    const dayWr: number[] = [];
    holdings.forEach((h, i) => {
      const w = h.dailyWeights ? (h.dailyWeights[t - 1] ?? 0) : weightAt(h.steps, prev);
      if (!(w > 0)) {
        dayWr.push(0);
        return;
      }
      const p0 = cad(h, prev);
      const p1 = cad(h, d);
      let r = 0;
      if (p0 == null || p1 == null) acc[i].missing++;
      else r = p1 / p0 - 1;
      const a = acc[i];
      a.wSum += w;
      a.days++;
      a.growth *= 1 + r;
      if (!a.first) a.first = d;
      a.last = d;
      dayWr.push(w * r);
      R += w * r;
      wTotal += w;
      sDay[h.sleeve].w += w;
      sDay[h.sleeve].wr += w * r;
    });
    // Link each day's contribution through the book's growth to the prior close.
    dayWr.forEach((wr, i) => (acc[i].contrib += wr * G));
    for (const s of sleeves) {
      if (sDay[s].w > 0) {
        sAcc[s].growth *= 1 + sDay[s].wr / sDay[s].w;
        sAcc[s].wSum += sDay[s].w;
        sAcc[s].days++;
      }
    }
    const ncW = sDay.thematic.w + sDay.stocks.w;
    if (ncW > 0) {
      nc.growth *= 1 + (sDay.thematic.wr + sDay.stocks.wr) / ncW;
      nc.wSum += ncW;
      nc.days++;
    }
    daily.push({ date: d, book: R, core: sDay.core.w > 0 ? sDay.core.wr / sDay.core.w : null, nonCore: ncW > 0 ? (sDay.thematic.wr + sDay.stocks.wr) / ncW : null });
    G *= 1 + R;
    covered += wTotal;
  }

  const end = calendar[n] ?? calendar[0];
  const rows: HoldingContribution[] = holdings
    .map((h, i) => {
      const a = acc[i];
      return {
        symbol: h.symbol,
        ...(h.name ? { name: h.name } : {}),
        sleeve: h.sleeve,
        currency: h.currency,
        contributionPct: r4(a.contrib * 100),
        avgWeightPct: a.days ? r4((a.wSum / a.days) * 100) : 0,
        returnPct: a.days && a.missing < a.days ? r4((a.growth - 1) * 100) : null,
        daysHeld: a.days,
        heldFrom: a.first,
        heldTo: a.last,
        status: ((h.dailyWeights ? (h.dailyWeights[n - 1] ?? 0) : weightAt(h.steps, end)) > 0 ? "held" : "closed") as "held" | "closed",
        openedInRange: !!a.first && a.first !== calendar[1],
        missingPriceDays: a.missing,
        notes: [...(h.notes ?? []), ...(a.missing ? [`no price on ${a.missing} of ${a.days} day(s) — those days counted as 0%`] : [])],
      };
    })
    .filter((r) => r.daysHeld > 0)
    .sort((a, b) => b.contributionPct - a.contributionPct);

  const sleeveTotals: SleeveTotal[] = sleeves.map((s) => {
    const list = rows.filter((r) => r.sleeve === s);
    return {
      sleeve: s,
      label: SLEEVE_LABELS[s],
      contributionPct: r4(list.reduce((x, r) => x + r.contributionPct, 0)),
      avgWeightPct: n > 0 ? r4((sAcc[s].wSum / n) * 100) : 0,
      returnPct: sAcc[s].days ? r4((sAcc[s].growth - 1) * 100) : null,
      holdings: list.length,
    };
  });

  return {
    base: calendar[0],
    end,
    days: Math.max(0, n),
    estimatedReturnPct: r4((G - 1) * 100),
    avgWeightCoveredPct: n > 0 ? r4((covered / n) * 100) : 0,
    holdings: rows,
    sleeves: sleeveTotals,
    daily,
    nonCore: {
      contributionPct: r4(rows.filter((r) => r.sleeve !== "core").reduce((x, r) => x + r.contributionPct, 0)),
      avgWeightPct: n > 0 ? r4((nc.wSum / n) * 100) : 0,
      returnPct: nc.days ? r4((nc.growth - 1) * 100) : null,
    },
    top: rows.filter((r) => r.contributionPct > 0).slice(0, 5),
    bottom: rows.filter((r) => r.contributionPct < 0).slice(-5).reverse(),
  };
}

/** Recorded series return between two closes, %. Null when either date is missing. */
export function seriesReturnPct(history: { date: string; value: number }[] | undefined, base: string, end: string): number | null {
  const b = history?.find((e) => e.date === base);
  const e = history?.find((x) => x.date === end);
  return b && e && b.value > 0 ? r4((e.value / b.value - 1) * 100) : null;
}

export type MonthCheck = { month: string; days: number; book: { est: number; rec: number | null }; core: { est: number | null; rec: number | null }; nonCore: { est: number | null; rec: number | null } };

/**
 * Month by month: the estimate's return beside the recorded series' return
 * over the SAME days, for the book, Core and everything outside Core. Shows
 * WHERE a gap between the rebuild and the record arises. `recorded(profile)`
 * returns that series' date → value map.
 */
export function checkByMonth(base: string, daily: RangeAttribution["daily"], recorded: (profile: "allEquity" | "core" | "alpha") => Map<string, number>): MonthCheck[] {
  const out: MonthCheck[] = [];
  const maps = { allEquity: recorded("allEquity"), core: recorded("core"), alpha: recorded("alpha") };
  let prev = base;
  let cur: { month: string; start: string; end: string; days: number; g: { book: number; core: number; nonCore: number }; has: { core: boolean; nonCore: boolean } } | null = null;
  const flush = () => {
    if (!cur) return;
    const rec = (m: Map<string, number>) => {
      const a = m.get(cur!.start);
      const b = m.get(cur!.end);
      return a && b && a > 0 ? r4((b / a - 1) * 100) : null;
    };
    out.push({
      month: cur.month,
      days: cur.days,
      book: { est: r4((cur.g.book - 1) * 100), rec: rec(maps.allEquity) },
      core: { est: cur.has.core ? r4((cur.g.core - 1) * 100) : null, rec: rec(maps.core) },
      nonCore: { est: cur.has.nonCore ? r4((cur.g.nonCore - 1) * 100) : null, rec: rec(maps.alpha) },
    });
  };
  for (const d of daily) {
    const month = d.date.slice(0, 7);
    if (!cur || cur.month !== month) {
      flush();
      cur = { month, start: prev, end: d.date, days: 0, g: { book: 1, core: 1, nonCore: 1 }, has: { core: false, nonCore: false } };
    }
    cur.end = d.date;
    cur.days++;
    cur.g.book *= 1 + d.book;
    if (d.core != null) {
      cur.g.core *= 1 + d.core;
      cur.has.core = true;
    }
    if (d.nonCore != null) {
      cur.g.nonCore *= 1 + d.nonCore;
      cur.has.nonCore = true;
    }
    prev = d.date;
  }
  flush();
  return out;
}
