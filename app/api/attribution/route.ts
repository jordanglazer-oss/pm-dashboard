import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import {
  decompose,
  returnOverPeriod,
  computeContributions,
  periodStartDate,
  valueOnOrBefore,
  valueBefore,
  latestValue,
  PERIODS,
  type ReturnDecomposition,
  type ContributionBreakdown,
  type ValuePoint,
  type PeriodKey,
} from "@/app/lib/attribution";

/**
 * GET /api/attribution — performance attribution (Phase 04, view 1: the
 * return decomposition Total = Market(beta) + Currency + Selection).
 *
 * Reads pm:appendix-daily-values (per-profile CAD cumulative value series) and
 * pm:stocks (equity book beta + USD sleeve) READ-ONLY; fetches S&P 500 /
 * S&P/TSX / USD-CAD histories from Yahoo. Caches the assembled result in
 * pm:attribution-cache (regenerable — safe to nuke). No live data mutated.
 *
 * ?refresh=1 forces a rebuild (12h freshness otherwise).
 */

const log = createLogger("Attribution");
const CACHE_KEY = "pm:attribution-cache";
const STALE_MS = 12 * 60 * 60 * 1000;

// Structural equity share per profile (matches CLAUDE.md / pim-seed). Used to
// scale the equity book's beta + USD exposure down for lower-equity profiles,
// so "market contribution" isn't overstated for e.g. Conservative.
const PROFILE_EQUITY: Record<string, number> = {
  conservative: 0.3,
  balanced: 0.66,
  growth: 0.83,
  allEquity: 1.0,
  alpha: 1.0,
  core: 1.0,
};

const PROFILE_LABEL: Record<string, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
  core: "Core",
};

type Ledger = { profile?: string; entries?: Array<{ date?: string; value?: number }> };
type StoredStock = {
  ticker?: string;
  bucket?: string;
  beta?: number;
  currency?: string;
  sector?: string;
  price?: number;
  currentPrice?: number;
  instrumentType?: string;
};
type StoredPosition = { symbol?: string; units?: number; costBasis?: number };
type PositionLedger = { profile?: string; groupId?: string; positions?: StoredPosition[]; cashBalance?: number };
type ModelHolding = { symbol?: string; assetClass?: string };
type ModelGroup = { holdings?: ModelHolding[] };
type StoredTransaction = {
  date?: string;
  symbol?: string;
  direction?: string;
  price?: number;
  targetWeight?: number;
  type?: string;
  profile?: string;
};
type StoredGroupState = {
  groupId?: string;
  trackingStart?: { prices?: Record<string, number> } | null;
  transactions?: StoredTransaction[];
};

/** Classify a holding for the sector breakdown. Individual stocks keep their
 *  GICS sector; ETFs / mutual funds (which have no single GICS sector) are
 *  labelled by the PIM model's asset class so they don't all collapse into
 *  "Unclassified". */
function classifyHolding(sector: string, instrumentType?: string, assetClass?: string): string {
  const s = (sector || "").trim();
  const hasGics = s.length > 0 && s !== "Unclassified";
  const isFund = instrumentType === "etf" || instrumentType === "mutual-fund";
  if (hasGics && !isFund) return s; // individual stock with a real sector
  if (assetClass === "fixedIncome") return "Fixed Income";
  if (assetClass === "alternative") return "Alternatives";
  if (assetClass === "equity" || isFund) return "Equity ETFs & Funds";
  return hasGics ? s : "Unclassified";
}

function isCad(ticker: string, currency?: string): boolean {
  if (currency) return currency.toUpperCase() === "CAD";
  return /(\.(TO|V|NE|CN))$/i.test(ticker) || /-T$/i.test(ticker);
}

/** Normalise a ticker/symbol so PIM positions match pm:stocks across the
 *  -T / .TO / .V / .NE / .U suffix variants. */
