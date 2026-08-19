/**
 * GET /api/admin/inspect-trade-state?tickers=GRNJ,LITE
 *
 * Diagnostic for reconciling a Buy/Sell against what actually landed in
 * Redis. Returns, per requested ticker, its presence in pm:pim-models,
 * pm:pim-positions and pm:stocks — plus the transaction-tape entries and
 * the pre-trade snapshot delta, so "what did this trade actually do" is
 * answerable without guessing.
 *
 * Originally written for the multi-trade stale-closure repair. Extended
 * after the GRNJ→LITE partial switch, where a position was created with
 * no matching model holding: model-vs-book disagreement is the recurring
 * failure mode, so it is now reported directly rather than eyeballed.
 *
 * NOTE: `inStocks` previously always returned null. pm:stocks is stored
 * as a BARE ARRAY (see app/api/kv/stocks/route.ts), but this route parsed
 * it as `{ stocks: [...] }` and read `.stocks`, which is always undefined.
 * Every caller got a false "not in pm:stocks" for every ticker.
 *
 * READ-ONLY. No Redis writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type Holding = { symbol?: string; name?: string; weightInClass?: number; assetClass?: string; currency?: string };
type Group = { id: string; name: string; holdings?: Holding[] };
type PimModelData = { groups?: Group[]; lastUpdated?: string };

type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = { groupId: string; profile: string; positions?: Position[]; cashBalance?: number; lastUpdated?: string };
type Positions = { portfolios?: Portfolio[] };

type Stock = {
  ticker: string;
  name?: string;
  bucket?: string;
  designation?: "core" | "alpha";
  instrumentType?: string;
  modelEligibility?: Record<string, boolean>;
};

type Txn = {
  id?: string; date?: string; groupId?: string; type?: string;
  symbol?: string; direction?: string; price?: number;
  targetWeight?: number; pairedWith?: string; status?: string;
};
type GroupState = { groupId: string; transactions?: Txn[] };
type PortfolioState = { groupStates?: GroupState[] };

const SNAPSHOT_PREFIX = "pm:pre-trade-snapshot:";

async function scanAll(
  redis: Awaited<ReturnType<typeof getRedis>>,
  match: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

/** pm:stocks is a bare array; tolerate a legacy `{stocks:[...]}` wrapper. */
function parseStocks(raw: string | null): Stock[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as Stock[];
  if (parsed && Array.isArray(parsed.stocks)) return parsed.stocks as Stock[];
  return [];
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const tickersParam = searchParams.get("tickers") || "";
    const tickers = tickersParam
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (tickers.length === 0) {
      return NextResponse.json({ error: "tickers query param required (comma-separated)" }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, posRaw, stocksRaw, stateRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:stocks"),
      redis.get("pm:pim-portfolio-state"),
    ]);

    const pim: PimModelData = pimRaw ? JSON.parse(pimRaw) : {};
    const pos: Positions = posRaw ? JSON.parse(posRaw) : {};
    const stocks: Stock[] = parseStocks(stocksRaw);
    const state: PortfolioState = stateRaw ? JSON.parse(stateRaw) : {};

    const tickerMatch = (a: string, b: string) => {
      const an = a.toUpperCase().replace("-T", ".TO");
      const bn = b.toUpperCase().replace("-T", ".TO");
      return an === bn;
    };

    // ── Most recent pre-trade snapshot: gives the PRE-trade unit counts so
    // the executed sell fraction can be derived rather than recalled.
    const snapKeys = await scanAll(redis, `${SNAPSHOT_PREFIX}*`);
    const latestSnapKey = snapKeys.length > 0 ? [...snapKeys].sort().slice(-1)[0] : null;
    let snapPositions: Positions = {};
    let snapMeta: { key: string; snapshotAt?: string; reason?: string } | null = null;
    if (latestSnapKey) {
      const snapRaw = await redis.get(latestSnapKey);
      if (snapRaw) {
        const snap = JSON.parse(snapRaw) as Record<string, unknown>;
        snapMeta = {
          key: latestSnapKey,
          snapshotAt: snap.snapshotAt as string | undefined,
          reason: snap.reason as string | undefined,
        };
        const rawPositions = snap["pm:pim-positions"];
        if (typeof rawPositions === "string") snapPositions = JSON.parse(rawPositions);
      }
    }

    const report: Record<string, {
      inPimModels: Array<{ groupId: string; groupName: string; weightInClass: number; assetClass?: string; currency?: string; name?: string }>;
      inPositions: Array<{ groupId: string; profile: string; units: number; costBasis: number }>;
      inStocks: { bucket?: string; name?: string; designation?: string; instrumentType?: string; modelEligibility?: Record<string, boolean> } | null;
      /** Positions with units but NO model holding in the same group, or vice versa. */
      reconciliation: string[];
      /** Pre-trade units from the latest snapshot, and the implied sell fraction. */
      unitsBeforeAfter: Array<{ groupId: string; profile: string; before: number; after: number; deltaPct: number | null }>;
      transactions: Txn[];
    }> = {};

    for (const t of tickers) {
      const pimAppearances = (pim.groups ?? []).flatMap((g) => {
        const matches = (g.holdings ?? []).filter((h) => h.symbol && tickerMatch(h.symbol, t));
        return matches.map((h) => ({
          groupId: g.id,
          groupName: g.name,
          weightInClass: h.weightInClass ?? 0,
          assetClass: h.assetClass,
          currency: h.currency,
          name: h.name,
        }));
      });

      const posAppearances = (pos.portfolios ?? []).flatMap((p) => {
        const matches = (p.positions ?? []).filter((pp) => tickerMatch(pp.symbol, t));
        return matches.map((pp) => ({
          groupId: p.groupId,
          profile: p.profile,
          units: pp.units,
          costBasis: pp.costBasis,
        }));
      });

      const stockEntry = stocks.find((s) => tickerMatch(s.ticker, t)) ?? null;

      // Model-vs-book reconciliation. A position with units but no model
      // holding in the same group is invisible to the Positioning table
      // (which iterates model holdings) and contributes nothing to
      // performance — the exact GRNJ→LITE failure.
      const modelGroupIds = new Set(pimAppearances.map((a) => a.groupId));
      const reconciliation: string[] = [];
      for (const a of posAppearances) {
        if (a.units > 0 && !modelGroupIds.has(a.groupId)) {
          reconciliation.push(
            `ORPHAN POSITION: ${a.units} units in ${a.groupId}/${a.profile} but ${t} is not a holding in model group "${a.groupId}" — invisible on Positioning.`,
          );
        }
      }
      for (const a of pimAppearances) {
        const anyUnits = posAppearances.some((p) => p.groupId === a.groupId && p.units > 0);
        const groupIsTracked = (pos.portfolios ?? []).some((p) => p.groupId === a.groupId);
        if (a.weightInClass > 0 && groupIsTracked && !anyUnits) {
          reconciliation.push(
            `UNITLESS HOLDING: model group "${a.groupId}" targets ${(a.weightInClass * 100).toFixed(2)}% of class but holds 0 units of ${t}.`,
          );
        }
      }
      if (posAppearances.some((p) => p.units > 0) && !stockEntry) {
        reconciliation.push(
          `NOT IN pm:stocks: ${t} has units but no pm:stocks entry — it will not appear in Rankings, and rebalanceStockWeights will treat it as a residual-absorbing Core ETF.`,
        );
      }

      const unitsBeforeAfter = (snapPositions.portfolios ?? []).flatMap((sp) => {
        const beforePos = (sp.positions ?? []).find((pp) => tickerMatch(pp.symbol, t));
        const afterPos = posAppearances.find((a) => a.groupId === sp.groupId && a.profile === sp.profile);
        const before = beforePos?.units ?? 0;
        const after = afterPos?.units ?? 0;
        if (before === 0 && after === 0) return [];
        return [{
          groupId: sp.groupId,
          profile: sp.profile,
          before,
          after,
          deltaPct: before > 0 ? ((after - before) / before) * 100 : null,
        }];
      });

      const transactions = (state.groupStates ?? []).flatMap((gs) =>
        (gs.transactions ?? []).filter((tx) => tx.symbol && tickerMatch(tx.symbol, t)),
      )
        .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())
        .slice(0, 8);

      report[t] = {
        inPimModels: pimAppearances,
        inPositions: posAppearances,
        inStocks: stockEntry
          ? {
              bucket: stockEntry.bucket,
              name: stockEntry.name,
              designation: stockEntry.designation,
              instrumentType: stockEntry.instrumentType,
              modelEligibility: stockEntry.modelEligibility,
            }
          : null,
        reconciliation,
        unitsBeforeAfter,
        transactions,
      };
    }

    // Per-group equity class sums, so a repair is not applied on top of an
    // already-broken sleeve.
    const classSums = (pim.groups ?? []).map((g) => {
      const sums: Record<string, number> = {};
      for (const h of g.holdings ?? []) {
        const ac = h.assetClass ?? "unknown";
        sums[ac] = (sums[ac] ?? 0) + (h.weightInClass ?? 0);
      }
      return {
        groupId: g.id,
        groupName: g.name,
        sums: Object.fromEntries(
          Object.entries(sums).map(([k, v]) => [k, parseFloat((v * 100).toFixed(4))]),
        ),
      };
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      tickers,
      latestPreTradeSnapshot: snapMeta,
      report,
      classSums,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to inspect trade state" },
      { status: 500 },
    );
  }
}
