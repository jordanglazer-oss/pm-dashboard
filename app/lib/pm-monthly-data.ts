import { getRedis } from "./redis";
import { yahooClassShare } from "./yahoo-symbol";
import { holdingBucket } from "./sleeve-targets";
import { tickersEqual } from "./ticker";
import { collapseTrades } from "./holding-history";
import { listModelVersions } from "./model-versions";
import type { PimModelData, PimPerformanceData, PimPortfolioState } from "./pim-types";
import type { MonthFacts, MonthMover } from "./pm-monthly-shared";

/**
 * The facts behind a PM Monthly (Nov 2026): the month's model and index
 * returns, what contributed and detracted, the month's activity and the
 * inputs for the outlook. READ-ONLY — reads pm:pim-models,
 * pm:pim-performance, pm:pim-portfolio-state, pm:stocks, pm:brief,
 * pm:market-regime, pm:decision-journal and model versions; stores nothing.
 *
 * Contribution = the holding's weight in its class at the model's current
 * weights × its total return for the month in C$ (Yahoo adjusted closes,
 * FUNDSERV NAVs). An approximation (it ignores intra-month weight changes),
 * labelled as such wherever it is shown.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const isFundserv = (s: string) => /^[A-Z]{2,4}\d{2,5}$/i.test(s);
const toYahoo = (s: string) => yahooClassShare(s.endsWith("-T") ? s.replace(/-T$/, ".TO") : s.endsWith(".U") ? s.replace(/\.U$/, "-U.TO") : s);

function monthBounds(month: string): { start: string; end: string; prevEnd: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const endD = new Date(Date.UTC(y, m, 0));
  const prevEndD = new Date(Date.UTC(y, m - 1, 0));
  return { start, end: endD.toISOString().slice(0, 10), prevEnd: prevEndD.toISOString().slice(0, 10) };
}

type Closes = Map<string, number>;

async function closesAround(symbol: string, from: string, to: string): Promise<Closes> {
  const out: Closes = new Map();
  try {
    if (isFundserv(symbol)) {
      const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(`${symbol}.CF`)}&data=daily&maxrecords=400&volume=contract&order=desc&dividends=false&backadjust=false`;
      const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA, Referer: "https://www.theglobeandmail.com/" } });
      if (!res.ok) return out;
      for (const line of (await res.text()).trim().split("\n")) {
        const p = line.split(",");
        const c = parseFloat(p[5]);
        const d = p[1]?.trim() ?? "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(c)) out.set(d, c);
      }
      return out;
    }
    const p1 = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000) - 12 * 86_400;
    const p2 = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000) + 86_400;
    const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return out;
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < ts.length; i++) {
      const v = adj[i] ?? cl[i];
      if (v != null && Number.isFinite(v)) out.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), v);
    }
  } catch { /* empty */ }
  return out;
}

function lastOnOrBefore(c: Closes, date: string): number | null {
  let best: string | null = null;
  for (const k of c.keys()) if (k <= date && (best == null || k > best)) best = k;
  return best ? c.get(best)! : null;
}

const ret = (c: Closes, from: string, to: string) => {
  const a = lastOnOrBefore(c, from);
  const b = lastOnOrBefore(c, to);
  return a && b ? (b / a - 1) * 100 : null;
};

