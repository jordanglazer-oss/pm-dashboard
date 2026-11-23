import { getRedis } from "./redis";
import { history } from "./holding-history";
import { sameSymbol } from "./model-staging";
import { bucketTests, type BucketStock } from "./sleeve-targets";
import type { PimModelData, PimPerformanceData, PimPortfolioState, PimProfileType, PimTransaction } from "./pim-types";
import { computeRangeAttribution, scheduleFromTrades, seriesReturnPct, weightAt, SLEEVE_LABELS, type HoldingInput, type PriceSeries, type RangeAttribution, type Sleeve, type TradeEvent } from "./range-attribution";

/**
 * Loader for "Contribution by holding" (Nov 2026) — READ-ONLY. Reads
 * pm:pim-models, pm:stocks, pm:pim-portfolio-state and pm:pim-performance,
 * fetches price history (Yahoo adjusted closes; FUNDSERV NAVs; USD/CAD), and
 * hands everything to the pure maths in range-attribution.ts. Writes nothing.
 *
 * Scope: the PIM group's EQUITY class (= the All-Equity model). The trading
 * calendar is the All-Equity performance series' own dates, so the estimate
 * and the recorded series are measured over identical days.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const MAIN: PimProfileType[] = ["allEquity", "growth", "balanced", "conservative"];
const etDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
};
const r4 = (n: number) => parseFloat(n.toFixed(4));
const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** Currency of a name that is no longer in the model, from its listing suffix. */
const guessCurrency = (s: string): "CAD" | "USD" => (/\.U$/i.test(s) ? "USD" : /(-T|\.TO|\.NE|-NE|\.V)$/i.test(s) || /^[A-Z]{2,4}\d{2,5}$/i.test(s) ? "CAD" : "USD");

async function fxHistory(sinceIso: string): Promise<PriceSeries> {
  try {
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
  } catch {
    return { dates: [], adj: [] };
  }
}

/**
 * One symbol's raw transactions → schedule events. A rebalance row carries the
 * holding's weight in ITS profile's portfolio (weightInClass × that profile's
 * equity share), so it is divided back by that share; rows for the sleeve
 * books (core / thematic / alpha / stocks) are relative to those books and are
 * ignored. A buy / sell / switch row carries the weight that MOVED.
 */
export function eventsFromTransactions(txns: PimTransaction[], equityShare: (p: PimProfileType) => number | null): { events: TradeEvent[]; scaledFrom: PimProfileType[] } {
  const byDay = new Map<string, PimTransaction[]>();
  for (const t of txns) {
    const d = etDay(t.date);
    byDay.set(d, [...(byDay.get(d) ?? []), t]);
  }
  const events: TradeEvent[] = [];
  const scaledFrom = new Set<PimProfileType>();
  for (const [date, rows] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const reb = rows.filter((t) => t.type === "rebalance");
    const pick = MAIN.map((p) => reb.find((t) => t.profile === p && equityShare(p))).find(Boolean);
    if (pick && pick.profile) {
      const share = equityShare(pick.profile)!;
      if (pick.profile !== "allEquity") scaledFrom.add(pick.profile);
      events.push({ date, kind: "rebalance", direction: pick.direction, weight: Math.max(0, (pick.targetWeight || 0) / share) });
    }
    for (const t of rows) if (t.type !== "rebalance") events.push({ date, kind: "trade", direction: t.direction, moved: Math.max(0, t.targetWeight || 0) });
  }
  return { events, scaledFrom: [...scaledFrom] };
}

export type RangeAttributionResponse =
  | { ok: false; error: string }
  | ({
      ok: true;
      range: { from: string | null; to: string; base: string; end: string; days: number; partial: boolean };
      method: string;
      caveats: string[];
      reconciliation: {
        book: { label: string; estimatedPct: number; recordedPct: number | null; differencePts: number | null };
        sleeves: { sleeve: Sleeve; label: string; estimatedPct: number | null; recordedPct: number | null; differencePts: number | null }[];
      };
      builtAt: string;
    } & RangeAttribution);

