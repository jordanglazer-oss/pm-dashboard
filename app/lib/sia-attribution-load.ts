import { getRedis } from "./redis";
import { history } from "./holding-history";
import { sameSymbol } from "./model-staging";
import { bucketTests, type BucketStock } from "./sleeve-targets";
import type { PimModelData, PimPerformanceData } from "./pim-types";
import { checkByMonth, computeRangeAttribution, seriesReturnPct, SLEEVE_LABELS, type HoldingInput, type Sleeve } from "./range-attribution";
import { fxHistory, guessCurrency, type RangeAttributionResponse } from "./range-attribution-load";
import { actualWeights, mergeSplits, mergedPrices, siaPositions, unitsAt, type PricePoints } from "./sia-holdings";
import { unpackTxns, type SiaStore } from "./sia-store";

/**
 * "Contribution by holding" from the SIA transaction log (Nov 2026) —
 * READ-ONLY. The same response shape as the trade-log version in
 * range-attribution-load.ts, but each holding's weight is its ACTUAL weight
 * every day: units held (from the log) × C$ price ÷ the book's value. So
 * weights drift with prices as the real book did, names bought and sold are
 * dated by the real trades, and there is no "before the log starts" gap back
 * to the log's first day (2018).
 *
 * Reads pm:pim-models, pm:stocks and pm:pim-performance (for the calendar and
 * the recorded returns it is compared with) and the SIA log passed in.
 * Writes NOTHING — in particular it never touches a performance series.
 */

const r4 = (n: number) => parseFloat(n.toFixed(4));
const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const isFundCode = (s: string) => /^[A-Z]{2,4}\d{2,5}[A-Z]?$/i.test(s);
const onOrBefore = (p: PricePoints, d: string): number | null => {
  let v: number | null = null;
  for (let i = 0; i < p.dates.length && p.dates[i] <= d; i++) v = p.adj[i];
  return v;
};

