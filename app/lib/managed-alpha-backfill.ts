import { history } from "./holding-history";
import { bucketTests, type BucketStock } from "./sleeve-targets";
import { sameSymbol } from "./model-staging";
import type { PimDailyReturn, PimModelData, PimPerformanceData, PimPortfolioState } from "./pim-types";

/**
 * Managed Alpha backfill (Nov 2026) — PLAN ONLY, this file writes nothing.
 *
 * The Managed Alpha series (stored as pim|thematic) started at 100 on the day
 * the bucket was added to the dashboard; the funds were actually held from
 * the 2026-10-21 rebalance. This rebuilds the missing stretch from the PIM
 * model's Managed Alpha weights and price history (adjusted closes / FUNDSERV
 * NAVs, USD names converted at USD/CAD — the daily engine's own basis):
 *
 *   • Base = the close of `from`. Holdings held then start at their model
 *     weights (renormalised) and DRIFT with prices, like the weights engine.
 *   • A holding first bought later enters at that day's close: every active
 *     weight is reset to the model weights over the enlarged set.
 *   • The rebuilt stretch is SCALED to meet the existing series at its first
 *     anchored entry, so every stored value on or after that date is
 *     unchanged. Only earlier dates are added (replacing the flat 100
 *     placeholder day), plus that anchor day's own daily return.
 *
 * Optional Total Alpha rebuild: until `alphaCut` the Alpha series held the
 * stocks only. For dates in (from, alphaCut] its daily return becomes
 * stocks × ws + Managed Alpha × wm (ws/wm start at the bucket targets and
 * drift). Values up to `from` are unchanged; later DAILY RETURNS are
 * unchanged and their values are re-chained (shifted by one constant factor).
 *
 * The matching Appendix ledgers get the same entries by date.
 */

export type BackfillOpts = { from: string; alphaCut: string; rebuildAlpha: boolean; entryOverrides: Record<string, string>; exclude: string[] };
type Ledger = { profile: string; entries: { date: string; value: number; dailyReturn: number; addedAt?: string }[] };
export type AppendixBlob = { ledgers: Ledger[] } & Record<string, unknown>;

const r4 = (n: number) => parseFloat(n.toFixed(4));
const etDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fxHistory(sinceIso: string): Promise<{ dates: string[]; adj: number[] }> {
  const p1 = Math.floor(new Date(sinceIso).getTime() / 1000) - 10 * 86_400;
  const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/USDCAD%3DX?period1=${p1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { cache: "no-store", headers: { "User-Agent": UA } });
  if (!res.ok) return { dates: [], adj: [] };
  const r = (await res.json())?.chart?.result?.[0];
  const off: number = typeof r?.meta?.gmtoffset === "number" ? r.meta.gmtoffset : 0;
  const ts: number[] = r?.timestamp ?? [];
  const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const m = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) if (typeof cl[i] === "number" && cl[i]! > 0) m.set(new Date((ts[i] + off) * 1000).toISOString().slice(0, 10), cl[i]!);
  const dates = [...m.keys()].sort();
  return { dates, adj: dates.map((d) => m.get(d)!) };
}
const onOrBefore = (s: { dates: string[]; adj: number[] }, date: string): number | null => {
  let v: number | null = null;
  for (let i = 0; i < s.dates.length && s.dates[i] <= date; i++) v = s.adj[i];
  return v;
};

export type BackfillPlan = {
  ok: boolean;
  refuse?: string;
  notes: string[];
  holdings: { symbol: string; name: string; currency: string; modelWeightInClass: number; shareOfManagedAlpha: number; firstBuyOnFile: string | null; entersOn: string; pricesFound: number; returnOverWindowPct: number | null }[];
  window?: { base: string; anchor: string; days: number };
  managedAlpha?: { rebuiltReturnPct: number; scale: number; added: PimDailyReturn[]; anchorBefore: PimDailyReturn; anchorAfter: PimDailyReturn; unchangedFrom: string };
  totalAlpha?: { cut: string; startWeights: { stocks: number; managedAlpha: number }; windowReturnBeforePct: number; windowReturnAfterPct: number; levelFactorAfterCut: number; lastValueBefore: number; lastValueAfter: number; changed: { date: string; before: PimDailyReturn; after: PimDailyReturn }[] };
  next?: { perf: PimPerformanceData; appendix: AppendixBlob | null };
};