function normTicker(t: string): string {
  return t
    .toUpperCase()
    .replace(/\.(TO|V|NE|CN|U)$/i, "")
    .replace(/-T$/i, "");
}

/** Fetch a Yahoo daily history as an ascending ValuePoint[] series. Prefers
 *  adjusted closes so a period baseline bakes in distributions paid since —
 *  i.e. per-holding "returns" are total returns, which matters for the
 *  dividend-heavy names. (Latest adjclose === latest close, so this stays
 *  consistent with the live price used as the window's end.) */
async function fetchYahooHistory(symbol: string): Promise<ValuePoint[]> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=2y&interval=1d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const ts: number[] = result?.timestamp || [];
  const closes: number[] = result?.indicators?.quote?.[0]?.close || [];
  const adj: number[] = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const out: ValuePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const a = adj[i];
    const c = typeof a === "number" && isFinite(a) ? a : closes[i];
    if (typeof c === "number" && isFinite(c)) {
      out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: c });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";
  const redis = await getRedis();

  let cached: unknown = null;
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    log.warn("cache read failed:", e instanceof Error ? e.message : e);
  }
  const cachedObj = cached as { builtAt?: string } | null;
  const fresh =
    cachedObj?.builtAt && Date.now() - new Date(cachedObj.builtAt).getTime() < STALE_MS;
  if (fresh && !forceRefresh) {
    return NextResponse.json({ attribution: cached, cached: true });
  }

  try {
    // ── Portfolio value series per profile ──
    let ledgers: Ledger[] = [];
    try {
      const raw = await redis.get("pm:appendix-daily-values");
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.ledgers)) ledgers = parsed.ledgers as Ledger[];
    } catch (e) {
      log.warn("appendix read failed:", e instanceof Error ? e.message : e);
    }

    // ── Equity book beta + USD sleeve + price/sector lookup from pm:stocks ──
    let equityBeta = 1;
    let usdEquityFraction = 0;
    const stockLookup = new Map<
      string,
      { ticker: string; sector: string; currency: "CAD" | "USD"; price: number | null; instrumentType?: string }
    >();
    try {
      const raw = await redis.get("pm:stocks");
      const parsed = raw ? JSON.parse(raw) : [];
      const all = Array.isArray(parsed) ? (parsed as StoredStock[]) : [];
      for (const s of all) {
        if (!s.ticker) continue;
        const price = typeof s.price === "number" ? s.price : typeof s.currentPrice === "number" ? s.currentPrice : null;
        stockLookup.set(normTicker(s.ticker), {
          ticker: s.ticker,
          instrumentType: s.instrumentType,
          sector: s.sector || "Unclassified",
          currency: isCad(s.ticker, s.currency) ? "CAD" : "USD",
          price,
        });
      }
      const port = all.filter((s) => s.bucket === "Portfolio" && s.ticker);
      if (port.length > 0) {
        const betas = port.map((s) => (typeof s.beta === "number" && s.beta > 0 ? s.beta : 1));
        equityBeta = betas.reduce((a, b) => a + b, 0) / betas.length;
        const usd = port.filter((s) => !isCad(s.ticker!, s.currency)).length;
        usdEquityFraction = usd / port.length;
      }
    } catch (e) {
      log.warn("stocks read failed:", e instanceof Error ? e.message : e);
    }

    // ── PIM positions (for period contributions, view 2) ──
    // A profile spans multiple groups; the SAME symbol can be held in several
    // of them. Aggregate units per normalised ticker so the contribution list
    // shows one row per name (duplicates previously double-listed and split
    // the weight). Cash balances are summed per profile for the weighting
    // denominator.
    const positionsByProfile = new Map<string, Map<string, StoredPosition>>();
    const cashByProfile = new Map<string, number>();
    // Which model groups make up each profile — needed to scope group-level
    // sell transactions to the right profiles.
    const groupsByProfile = new Map<string, Set<string>>();
    try {
      const raw = await redis.get("pm:pim-positions");
      const parsed = raw ? JSON.parse(raw) : null;
      // pm:pim-positions is stored as { portfolios: PimPortfolioPositions[] },
      // NOT a bare array — read the inner array.
      const arr: PositionLedger[] =
        parsed && Array.isArray((parsed as { portfolios?: unknown }).portfolios)
          ? ((parsed as { portfolios: PositionLedger[] }).portfolios)
          : [];
      for (const pl of arr) {
        if (!pl.profile) continue;
        if (pl.groupId) {
          const set = groupsByProfile.get(pl.profile) ?? new Set<string>();
          set.add(pl.groupId);
          groupsByProfile.set(pl.profile, set);
        }
        if (typeof pl.cashBalance === "number" && isFinite(pl.cashBalance)) {
          cashByProfile.set(pl.profile, (cashByProfile.get(pl.profile) ?? 0) + pl.cashBalance);
        }
        if (!Array.isArray(pl.positions)) continue;
        const bySym = positionsByProfile.get(pl.profile) ?? new Map<string, StoredPosition>();
        for (const p of pl.positions) {
          if (!p.symbol || typeof p.units !== "number") {
            // keep unparseable entries so the debug counters still see them
            bySym.set(`__invalid_${bySym.size}`, p);
            continue;
          }
          const key = normTicker(p.symbol);
          const prev = bySym.get(key);
          bySym.set(
            key,
            prev && typeof prev.units === "number"
              ? { ...prev, units: prev.units + p.units }
              : { ...p },
          );
        }
        positionsByProfile.set(pl.profile, bySym);
      }
    } catch (e) {
      log.warn("positions read failed:", e instanceof Error ? e.message : e);
    }

    // ── Trade log (pm:pim-portfolio-state) → when was each name FIRST bought?
    // Used to clamp a holding's contribution window to the time it was
    // actually owned: a name initiated mid-period is measured from its
    // purchase (at the execution price), not from the period start. A symbol
    // present in any group's trackingStart snapshot predates the trade log,
    // so it is never clamped (its later buys are top-ups, not initiations).
    const firstBuyBySymbol = new Map<string, { date: string; price: number | null }>();
    const preExisting = new Set<string>();
    // Sell transactions per symbol — lets fully-exited names still appear in
    // the contribution list (measured to the sale, weight estimated from the
    // model weight the sell recorded).
    // `weight` semantics differ by writer: trade-flow sells record the raw
    // weightInClass (needs × profile equity share); rebalance sells record
    // modelPct = weightInClass × assetAlloc, i.e. already profile-scaled.
    type SellTxn = {
      date: string;
      price: number | null;
      weight: number;
      preScaled: boolean;
      groupId: string | null;
      profile: string | null;
      rawSymbol: string;
    };
    const sellsBySymbol = new Map<string, SellTxn[]>();
    try {
      const raw = await redis.get("pm:pim-portfolio-state");
      const parsed = raw ? JSON.parse(raw) : null;
      const states: StoredGroupState[] =
        parsed && Array.isArray((parsed as { groupStates?: unknown }).groupStates)
          ? ((parsed as { groupStates: StoredGroupState[] }).groupStates)
          : [];
      for (const gs of states) {
        for (const sym of Object.keys(gs.trackingStart?.prices ?? {})) {
          preExisting.add(normTicker(sym));
        }
        for (const t of gs.transactions ?? []) {
          if (!t.symbol || !t.date) continue;
          const key = normTicker(t.symbol);
          const date = t.date.slice(0, 10);
          const price = typeof t.price === "number" && isFinite(t.price) && t.price > 0 ? t.price : null;
          if (t.direction === "buy") {
            const prev = firstBuyBySymbol.get(key);
            if (!prev || date < prev.date) firstBuyBySymbol.set(key, { date, price });
          } else if (t.direction === "sell") {
            const list = sellsBySymbol.get(key) ?? [];
            list.push({
              date,
              price,
              weight:
                typeof t.targetWeight === "number" && isFinite(t.targetWeight) && t.targetWeight > 0
                  ? t.targetWeight
                  : 0,
              preScaled: t.type === "rebalance",
              groupId: gs.groupId ?? null,
              profile: t.profile ?? null,
              rawSymbol: t.symbol,
            });
            sellsBySymbol.set(key, list);
          }
        }
      }
    } catch (e) {
      log.warn("portfolio-state read failed:", e instanceof Error ? e.message : e);
    }

    // ── PIM model asset classes (to classify ETFs/funds by asset class) ──
    const assetClassByTicker = new Map<string, string>();
    try {
      const raw = await redis.get("pm:pim-models");
      const parsed = raw ? JSON.parse(raw) : null;
      const groups: ModelGroup[] = parsed && Array.isArray(parsed.groups) ? parsed.groups : [];
      for (const g of groups) {
        for (const h of g.holdings ?? []) {
          if (h.symbol && h.assetClass && !assetClassByTicker.has(normTicker(h.symbol))) {
            assetClassByTicker.set(normTicker(h.symbol), h.assetClass);
          }
        }
      }
    } catch (e) {
      log.warn("pim-models read failed:", e instanceof Error ? e.message : e);
    }

    // ── Benchmarks + FX (Yahoo) ──
    // SPY / XIU.TO (adjclose) rather than ^GSPC / ^GSPTSE: the portfolio's
    // return includes distributions, so comparing it against price-only
    // indexes overstated "selection". These are total-return proxies, and
    // XIU.TO matches the TSX 60 the team actually benchmarks against.
    const [sp500, tsx, usdcad] = await Promise.all([
      fetchYahooHistory("SPY").catch(() => [] as ValuePoint[]),
      fetchYahooHistory("XIU.TO").catch(() => [] as ValuePoint[]),
      fetchYahooHistory("USDCAD=X").catch(() => [] as ValuePoint[]),
    ]);

    const ref = new Date();
    // Blend weights follow the book's USD/CAD name split (shown in the label,
    // so the mix is transparent). Count-based, same basis as the currency
    // sleeve estimate.
    const blendUs = Math.round(usdEquityFraction * 100);
    const blendLabel = `Blend ${blendUs}/${100 - blendUs}`;
    // Benchmarks stay in LOCAL-currency terms (S&P in USD, TSX in CAD) —
    // the FX overlay is the decomposition's separate Currency term, so the
    // identity  active = (beta−1)×bench + currency + selection  holds without
    // double-counting the USD/CAD move.
    const benchmarkReturns = (period: PeriodKey) => {
      const sp = returnOverPeriod(sp500, period, ref);
      const tx = returnOverPeriod(tsx, period, ref);
      const out = [
        { label: "S&P 500", returnPct: sp },
        { label: "TSX 60", returnPct: tx },
      ];
      if (sp != null && tx != null) {
        out.push({
          label: blendLabel,
          returnPct: usdEquityFraction * sp + (1 - usdEquityFraction) * tx,
        });
      }
      return out;
    };

    // Latest USD/CAD rate for converting USD position values to CAD (weighting).
    const usdcadRate = usdcad.length > 0 ? usdcad[usdcad.length - 1].value : null;
    const usdcadSorted = [...usdcad].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // ── Per-holding daily history (for PERIOD-based contribution) ──
    // Fetch each matched holding's Yahoo history ONCE (deduped across profiles),
    // so we can price each name at each period's start. ~35 holdings.
    const historyTickers = new Set<string>();
    for (const [, poss] of positionsByProfile) {
      for (const p of poss.values()) {
        if (!p.symbol) continue;
        const st = stockLookup.get(normTicker(p.symbol));
        if (st?.ticker) historyTickers.add(st.ticker);
      }
    }
    // Sold names need history too (for their baselines). They may be gone
    // from pm:stocks entirely — fall back to the symbol the trade recorded.
    const soldHistTicker = new Map<string, string>();
    for (const [key, sells] of sellsBySymbol) {
      const tk = stockLookup.get(key)?.ticker ?? sells[0].rawSymbol;
      soldHistTicker.set(key, tk);
      historyTickers.add(tk);
    }
    const histMap = new Map<string, ValuePoint[]>();
    await Promise.all(
      [...historyTickers].map(async (tk) => {
        const h = await fetchYahooHistory(tk).catch(() => [] as ValuePoint[]);
        histMap.set(tk, h.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
      }),
    );

    const profiles: Array<{
      profile: string;
      label: string;
      periods: ReturnDecomposition[];
      contributionsByPeriod: Partial<Record<PeriodKey, ContributionBreakdown>>;
      contributionsExcluded: number;
      contribDebug: { positions: number; noSymbol: number; noMatch: number; noPrice: number; noHistory: number; rows: number };
    }> = [];
    for (const led of ledgers) {
      const profile = led.profile;
      if (!profile || !Array.isArray(led.entries) || led.entries.length < 2) continue;
      const series: ValuePoint[] = led.entries
        .filter((e) => typeof e.date === "string" && typeof e.value === "number")
        .map((e) => ({ date: e.date as string, value: e.value as number }));
      const equityAlloc = PROFILE_EQUITY[profile] ?? 1;
      const effectiveBeta = equityBeta * equityAlloc;
      const usdSleevePct = usdEquityFraction * equityAlloc * 100;

      const periods = PERIODS.map((period) =>
        decompose({
          period,
          profile,
          portfolioReturnPct: returnOverPeriod(series, period, ref),
          portfolioBeta: effectiveBeta,
          usdSleeveWeightPct: usdSleevePct,
          usdcadReturnPct: returnOverPeriod(usdcad, period, ref),
          benchmarks: benchmarkReturns(period),
        }),
      );

      // View 2 — PERIOD-based contribution (MTD/QTD/YTD/1Y). Each holding's
      // contribution = current CAD weight × its return over the part of the
      // period we actually OWNED it. For names held before the period starts,
      // that window is the whole period (baseline = last close before the
      // period start). For names initiated mid-period (per the trade log),
      // the window starts at the purchase — baseline = the execution price —
      // so a name bought days ago can't book weeks of pre-ownership gains.
      const positions = [...(positionsByProfile.get(profile)?.values() ?? [])];
      const dbg = { positions: positions.length, noSymbol: 0, noMatch: 0, noPrice: 0, noHistory: 0, rows: 0 };
      const contributionsByPeriod: Partial<Record<PeriodKey, ContributionBreakdown>> = {};
      const usdcadNow = usdcadRate ?? 1;
      const todayIso = ref.toISOString().slice(0, 10);
      for (const period of PERIODS) {
        const start = periodStartDate(period, ref);
        const rows = [];
        let excluded = 0;
        for (const p of positions) {
          if (!p.symbol || typeof p.units !== "number") {
            if (period === "YTD") dbg.noSymbol++;
            excluded++;
            continue;
          }
          const stock = stockLookup.get(normTicker(p.symbol));
          if (!stock) {
            if (period === "YTD") dbg.noMatch++;
            excluded++;
            continue;
          }
          const hist = histMap.get(stock.ticker) ?? [];
          // Live price from pm:stocks; fall back to the freshest Yahoo close
          // so a name isn't dropped just because the stored quote is missing.
          const livePrice = stock.price ?? latestValue(hist);
          if (livePrice == null) {
            if (period === "YTD") dbg.noPrice++;
            excluded++;
            continue;
          }

          // Ownership clamp: position initiated mid-period → measure from the
          // buy. Only when the symbol is absent from every trackingStart
          // snapshot (otherwise it predates the trade log and buys are top-ups).
          const key = normTicker(p.symbol);
          const firstBuy = !preExisting.has(key) ? firstBuyBySymbol.get(key) : undefined;
          const clamped = !!firstBuy && firstBuy.date > start && firstBuy.date <= todayIso;
          const baselineDate = clamped ? firstBuy!.date : start;

          let startPriceNative: number | null;
          if (clamped) {
            const closeAtBuy = valueOnOrBefore(hist, baselineDate);
            // Prefer the actual execution price; guard against fat-fingered /
            // wrong-currency entries by falling back to that day's close when
            // the two disagree wildly.
            startPriceNative =
              firstBuy!.price != null &&
              (closeAtBuy == null || Math.abs(firstBuy!.price / closeAtBuy - 1) <= 0.25)
                ? firstBuy!.price
                : closeAtBuy;
          } else {
            startPriceNative = valueBefore(hist, start);
          }
          if (startPriceNative == null || startPriceNative <= 0) {
            if (period === "YTD") dbg.noHistory++;
            excluded++;
            continue; // history doesn't reach back to the window start
          }
          const isUsd = stock.currency === "USD";
          // FX baseline matches the price baseline: strictly before the period
          // start for full-period windows, at the buy date for clamped ones.
          const usdcadStart =
            (clamped ? valueOnOrBefore(usdcadSorted, baselineDate) : valueBefore(usdcadSorted, start)) ??
            usdcadNow;
          const startPriceCad = startPriceNative * (isUsd ? usdcadStart : 1);
          const currentPriceCad = livePrice * (isUsd ? usdcadNow : 1);
          rows.push({
            ticker: stock.ticker,
            sector: classifyHolding(stock.sector, stock.instrumentType, assetClassByTicker.get(normTicker(stock.ticker))),
            currency: stock.currency,
            marketValueCad: p.units * currentPriceCad,
            costBasisCad: startPriceCad, // window-start CAD price → return = owned-window return
            priceCad: currentPriceCad,
            ...(clamped ? { ownedSince: baselineDate } : {}),
          });
        }

        // Fully-exited names: still shown, measured from the period start (or
        // the mid-period purchase) TO THE SALE at the sale price. Their weight
        // can't come from a current market value, so it's estimated from the
        // model weight recorded on the sell transaction(s) — tagged in the UI.
        const profileGroups = groupsByProfile.get(profile);
        for (const [key, sells] of sellsBySymbol) {
          if (positionsByProfile.get(profile)?.has(key)) continue; // still held → handled above
          const scoped = sells.filter(
            (s) =>
              (s.profile == null || s.profile === profile) &&
              (!profileGroups || s.groupId == null || profileGroups.has(s.groupId)),
          );
          const inPeriod = scoped.filter((s) => s.date > start && s.date <= todayIso);
          if (inPeriod.length === 0) continue; // exited before this period began
          const lastSell = inPeriod.reduce((a, b) => (a.date >= b.date ? a : b));
          const tk = soldHistTicker.get(key) ?? key;
          const hist = histMap.get(tk) ?? [];

          const closeAtSell = valueOnOrBefore(hist, lastSell.date);
          const endPriceNative =
            lastSell.price != null &&
            (closeAtSell == null || Math.abs(lastSell.price / closeAtSell - 1) <= 0.25)
              ? lastSell.price
              : closeAtSell;
          if (endPriceNative == null || endPriceNative <= 0) {
            excluded++;
            continue;
          }

          const firstBuy = !preExisting.has(key) ? firstBuyBySymbol.get(key) : undefined;
          const clamped = !!firstBuy && firstBuy.date > start && firstBuy.date <= lastSell.date;
          const baselineDate = clamped ? firstBuy!.date : start;
          let startPriceNative: number | null;
          if (clamped) {
            const closeAtBuy = valueOnOrBefore(hist, baselineDate);
            startPriceNative =
              firstBuy!.price != null &&
              (closeAtBuy == null || Math.abs(firstBuy!.price / closeAtBuy - 1) <= 0.25)
                ? firstBuy!.price
                : closeAtBuy;
          } else {
            startPriceNative = valueBefore(hist, start);
          }
          if (startPriceNative == null || startPriceNative <= 0) {
            excluded++;
            continue;
          }

          // Exit weight per group = the LATEST sell's recorded model weight
          // there (a full sell logs the holding's whole weightInClass; an
          // earlier trim in the same group must not be added on top). Groups
          // run the same model in parallel, so the profile-level weight is
          // the AVERAGE of the groups' exit weights — summing across groups
          // multiplied a name's weight by the number of groups that sold it.
          const latestByGroup = new Map<string, SellTxn>();
          for (const s of inPeriod) {
            const gk = s.groupId ?? "__none";
            const prev = latestByGroup.get(gk);
            if (!prev || s.date > prev.date) latestByGroup.set(gk, s);
          }
          const exitWeights = [...latestByGroup.values()]
            // portfolio-level fraction; no single name is 15%+ — treat larger as corrupt
            .map((s) => Math.min(s.preScaled ? s.weight : s.weight * equityAlloc, 0.15))
            .filter((w) => w > 0);
          if (exitWeights.length === 0) {
            excluded++;
            continue; // no usable weight recorded on the sells — can't size it
          }
          const exitWeightPct =
            (exitWeights.reduce((a, b) => a + b, 0) / exitWeights.length) * 100;

          const stock = stockLookup.get(key);
          const isUsd = stock ? stock.currency === "USD" : !isCad(tk);
          const fxStart =
            (clamped ? valueOnOrBefore(usdcadSorted, baselineDate) : valueBefore(usdcadSorted, start)) ??
            usdcadNow;
          const fxEnd = valueOnOrBefore(usdcadSorted, lastSell.date) ?? usdcadNow;
          rows.push({
            ticker: tk,
            sector: classifyHolding(stock?.sector ?? "", stock?.instrumentType, assetClassByTicker.get(key)),
            currency: isUsd ? ("USD" as const) : ("CAD" as const),
            marketValueCad: 0,
            costBasisCad: startPriceNative * (isUsd ? fxStart : 1),
            priceCad: endPriceNative * (isUsd ? fxEnd : 1),
            fixedWeightPct: exitWeightPct,
            soldOn: lastSell.date,
            ...(clamped ? { ownedSince: baselineDate } : {}),
          });
        }
        if (period === "YTD") dbg.rows = rows.length;
        if (rows.length > 0) {
          contributionsByPeriod[period] = computeContributions(rows, {
            cashCad: cashByProfile.get(profile) ?? 0,
            excludedCount: excluded,
          });
        }
      }
      const contributionsExcluded = dbg.noSymbol + dbg.noMatch + dbg.noPrice + dbg.noHistory;

      profiles.push({
        profile,
        label: PROFILE_LABEL[profile] ?? profile,
        periods,
        contributionsByPeriod,
        contributionsExcluded,
        contribDebug: dbg,
      });
    }

    const attribution = {
      builtAt: ref.toISOString(),
      equityBeta,
      usdEquityFractionPct: usdEquityFraction * 100,
      fxAvailable: usdcad.length > 0,
      benchmarksAvailable: { sp500: sp500.length > 0, tsx: tsx.length > 0 },
      profiles,
    };

    try {
      await redis.set(CACHE_KEY, JSON.stringify(attribution));
    } catch (e) {
      log.warn("cache write failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ attribution, cached: false });
  } catch (e) {
    log.error("rebuild failed:", e);
    if (cached) return NextResponse.json({ attribution: cached, cached: true, stale: true });
    return NextResponse.json({ attribution: null, error: "attribution unavailable" }, { status: 503 });
  }
}
