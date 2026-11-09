import { getRedis } from "./redis";
import { yahooClassShare } from "./yahoo-symbol";
import { tickersEqual } from "./ticker";
import type { PimModelData, PimPortfolioState, PimTransaction } from "./pim-types";
import type { HoldingHistory, HoldingDecision } from "./holding-history-shared";

/**
 * Per-holding performance since first purchase, with every later buy / sell
 * decision (Nov 2026). Built from the PIM group's trade log
 * (pm:pim-portfolio-state → groupStates[pim].transactions) and price
 * history — READ-ONLY, nothing stored.
 *
 * A rebalance logs one trade per holding per profile; those are collapsed to
 * ONE decision per symbol per day (the All-Equity profile's target, i.e. the
 * weight in the equity class, when present). Each decision is classed by how
 * the TARGET moved versus the previous one: Bought (first), Raised target,
 * Cut target, Sold out, or Rebalanced (target unchanged — drift only).
 *
 * Returns: price return from the recorded fill price (native currency) and
 * total return incl. dividends from Yahoo adjusted closes since that date.
 * FUNDSERV funds (NAV, distributions reinvested) use the NAV series.
 * A name with no buy on file starts from the group's tracking start (marked).
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const isFundserv = (s: string) => /^[A-Z]{2,4}\d{2,5}$/i.test(s);
const toYahoo = (s: string) => yahooClassShare(s.endsWith("-T") ? s.replace(/-T$/, ".TO") : s.endsWith(".U") ? s.replace(/\.U$/, "-U.TO") : s);

type Series = { dates: string[]; adj: number[]; last: number | null };

async function history(symbol: string, sinceIso: string): Promise<Series> {
  const out: Series = { dates: [], adj: [], last: null };
  try {
    if (isFundserv(symbol)) {
      const days = Math.min(3000, Math.max(30, Math.ceil((Date.now() - new Date(sinceIso).getTime()) / 86_400_000) + 10));
      const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(`${symbol}.CF`)}&data=daily&maxrecords=${days}&volume=contract&order=asc&dividends=false&backadjust=false`;
      const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA, Referer: "https://www.theglobeandmail.com/" } });
      if (!res.ok) return out;
      const rows: [string, number][] = [];
      for (const line of (await res.text()).trim().split("\n")) {
        const p = line.split(",");
        const c = parseFloat(p[5]);
        const d = p[1]?.trim() ?? "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(c)) rows.push([d, c]);
      }
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      out.dates = rows.map((r) => r[0]);
      out.adj = rows.map((r) => r[1]);
      out.last = out.adj[out.adj.length - 1] ?? null;
      return out;
    }
    const p1 = Math.floor(new Date(sinceIso).getTime() / 1000) - 10 * 86_400;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(symbol))}?period1=${p1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return out;
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < ts.length; i++) {
      const v = adj[i] ?? cl[i];
      if (v == null || !Number.isFinite(v)) continue;
      out.dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      out.adj.push(v);
    }
    const live = r?.meta?.regularMarketPrice;
    out.last = typeof live === "number" ? live : cl.filter((x): x is number => typeof x === "number").pop() ?? null;
  } catch { /* empty series */ }
  return out;
}

/** Adjusted close on or before `date` (the close the trade was made against). */
function adjOnOrBefore(s: Series, date: string): number | null {
  let v: number | null = null;
  for (let i = 0; i < s.dates.length && s.dates[i] <= date; i++) v = s.adj[i];
  return v ?? (s.adj[0] ?? null);
}

const pct = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? +((a / b - 1) * 100).toFixed(2) : null);

/** One decision per symbol per day from the raw trade log. */
export function collapseTrades(txns: PimTransaction[]): Map<string, { date: string; direction: "buy" | "sell"; price: number | null; target: number | null; trades: number; pending: boolean; notes?: string; type: string }[]> {
  const bySym = new Map<string, Map<string, PimTransaction[]>>();
  for (const t of txns) {
    const day = t.date.slice(0, 10);
    const m = bySym.get(t.symbol) ?? new Map<string, PimTransaction[]>();
    m.set(day, [...(m.get(day) ?? []), t]);
    bySym.set(t.symbol, m);
  }
  const out = new Map<string, { date: string; direction: "buy" | "sell"; price: number | null; target: number | null; trades: number; pending: boolean; notes?: string; type: string }[]>();
  for (const [sym, days] of bySym) {
    const list = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ts]) => {
      const pick = ts.find((t) => t.profile === "allEquity") ?? ts.find((t) => t.profile === "balanced") ?? ts[0];
      const buys = ts.filter((t) => t.direction === "buy").length;
      const priced = ts.find((t) => t.price > 0);
      return {
        date,
        direction: (buys >= ts.length - buys ? "buy" : "sell") as "buy" | "sell",
        price: priced ? priced.price : null,
        target: typeof pick.targetWeight === "number" ? pick.targetWeight : null,
        trades: ts.length,
        pending: ts.every((t) => t.status === "pending"),
        ...(ts.find((t) => t.notes)?.notes ? { notes: ts.find((t) => t.notes)!.notes } : {}),
        type: pick.type,
      };
    });
    out.set(sym, list);
  }
  return out;
}