export async function loadRangeAttribution(from: string | null, to: string): Promise<RangeAttributionResponse> {
  const redis = await getRedis();
  const [modelsRaw, stocksRaw, stateRaw, perfRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get("pm:pim-portfolio-state"), redis.get("pm:pim-performance")]);
  const models = parse<PimModelData | null>(modelsRaw, null);
  const perf = parse<PimPerformanceData | null>(perfRaw, null);
  const state = parse<PimPortfolioState | null>(stateRaw, null);
  const stocksParsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(stocksParsed) ? stocksParsed : []) as (BucketStock & { name?: string })[];
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!models || !pim) return { ok: false, error: "The PIM model could not be read." };

  // Calendar = the All-Equity series' own dates (same days as the recorded return).
  const series = (p: string) => perf?.models?.find((m) => m.groupId === "pim" && m.profile === p)?.history ?? [];
  const book = series("allEquity");
  const dates = book.map((e) => e.date);
  const end = [...dates].reverse().find((d) => d <= to);
  if (!end) return { ok: false, error: "No performance history on or before that end date." };
  const before = from ? [...dates].reverse().find((d) => d < from) : undefined;
  const base = before ?? dates[0];
  const partial = !!from && !before;
  const calendar = dates.filter((d) => d >= base && d <= end);
  if (calendar.length < 2) return { ok: false, error: "Not enough trading days in that range." };

  const gs = state?.groupStates?.find((g) => g.groupId === "pim");
  const tsDate = gs?.trackingStart?.date ? etDay(gs.trackingStart.date) : null;
  const tsSymbols = Object.keys(gs?.trackingStart?.prices ?? {});
  const equityShare = (p: PimProfileType) => {
    const e = pim.profiles?.[p]?.equity;
    return typeof e === "number" && e > 0 ? e : null;
  };

  const current = pim.holdings.filter((h) => h.weightInClass > 0);
  const nonEquity = current.filter((h) => h.assetClass !== "equity");
  const groups: { symbol: string; txns: PimTransaction[] }[] = [];
  for (const t of gs?.transactions ?? []) {
    const g = groups.find((x) => sameSymbol(x.symbol, t.symbol));
    if (g) g.txns.push(t);
    else groups.push({ symbol: t.symbol, txns: [t] });
  }
  const symbols: string[] = current.filter((h) => h.assetClass === "equity").map((h) => h.symbol);
  for (const g of groups) if (!symbols.some((s) => sameSymbol(s, g.symbol)) && !nonEquity.some((h) => sameSymbol(h.symbol, g.symbol))) symbols.push(g.symbol);

  const tests = bucketTests(stocks, models);
  const caveats: string[] = [];
  const scaled = new Set<string>();
  const plan = symbols
    .map((symbol) => {
      const held = current.find((h) => sameSymbol(h.symbol, symbol));
      const txns = groups.find((g) => sameSymbol(g.symbol, symbol))?.txns ?? [];
      const { events, scaledFrom } = eventsFromTransactions(txns, equityShare);
      scaledFrom.forEach((p) => scaled.add(p));
      const firstDate = events[0]?.date ?? null;
      const heldAtTrackingStart = !!tsDate && tsSymbols.some((s) => sameSymbol(s, symbol)) && (!firstDate || firstDate > tsDate);
      const { steps, notes } = scheduleFromTrades(events, { currentWeight: held?.weightInClass ?? null, heldAtTrackingStart });
      const sleeve: Sleeve = tests.isCore(symbol) ? "core" : tests.isThematic(symbol) ? "thematic" : "stocks";
      const name = held?.name ?? stocks.find((s) => s.ticker && sameSymbol(s.ticker, symbol))?.name;
      return { symbol, name, sleeve, currency: (held?.currency ?? guessCurrency(symbol)) as "CAD" | "USD", steps, notes };
    })
    // Only names with a weight on at least one day of the range need prices.
    .filter((h) => calendar.slice(0, -1).some((d) => weightAt(h.steps, d) > 0));

  const fxPromise = fxHistory(base);
  const hist: PriceSeries[] = new Array(plan.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= plan.length) return;
        const s = await history(plan[i].symbol, base);
        hist[i] = { dates: s.dates, adj: s.adj };
      }
    }),
  );
  const fx = await fxPromise;
  const inputs: HoldingInput[] = plan.map((h, i) => ({ ...h, prices: hist[i] ?? { dates: [], adj: [] } }));
  if (inputs.some((h) => h.currency === "USD") && fx.dates.length < 2) return { ok: false, error: "Could not load USD/CAD history, so US-dollar holdings cannot be converted. Try again." };

  const result = computeRangeAttribution(calendar, inputs, fx);

  caveats.push("Weights are the model targets on file, changed on the day a trade changed them and held constant in between — they do not drift with prices day to day, so this is an estimate, not the recorded return.");
  if (result.avgWeightCoveredPct < 99 || result.avgWeightCoveredPct > 101) caveats.push(`The weights on file add up to ${result.avgWeightCoveredPct.toFixed(1)}% of the equity book on average over this range (100% would be fully accounted for).`);
  if (scaled.size) caveats.push(`Some rebalances were only logged for the ${[...scaled].join(" / ")} model; those weights were scaled up to the equity book.`);
  const assumed = result.holdings.filter((h) => h.notes.length);
  if (assumed.length) caveats.push(`${assumed.length} holding(s) rest on an assumption about their weight or price (marked in the table): ${assumed.map((h) => h.symbol).join(", ")}.`);
  const closedShown = result.holdings.filter((h) => !current.some((c) => sameSymbol(c.symbol, h.symbol)));
  if (closedShown.length) caveats.push(`Names no longer in the model are included for the days they were held (${closedShown.map((h) => h.symbol).join(", ")}); their sleeve and currency come from the stock list or the ticker, since the model no longer carries them.`);
  if (partial) caveats.push(`The performance series starts on ${base}, after the requested start date, so the range begins there.`);
  caveats.push("Returns are C$ total returns from adjusted closes (dividends included); mutual funds use their daily NAV, and a NAV not yet posted counts as 0% until it is.");

  const rec = (p: string) => seriesReturnPct(series(p), result.base, result.end);
  const bookRec = rec("allEquity");
  const sleeveSeries: Record<Sleeve, string> = { core: "core", thematic: "thematic", stocks: "stocks" };
  return {
    ok: true,
    range: { from, to, base: result.base, end: result.end, days: result.days, partial },
    method: "Model-level estimate: each holding's weight in the PIM equity book × its daily C$ total return, linked day by day so the contributions add up to the estimated book return.",
    caveats,
    reconciliation: {
      book: { label: "PIM equity book (All-Equity model)", estimatedPct: result.estimatedReturnPct, recordedPct: bookRec, differencePts: bookRec == null ? null : r4(result.estimatedReturnPct - bookRec) },
      sleeves: result.sleeves.map((s) => {
        const recorded = rec(sleeveSeries[s.sleeve]);
        return { sleeve: s.sleeve, label: SLEEVE_LABELS[s.sleeve], estimatedPct: s.returnPct, recordedPct: recorded, differencePts: s.returnPct == null || recorded == null ? null : r4(s.returnPct - recorded) };
      }),
    },
    builtAt: new Date().toISOString(),
    ...result,
  };
}