export async function buildMonthFacts(month: string): Promise<MonthFacts> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month must be YYYY-MM");
  const { start, end, prevEnd } = monthBounds(month);
  const todayIso = new Date().toISOString().slice(0, 10);
  const to = end < todayIso ? end : todayIso;
  const redis = await getRedis();
  const [modelsRaw, perfRaw, stateRaw, stocksRaw, briefRaw, regimeRaw, journalRaw, sleeveRaw] = await Promise.all([
    redis.get("pm:pim-models"),
    redis.get("pm:pim-performance"),
    redis.get("pm:pim-portfolio-state"),
    redis.get("pm:stocks"),
    redis.get("pm:brief"),
    redis.get("pm:market-regime"),
    redis.get("pm:decision-journal"),
    redis.get("pm:sleeve-performance"),
  ]);
  const parse = <T,>(raw: string | null, fb: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fb;
    } catch {
      return fb;
    }
  };
  const models = parse<PimModelData | null>(modelsRaw, null);
  const perf = parse<PimPerformanceData | null>(perfRaw, null);
  const state = parse<PimPortfolioState | null>(stateRaw, null);
  const stocks = parse<{ ticker: string; name?: string; designation?: "core" | "alpha" | "thematic"; instrumentType?: string }[]>(stocksRaw, []);
  const brief = parse<{ marketRegime?: string; bottomLine?: string; tacticalView?: string; cyclicalView?: string; structuralView?: string; generatedAt?: string }>(briefRaw, {});
  const regime = parse<{ composite?: { label?: string } }>(regimeRaw, {});
  const journal = parse<{ entries?: { date?: string; ticker?: string; action?: string; rationale?: string }[] }>(journalRaw, {});
  const sleeves = parse<{ series?: Record<string, { history: { date: string; value: number }[] }> } | null>(sleeveRaw, null);

  // ── Model returns for the month (stored series) ──
  const modelReturns: MonthFacts["modelReturns"] = [];
  for (const m of perf?.models ?? []) {
    if (m.groupId !== "pim") continue;
    const h = m.history;
    const a = [...h].reverse().find((p) => p.date <= prevEnd);
    const b = [...h].reverse().find((p) => p.date <= to);
    if (a && b && b.date >= start) modelReturns.push({ profile: m.profile, returnPct: +((b.value / a.value - 1) * 100).toFixed(2), through: b.date });
  }
  for (const [id, s] of Object.entries(sleeves?.series ?? {})) {
    const a = [...s.history].reverse().find((p) => p.date <= prevEnd) ?? s.history[0];
    const b = [...s.history].reverse().find((p) => p.date <= to);
    if (a && b && b.date >= start && a.date < b.date) modelReturns.push({ profile: `sleeve:${id}`, returnPct: +((b.value / a.value - 1) * 100).toFixed(2), through: b.date, partial: a.date > prevEnd });
  }

  // ── Indices ──
  const INDICES = [
    { symbol: "^GSPTSE", label: "S&P/TSX Composite" },
    { symbol: "^GSPC", label: "S&P 500 (US$)" },
    { symbol: "^IXIC", label: "Nasdaq Composite (US$)" },
    { symbol: "XBB.TO", label: "Canadian bonds (XBB)" },
    { symbol: "USDCAD=X", label: "US dollar vs C$" },
  ];
  const indexReturns = await Promise.all(
    INDICES.map(async (ix) => {
      const c = await closesAround(ix.symbol, prevEnd, to);
      const r = ret(c, prevEnd, to);
      return { label: ix.label, returnPct: r == null ? null : +r.toFixed(2) };
    }),
  );

  // ── Holding contributions ──
  const pim = models?.groups?.find((g) => g.id === "pim");
  const holdings = (pim?.holdings ?? []).filter((h) => h.weightInClass > 0);
  const fx = await closesAround("USDCAD=X", prevEnd, to);
  const fxR = ret(fx, prevEnd, to) ?? 0;
  const movers: MonthMover[] = [];
  const queue = [...holdings];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const h = queue.shift();
        if (!h) return;
        const c = await closesAround(isFundserv(h.symbol) ? h.symbol : toYahoo(h.symbol), prevEnd, to);
        let r = ret(c, prevEnd, to);
        if (r == null) continue;
        if (h.currency === "USD") r = ((1 + r / 100) * (1 + fxR / 100) - 1) * 100;
        const s = stocks.find((x) => x.ticker && tickersEqual(x.ticker, h.symbol));
        const bucket = h.assetClass === "equity" ? holdingBucket(h, stocks) : h.assetClass === "fixedIncome" ? "fixedIncome" : "other";
        movers.push({
          symbol: h.symbol,
          name: s?.name ?? h.name,
          bucket,
          assetClass: h.assetClass,
          weightInClass: h.weightInClass,
          returnPct: +r.toFixed(2),
          contributionPts: +((h.weightInClass * r)).toFixed(3),
        });
      }
    }),
  );
  const equity = movers.filter((m) => m.assetClass === "equity").sort((a, b) => b.contributionPts - a.contributionPts);
  const contributors = equity.filter((m) => m.contributionPts > 0).slice(0, 5);
  const detractors = [...equity].reverse().filter((m) => m.contributionPts < 0).slice(0, 5);

  // ── Activity ──
  const gs = state?.groupStates?.find((g) => g.groupId === "pim");
  const trades: MonthFacts["activity"]["trades"] = [];
  for (const [sym, ds] of collapseTrades(gs?.transactions ?? [])) {
    let prevTarget: number | null = null;
    for (const [i, d] of ds.entries()) {
      const inMonth = d.date >= start && d.date <= end;
      const kind = i === 0 && d.direction === "buy" ? "bought" : d.direction === "sell" && d.target != null && d.target <= 0.0001 ? "sold out" : prevTarget != null && d.target != null && d.target > prevTarget + 0.0005 ? "raised target" : prevTarget != null && d.target != null && d.target < prevTarget - 0.0005 ? "cut target" : "rebalanced";
      prevTarget = d.target;
      if (inMonth && kind !== "rebalanced") {
        const s = stocks.find((x) => x.ticker && tickersEqual(x.ticker, sym));
        trades.push({ date: d.date, symbol: sym, name: s?.name, kind, target: d.target, notes: d.notes });
      }
    }
  }
  trades.sort((a, b) => a.date.localeCompare(b.date));
  const rebalanceDays = new Set<string>();
  for (const t of gs?.transactions ?? []) if (t.type === "rebalance" && t.date.slice(0, 10) >= start && t.date.slice(0, 10) <= end) rebalanceDays.add(t.date.slice(0, 10));
  const modelChanges = (await listModelVersions().catch(() => [])).filter((v) => v.at.slice(0, 10) >= start && v.at.slice(0, 10) <= end).map((v) => ({ date: v.at.slice(0, 10), note: v.note }));
  const journalEntries = (journal.entries ?? [])
    .filter((e) => (e.date ?? "") >= start && (e.date ?? "") <= end)
    .map((e) => ({ date: e.date ?? "", ticker: e.ticker, action: e.action ?? "", rationale: (e.rationale ?? "").slice(0, 400) }))
    .slice(0, 30);

  return {
    month,
    start,
    end,
    through: to,
    partialMonth: to < end,
    modelReturns,
    indexReturns,
    contributors,
    detractors,
    allMovers: movers.sort((a, b) => b.contributionPts - a.contributionPts),
    activity: { trades, rebalanceDays: [...rebalanceDays].sort(), modelChanges, journal: journalEntries },
    outlook: {
      regime: regime.composite?.label ?? brief.marketRegime ?? null,
      bottomLine: brief.bottomLine ?? null,
      tactical: brief.tacticalView ?? null,
      cyclical: brief.cyclicalView ?? null,
      structural: brief.structuralView ?? null,
      briefDate: brief.generatedAt?.slice(0, 10) ?? null,
    },
    method: "Contribution = weight in its class at current model weights × month total return in C$ (approximate; ignores intra-month weight changes).",
  };
}