export async function buildHoldingHistories(): Promise<{ holdings: HoldingHistory[]; trackingStart: string | null; asOf: string }> {
  const redis = await getRedis();
  const [stateRaw, modelsRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-portfolio-state"), redis.get("pm:pim-models"), redis.get("pm:stocks")]);
  const state: PimPortfolioState | null = stateRaw ? JSON.parse(stateRaw) : null;
  const models: PimModelData | null = modelsRaw ? JSON.parse(modelsRaw) : null;
  const stocks: { ticker?: string; name?: string; instrumentType?: string }[] = stocksRaw ? JSON.parse(stocksRaw) : [];
  const gs = state?.groupStates?.find((g) => g.groupId === "pim");
  const trackingStart = gs?.trackingStart?.date?.slice(0, 10) ?? null;
  const pim = models?.groups?.find((g) => g.id === "pim");
  const current = (pim?.holdings ?? []).filter((h) => (h.weightInClass || 0) > 0);
  const decisionsBySym = collapseTrades(gs?.transactions ?? []);

  const symbols = new Set<string>([...current.map((h) => h.symbol), ...decisionsBySym.keys()]);
  const todayIso = new Date().toISOString().slice(0, 10);
  const list = [...symbols];
  const results: HoldingHistory[] = [];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const sym = list.shift();
        if (!sym) return;
        const raw = decisionsBySym.get(sym) ?? [];
        const held = current.find((h) => h.symbol === sym);
        const firstBuy = raw.find((d) => d.direction === "buy");
        const startDate = firstBuy?.date ?? trackingStart ?? todayIso;
        const startPrice = firstBuy?.price ?? (trackingStart ? gs?.trackingStart?.prices?.[sym] ?? null : null);
        const s = await history(sym, startDate);
        const now = s.last;
        const nowAdj = s.adj[s.adj.length - 1] ?? null;

        let prevTarget: number | null = null;
        const decisions: HoldingDecision[] = raw.map((d, i) => {
          let kind: HoldingDecision["kind"];
          if (i === 0 && d.direction === "buy") kind = "bought";
          else if (d.direction === "sell" && d.target != null && d.target <= 0.0001) kind = "sold out";
          else if (prevTarget != null && d.target != null && d.target > prevTarget + 0.0005) kind = "raised target";
          else if (prevTarget != null && d.target != null && d.target < prevTarget - 0.0005) kind = "cut target";
          else kind = "rebalanced";
          prevTarget = d.target;
          return {
            date: d.date,
            kind,
            direction: d.direction,
            price: d.price,
            target: d.target,
            pending: d.pending,
            ...(d.notes ? { notes: d.notes } : {}),
            sincePricePct: pct(now, d.price),
            sinceTotalPct: pct(nowAdj, adjOnOrBefore(s, d.date)),
          };
        });
        const soldOut = !held && decisions.length > 0 && decisions[decisions.length - 1].direction === "sell";
        const exit = soldOut ? decisions[decisions.length - 1] : null;
        const stock = stocks.find((x) => x.ticker && tickersEqual(x.ticker, sym));
        results.push({
          symbol: sym,
          name: stock?.name ?? held?.name,
          held: !!held,
          currentWeight: held?.weightInClass ?? null,
          assetClass: held?.assetClass,
          firstDate: startDate,
          firstFromLog: !!firstBuy,
          firstPrice: startPrice,
          price: now,
          sinceFirstPricePct: pct(exit?.price ?? now, startPrice),
          sinceFirstTotalPct: exit ? pct(adjOnOrBefore(s, exit.date), adjOnOrBefore(s, startDate)) : pct(nowAdj, adjOnOrBefore(s, startDate)),
          exitDate: exit?.date ?? null,
          decisions,
        });
      }
    }),
  );
  results.sort((a, b) => Number(b.held) - Number(a.held) || (b.currentWeight ?? 0) - (a.currentWeight ?? 0) || a.symbol.localeCompare(b.symbol));
  return { holdings: results, trackingStart, asOf: new Date().toISOString() };
}
