import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { sameSymbol } from "@/app/lib/model-staging";
import { eventsFromTransactions } from "@/app/lib/range-attribution-load";
import { scheduleFromTrades } from "@/app/lib/range-attribution";
import type { PimModelData, PimPerformanceData, PimPortfolioState, PimProfileType, PimTransaction } from "@/app/lib/pim-types";

/**
 * GET /api/attribution/range/debug — READ-ONLY diagnostic for "Contribution by
 * holding": the raw PIM trade-log rows per symbol (compact), the weight
 * schedule the estimate builds from them, and the span of each recorded
 * series. Fetches no prices and writes nothing. Exists so a gap between the
 * estimate and the recorded return can be traced to the rows that cause it.
 */

export const dynamic = "force-dynamic";

const etDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
};
const r5 = (n: number) => parseFloat((n || 0).toFixed(5));

export async function GET() {
  try {
    const redis = await getRedis();
    const [modelsRaw, stateRaw, perfRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:pim-portfolio-state"), redis.get("pm:pim-performance")]);
    const models = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData) : null;
    const state = stateRaw ? (JSON.parse(stateRaw) as PimPortfolioState) : null;
    const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
    const pim = models?.groups?.find((g) => g.id === "pim");
    if (!pim) return NextResponse.json({ ok: false, error: "The PIM model could not be read." }, { status: 409 });
    const gs = state?.groupStates?.find((g) => g.groupId === "pim");
    const equityShare = (p: PimProfileType) => {
      const e = pim.profiles?.[p]?.equity;
      return typeof e === "number" && e > 0 ? e : null;
    };
    const tsDate = gs?.trackingStart?.date ? etDay(gs.trackingStart.date) : null;
    const tsSymbols = Object.keys(gs?.trackingStart?.prices ?? {});

    const groups: { symbol: string; txns: PimTransaction[] }[] = [];
    for (const t of gs?.transactions ?? []) {
      const g = groups.find((x) => sameSymbol(x.symbol, t.symbol));
      if (g) g.txns.push(t);
      else groups.push({ symbol: t.symbol, txns: [t] });
    }
    const symbols = [...pim.holdings.filter((h) => h.assetClass === "equity" && h.weightInClass > 0).map((h) => h.symbol)];
    for (const g of groups) if (!symbols.some((s) => sameSymbol(s, g.symbol))) symbols.push(g.symbol);

    const typeCounts: Record<string, number> = {};
    for (const t of gs?.transactions ?? []) {
      const k = `${t.type}|${t.profile ?? "no-profile"}`;
      typeCounts[k] = (typeCounts[k] ?? 0) + 1;
    }

    const holdings = symbols.map((symbol) => {
      const held = pim.holdings.find((h) => sameSymbol(h.symbol, symbol));
      const txns = groups.find((g) => sameSymbol(g.symbol, symbol))?.txns ?? [];
      const { events } = eventsFromTransactions(txns, equityShare);
      const firstDate = events[0]?.date ?? null;
      const heldAtTrackingStart = !!tsDate && tsSymbols.some((s) => sameSymbol(s, symbol)) && (!firstDate || firstDate > tsDate);
      const { steps, notes } = scheduleFromTrades(events, { currentWeight: held?.weightInClass ?? null, heldAtTrackingStart });
      return {
        symbol,
        assetClass: held?.assetClass ?? null,
        bucket: held?.bucket ?? null,
        modelWeightNow: held ? r5(held.weightInClass) : null,
        heldAtTrackingStart,
        // [day, type, direction, profile, targetWeight, price, status]
        rows: [...txns].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [etDay(t.date), t.type, t.direction, t.profile ?? "-", r5(t.targetWeight), t.price, t.status ?? "settled"]),
        steps: steps.map((s) => [s.from, r5(s.weight)]),
        notes,
      };
    });

    const series = (perf?.models ?? []).filter((m) => m.groupId === "pim").map((m) => ({ profile: m.profile, entries: m.history.length, first: m.history[0]?.date ?? null, last: m.history[m.history.length - 1]?.date ?? null, firstValue: m.history[0]?.value ?? null, lastValue: m.history[m.history.length - 1]?.value ?? null }));

    return NextResponse.json({
      mode: "DIAGNOSTIC — read-only, nothing written",
      trackingStart: { date: tsDate, symbols: tsSymbols },
      equityShareByProfile: Object.fromEntries((["conservative", "balanced", "growth", "allEquity"] as PimProfileType[]).map((p) => [p, equityShare(p)])),
      transactionCount: gs?.transactions?.length ?? 0,
      rowsByTypeAndProfile: typeCounts,
      series,
      holdings,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