export async function planManagedAlphaBackfill(
  input: { models: PimModelData; stocks: BucketStock[]; perf: PimPerformanceData; appendix: AppendixBlob | null; state: PimPortfolioState | null },
  opts: BackfillOpts,
): Promise<BackfillPlan> {
  const notes: string[] = [];
  const plan: BackfillPlan = { ok: false, notes, holdings: [] };
  const refuse = (why: string) => ({ ...plan, refuse: why });
  const { models, stocks, perf, appendix, state } = input;

  const pim = models.groups.find((g) => g.id === "pim");
  if (!pim) return refuse("no PIM group in pm:pim-models");
  const series = (p: string) => perf.models.find((m) => m.groupId === "pim" && m.profile === p);
  const T = series("thematic");
  const core = series("core");
  if (!T || T.history.length < 1) return refuse("no Managed Alpha (pim|thematic) series on file");
  if (!core) return refuse("no Core series on file (it supplies the trading calendar)");

  // The existing series: a flat placeholder up to its first anchored entry.
  const aIdx = T.history.findIndex((e) => e.anchored);
  if (aIdx < 0) return refuse("the Managed Alpha series has no anchored start entry — not the shape this tool expects");
  const anchor = T.history[aIdx];
  if (anchor.date <= opts.from) return refuse(`the Managed Alpha series already starts on or before ${opts.from}`);
  const placeholder = T.history.slice(0, aIdx);
  if (Math.abs(anchor.dailyReturn) > 1e-9 || placeholder.some((e) => Math.abs(e.dailyReturn) > 1e-9 || Math.abs(e.value - anchor.value) > 1e-9))
    return refuse(`entries on or before ${anchor.date} are not a flat placeholder — the series already has real history there (already backfilled?)`);

  // Trading calendar from the Core series: base = last Core date on/before `from`.
  const coreDates = core.history.map((e) => e.date);
  const base = [...coreDates].reverse().find((d) => d <= opts.from);
  if (!base) return refuse(`the Core series has no date on or before ${opts.from}`);
  if (base !== opts.from) notes.push(`${opts.from} is not in the Core series; using the ${base} close as the base`);
  if (!coreDates.includes(anchor.date)) return refuse(`the anchor date ${anchor.date} is not in the Core series calendar`);
  const cal = coreDates.filter((d) => d > base && d <= anchor.date);

  // Managed Alpha holdings (the model's bucket first, pm:stocks designation as fallback).
  const tests = bucketTests(stocks, models);
  const excluded = (s: string) => opts.exclude.some((x) => sameSymbol(x, s));
  const held = pim.holdings.filter((h) => h.assetClass === "equity" && tests.isThematic(h.symbol) && h.weightInClass > 0 && !excluded(h.symbol));
  if (!held.length) return refuse("no Managed Alpha holdings in the PIM model");
  const totalW = held.reduce((s, h) => s + h.weightInClass, 0);
  const txns = state?.groupStates.find((g) => g.groupId === "pim")?.transactions ?? [];

  const [fx, ...hist] = await Promise.all([fxHistory(base), ...held.map((h) => history(h.symbol, base))]);
  const needsFx = held.some((h) => h.currency === "USD");
  if (needsFx && fx.dates.length < 5) return refuse("could not load USD/CAD history");
  const priceCad = (i: number, d: string): number | null => {
    const p = onOrBefore(hist[i], d);
    if (p == null) return null;
    if (held[i].currency !== "USD") return p;
    const f = onOrBefore(fx, d);
    return f == null ? null : p * f;
  };

  const entry = held.map((h) => {
    const override = Object.entries(opts.entryOverrides).find(([k]) => sameSymbol(k, h.symbol))?.[1];
    const firstBuy = txns.filter((t) => t.direction === "buy" && sameSymbol(t.symbol, h.symbol)).map((t) => etDay(t.date)).sort()[0] ?? null;
    const raw = override ?? (firstBuy && firstBuy > base ? firstBuy : base);
    // Snap to the calendar: enters at the close of the first trading day on/after its date.
    const snapped = raw <= base ? base : cal.find((d) => d >= raw) ?? null;
    return { firstBuy, entersOn: snapped, override: !!override };
  });
  for (let i = 0; i < held.length; i++) {
    if (!entry[i].entersOn) notes.push(`${held[i].symbol} was first bought after ${anchor.date}; it is not part of the rebuilt stretch`);
    if (hist[i].dates.filter((d) => d >= base && d <= anchor.date).length < 2 && entry[i].entersOn) return refuse(`no price history for ${held[i].symbol} between ${base} and ${anchor.date}`);
    if (entry[i].entersOn && priceCad(i, entry[i].entersOn!) == null) return refuse(`no price for ${held[i].symbol} on ${entry[i].entersOn}`);
  }

  // Simulate: weights reset to model weights whenever the active set changes, drift otherwise.
  const modelW = (active: number[]) => {
    const t = active.reduce((s, i) => s + held[i].weightInClass, 0);
    const w = new Array(held.length).fill(0);
    for (const i of active) w[i] = held[i].weightInClass / t;
    return w as number[];
  };
  let active = held.map((_, i) => i).filter((i) => entry[i].entersOn === base);
  let w = active.length ? modelW(active) : (new Array(held.length).fill(0) as number[]);
  let level = 1;
  let prev = base;
  const sim: { date: string; ret: number; level: number; live: boolean }[] = [{ date: base, ret: 0, level: 1, live: active.length > 0 }];
  for (const d of cal) {
    let r = 0;
    const ri = new Array(held.length).fill(0) as number[];
    for (const i of active) {
      const a = priceCad(i, prev);
      const b = priceCad(i, d);
      ri[i] = a && b ? b / a - 1 : 0;
      r += w[i] * ri[i];
    }
    level *= 1 + r;
    if (active.length) for (const i of active) w[i] = (w[i] * (1 + ri[i])) / (1 + r);
    const joining = held.map((_, i) => i).filter((i) => entry[i].entersOn === d);
    if (joining.length) {
      active = [...active, ...joining];
      w = modelW(active);
      notes.push(`${joining.map((i) => held[i].symbol).join(", ")} enter${joining.length === 1 ? "s" : ""} at the ${d} close; weights reset to the model weights across ${active.length} holdings`);
    }
    sim.push({ date: d, ret: r, level, live: active.length > 0 });
    prev = d;
  }
  const firstLive = sim.find((s) => s.live);
  if (!firstLive) return refuse("no Managed Alpha holding was held before the series' start date");
  if (firstLive.date !== base) notes.push(`no Managed Alpha holding was held on ${base}; the rebuilt series starts at the ${firstLive.date} close`);

  plan.holdings = held.map((h, i) => {
    const a = entry[i].entersOn ? priceCad(i, entry[i].entersOn!) : null;
    const b = priceCad(i, anchor.date);
    return {
      symbol: h.symbol, name: h.name, currency: h.currency, modelWeightInClass: r4(h.weightInClass), shareOfManagedAlpha: r4(h.weightInClass / totalW),
      firstBuyOnFile: entry[i].firstBuy, entersOn: entry[i].entersOn ?? `after ${anchor.date}`,
      pricesFound: hist[i].dates.filter((d) => d >= base && d <= anchor.date).length,
      returnOverWindowPct: a && b ? r4((b / a - 1) * 100) : null,
    };
  });
  plan.window = { base, anchor: anchor.date, days: cal.length };

  // Splice: scale the rebuilt stretch to meet the stored anchor value.
  const end = sim[sim.length - 1];
  const scale = anchor.value / end.level;
  const liveSim = sim.filter((s) => s.date >= firstLive.date);
  const added: PimDailyReturn[] = liveSim.slice(0, -1).map((s, i) => ({ date: s.date, value: r4(s.level * scale), dailyReturn: i === 0 ? 0 : r4(s.ret * 100) }));
  const anchorAfter: PimDailyReturn = { ...anchor, dailyReturn: r4(end.ret * 100) };
  const nextT = [...added, anchorAfter, ...T.history.slice(aIdx + 1)];
  plan.managedAlpha = { rebuiltReturnPct: r4((end.level / firstLive.level - 1) * 100), scale: r4(scale), added, anchorBefore: anchor, anchorAfter, unchangedFrom: anchor.date };
  notes.push(`Managed Alpha: ${added.length} earlier day(s) added; every stored value from ${anchor.date} on is unchanged`);

  const nextModels = perf.models.map((m) => (m === T ? { ...m, history: nextT } : m));
  const changedSeries = new Map<string, PimDailyReturn[]>([["thematic", nextT]]);

  // Optional: Total Alpha (stocks only until the cut) → stocks + Managed Alpha over (base, cut].
  if (opts.rebuildAlpha) {
    const A = series("alpha");
    // Split between stocks and Managed Alpha: the bucket targets when the
    // model carries them, else the PIM model's own equity weights today.
    const st = models.sleeveTargets;
    const stockW = pim.holdings.filter((h) => h.assetClass === "equity" && h.weightInClass > 0 && !tests.isCore(h.symbol) && !tests.isThematic(h.symbol)).reduce((s, h) => s + h.weightInClass, 0);
    const fromTargets = !!st && st.alpha > 0 && st.thematic > 0;
    const tg = fromTargets ? { alpha: st!.alpha, thematic: st!.thematic } : { alpha: stockW, thematic: totalW };
    if (A && tg.alpha > 0 && tg.thematic > 0) notes.push(`Total Alpha split taken from ${fromTargets ? "the model's bucket targets" : "the PIM model's current equity weights (no bucket targets stored)"}: stocks ${r4(tg.alpha * 100)}% + Managed Alpha ${r4(tg.thematic * 100)}% of equity`);
    if (!A) notes.push("Total Alpha NOT rebuilt: no Alpha series on file");
    else if (!(tg.alpha > 0) || !(tg.thematic > 0)) notes.push("Total Alpha NOT rebuilt: the PIM model has no stock weight or no Managed Alpha weight to split by");
    else if (!A.history.some((e) => e.date === base)) notes.push(`Total Alpha NOT rebuilt: the Alpha series has no ${base} entry`);
    else {
      const mRet = new Map<string, number>(sim.map((s) => [s.date, s.live ? s.ret : NaN]));
      // After the Managed Alpha anchor the stored series supplies its own daily returns.
      for (const e of T.history.slice(aIdx + 1)) mRet.set(e.date, e.dailyReturn / 100);
      let ws = tg.alpha / (tg.alpha + tg.thematic);
      let wm = 1 - ws;
      const start = { stocks: r4(ws), managedAlpha: r4(wm) };
      const changed: { date: string; before: PimDailyReturn; after: PimDailyReturn }[] = [];
      let prevVal = A.history.find((e) => e.date === base)!.value;
      let factor = 1; // rebuilt level ÷ stored level, fixed once the cut is passed
      const nextA = A.history.map((e) => {
        if (e.date <= base) return e;
        // After the cut: the stored daily return stands; the value moves by one constant factor.
        if (e.date > opts.alphaCut) return factor === 1 ? e : { ...e, value: r4(e.value * factor) };
        let ret = e.dailyReturn / 100;
        const m = mRet.get(e.date);
        if (m != null && !Number.isNaN(m)) {
          const s = ret;
          ret = ws * s + wm * m;
          const ns = ws * (1 + s);
          const nm = wm * (1 + m);
          ws = ns / (ns + nm);
          wm = 1 - ws;
        }
        prevVal = prevVal * (1 + ret);
        factor = prevVal / e.value;
        const after: PimDailyReturn = { ...e, value: r4(prevVal), dailyReturn: r4(ret * 100) };
        changed.push({ date: e.date, before: e, after });
        return after;
      });
      const baseVal = A.history.find((e) => e.date === base)!.value;
      const cutBefore = [...A.history].reverse().find((e) => e.date <= opts.alphaCut)!;
      const cutAfter = [...nextA].reverse().find((e) => e.date <= opts.alphaCut)!;
      const lastB = A.history[A.history.length - 1];
      const lastA = nextA[nextA.length - 1];
      plan.totalAlpha = {
        cut: opts.alphaCut, startWeights: start,
        windowReturnBeforePct: r4((cutBefore.value / baseVal - 1) * 100), windowReturnAfterPct: r4((cutAfter.value / baseVal - 1) * 100),
        levelFactorAfterCut: parseFloat((cutAfter.value / cutBefore.value).toFixed(6)), lastValueBefore: lastB.value, lastValueAfter: lastA.value, changed,
      };
      const iA = nextModels.findIndex((m) => m.groupId === "pim" && m.profile === "alpha");
      nextModels[iA] = { ...nextModels[iA], history: nextA };
      changedSeries.set("alpha", nextA);
      notes.push(`Total Alpha: daily returns for ${changed.length} day(s) through ${opts.alphaCut} now include Managed Alpha; values to ${base} unchanged; later daily returns unchanged, values re-chained`);
    }
  }

  // Appendix ledgers: the same entries, by date (existing addedAt kept).
  let nextAppendix: AppendixBlob | null = null;
  if (appendix && Array.isArray(appendix.ledgers)) {
    const now = new Date().toISOString();
    nextAppendix = {
      ...appendix,
      ledgers: appendix.ledgers.map((l) => {
        const s = changedSeries.get(l.profile);
        if (!s) return l;
        const byDate = new Map(l.entries.map((e) => [e.date, e]));
        if (l.profile === "thematic") {
          // Rebuilt stretch replaces the placeholder day(s); later ledger days untouched.
          const kept = l.entries.filter((e) => e.date > anchor.date);
          const head = s.filter((e) => e.date <= anchor.date).map((e) => ({ date: e.date, value: e.value, dailyReturn: e.dailyReturn, addedAt: byDate.get(e.date)?.addedAt ?? now }));
          return { ...l, entries: [...head, ...kept] };
        }
        const sBy = new Map(s.map((e) => [e.date, e]));
        return { ...l, entries: l.entries.map((e) => (e.date > base && sBy.has(e.date) ? { ...e, value: sBy.get(e.date)!.value, dailyReturn: sBy.get(e.date)!.dailyReturn } : e)) };
      }),
    };
  } else notes.push("no Appendix ledgers on file — only the performance series would be written");

  plan.ok = true;
  plan.next = { perf: { ...perf, models: nextModels }, appendix: nextAppendix };
  return plan;
}