export async function loadSiaRangeAttribution(from: string | null, to: string, store: SiaStore): Promise<RangeAttributionResponse> {
  const redis = await getRedis();
  const [modelsRaw, stocksRaw, perfRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get("pm:pim-performance")]);
  const models = parse<PimModelData | null>(modelsRaw, null);
  const perf = parse<PimPerformanceData | null>(perfRaw, null);
  const stocksParsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(stocksParsed) ? stocksParsed : []) as (BucketStock & { name?: string; instrumentType?: string })[];
  const pim = models?.groups?.find((g) => g.id === "pim");
  if (!models || !pim) return { ok: false, error: "The PIM model could not be read." };

  const series = (p: string) => perf?.models?.find((m) => m.groupId === "pim" && m.profile === p)?.history ?? [];
  const dates = series("allEquity").map((e) => e.date);
  const end = [...dates].reverse().find((d) => d <= to);
  if (!end) return { ok: false, error: "No performance history on or before that end date." };
  const before = from ? [...dates].reverse().find((d) => d < from) : undefined;
  const requestedBase = before ?? dates[0];
  // The log is the only source of holdings, so the detail cannot start before its first trade.
  const base = requestedBase < store.first ? (dates.find((d) => d >= store.first) ?? requestedBase) : requestedBase;
  const partial = (!!from && !before) || base !== requestedBase;
  const calendar = dates.filter((d) => d >= base && d <= end);
  if (calendar.length < 2) return { ok: false, error: "Not enough trading days in that range." };

  const positions = siaPositions(unpackTxns(store.txns), mergeSplits(store.splits));
  const held = positions.filter((p) => calendar.slice(0, -1).some((d) => unitsAt(p.steps, d) > 0));
  if (!held.length) return { ok: false, error: "The SIA log shows no holdings in that range." };

  const tests = bucketTests(stocks, models);
  const info = held.map((p) => {
    const inModel = pim.holdings.find((h) => sameSymbol(h.symbol, p.symbol));
    const rec = stocks.find((s) => s.ticker && sameSymbol(s.ticker, p.symbol));
    const known = !!inModel || !!rec;
    const sleeve: Sleeve = tests.isCore(p.symbol) ? "core" : tests.isThematic(p.symbol) || isFundCode(p.symbol) || rec?.instrumentType === "mutual-fund" ? "thematic" : "stocks";
    const currency = (inModel?.currency ?? guessCurrency(p.symbol)) as "CAD" | "USD";
    return { name: inModel?.name ?? rec?.name, sleeve, currency, known };
  });

  // Prices: market history in C$ (US-dollar names converted day by day), with
  // the log's own C$ trade prices where the market series has nothing.
  const fxPromise = fxHistory(base);
  const market: PricePoints[] = new Array(held.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= held.length) return;
        const h = await history(held[i].symbol, base);
        market[i] = { dates: h.dates, adj: h.adj };
      }
    }),
  );
  const fx = await fxPromise;
  if (info.some((x) => x.currency === "USD") && fx.dates.length < 2) return { ok: false, error: "Could not load USD/CAD history, so US-dollar holdings cannot be converted. Try again." };
  const prices: PricePoints[] = held.map((p, i) => {
    const m = market[i] ?? { dates: [], adj: [] };
    if (info[i].currency !== "USD") return mergedPrices(m, p.tradePrices);
    const d: string[] = [];
    const a: number[] = [];
    m.dates.forEach((day, k) => {
      const f = onOrBefore(fx, day);
      if (f && f > 0) {
        d.push(day);
        a.push(m.adj[k] * f);
      }
    });
    return mergedPrices({ dates: d, adj: a }, p.tradePrices);
  });

  const { weights, staleDays } = actualWeights(calendar, held.map((p, i) => ({ steps: p.steps, prices: prices[i] })));
  const inputs: HoldingInput[] = held.map((p, i) => {
    const notes: string[] = [];
    if (staleDays[i] > 0) notes.push("no price for " + staleDays[i] + " day(s) it is shown as held in the log (delisted or merged) — left out on those days");
    if (!(market[i]?.dates.length > 0)) notes.push("no market price history — valued at the log's own trade prices");
    if (!info[i].known) notes.push("not in the dashboard's stock list — sleeve and currency taken from the ticker");
    if (p.negativeOn.some((d) => d >= calendar[0] && d <= end)) notes.push("the log's unit count went below zero in this period (a corporate action not on file) and was reset to zero");
    // Prices are already in C$, so the maths must not convert them again.
    return { symbol: p.symbol, ...(info[i].name ? { name: info[i].name } : {}), sleeve: info[i].sleeve, currency: "CAD" as const, steps: [], dailyWeights: weights[i], prices: prices[i], notes };
  });

  const result = computeRangeAttribution(calendar, inputs, null);
  const leftOut = held.filter((_, i) => staleDays[i] >= calendar.length - 1).map((p) => p.symbol);

  const caveats: string[] = [];
  caveats.push("Holdings and weights come from the SIA transaction log (" + store.first + " to " + store.last + "): each day's weight is the units actually held × the C$ price ÷ the book's value, so weights move with prices as the real book did.");
  if (end > store.last) caveats.push("The SIA log ends on " + store.last + ". Holdings are assumed unchanged since then — load a newer export after any later trade.");
  if (base !== requestedBase) caveats.push("The SIA log starts on " + store.first + ", so the holding detail begins there.");
  if (leftOut.length) caveats.push("Left out, because the log still shows them as held but no price exists (delisted or merged away): " + leftOut.join(", ") + ".");
  const unknown = held.filter((_, i) => !info[i].known && staleDays[i] < calendar.length - 1).map((p) => p.symbol);
  if (unknown.length) caveats.push("Not in the dashboard's stock list, so counted as Individual Stocks unless the ticker is a fund code: " + unknown.join(", ") + ".");
  caveats.push("Returns are C$ total returns from adjusted closes (dividends included); US-dollar names are converted with each day's USD/CAD; mutual funds use their daily NAV. Reinvested fund distributions are not in the log, so a fund's unit count can be slightly low.");
  caveats.push("The comparison columns show the dashboard's own performance record. That record is built from the dashboard's position books, not from this log, so the two can differ; nothing here changes the record.");

  const rec = (p: string) => seriesReturnPct(series(p), result.base, result.end);
  const bookRec = rec("allEquity");
  const sleevesRecordedFrom = series("thematic")[0]?.date ?? null;
  const split = !!sleevesRecordedFrom && result.base >= sleevesRecordedFrom;
  const sleeveSeries: Record<Sleeve, string> = { core: "core", thematic: "thematic", stocks: "stocks" };
  const ncRec = rec("alpha");
  const { daily: _daily, ...rest } = result;
  void _daily;
  return {
    ok: true,
    range: { from, to, base: result.base, end: result.end, days: result.days, partial },
    method: "Actual holdings from the SIA transaction log: each holding's real weight × its daily C$ total return, linked day by day so the contributions add up to the book return they imply.",
    caveats,
    reconciliation: {
      book: { label: "PIM equity book (All-Equity model)", estimatedPct: result.estimatedReturnPct, recordedPct: bookRec, differencePts: bookRec == null ? null : r4(result.estimatedReturnPct - bookRec) },
      sleeves: result.sleeves.map((s) => {
        const recorded = s.sleeve === "core" || split ? rec(sleeveSeries[s.sleeve]) : null;
        return { sleeve: s.sleeve, label: SLEEVE_LABELS[s.sleeve], estimatedPct: s.returnPct, recordedPct: recorded, differencePts: s.returnPct == null || recorded == null ? null : r4(s.returnPct - recorded) };
      }),
      nonCore: { label: "Total Alpha (Managed Alpha + Individual Stocks)", estimatedPct: result.nonCore.returnPct, recordedPct: ncRec, differencePts: result.nonCore.returnPct == null || ncRec == null ? null : r4(result.nonCore.returnPct - ncRec) },
      sleevesRecordedFrom,
    },
    logStartsOn: store.first,
    full: { base: requestedBase, end, days: dates.filter((d) => d >= requestedBase && d <= end).length - 1, recordedPct: seriesReturnPct(series("allEquity"), requestedBase, end) },
    detailFrom: base !== requestedBase ? base : null,
    byMonth: checkByMonth(result.base, result.daily, (p) => new Map(series(p).map((e) => [e.date, e.value]))),
    source: "sia",
    sia: { first: store.first, through: store.last, importedAt: store.importedAt, leftOut },
    siaAvailable: true,
    builtAt: new Date().toISOString(),
    ...rest,
  };
}
