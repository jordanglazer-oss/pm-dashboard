import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { readBackupBlob } from "@/app/lib/backup-store";
import { bucketTests } from "@/app/lib/sleeve-targets";
import { sameSymbol } from "@/app/lib/model-staging";
import type { PimModelData, PimPerformanceData, PimPortfolioPositions, PimDailyReturn } from "@/app/lib/pim-types";

/**
 * GET /api/admin/seed-stocks-book[?backup=<pathname>][&confirm=YES]
 *
 * One-time setup of the Stocks book (Nov 2026): the individual stocks ALONE,
 * no Core ETFs, no Thematic funds.
 *
 * Until 2026-11-11 the Alpha positions book held only stocks, so the Alpha
 * series to that date IS the stock-only record. On 2026-11-11 (evening) the
 * Thematic funds were added to the Alpha book ("Add N at model weight"), so
 * from then on Alpha = stocks + Thematic funds. This route:
 *
 *   1. Stocks SERIES (pim|stocks in pm:pim-performance) = the Alpha series as
 *      it stood in the backup taken BEFORE the funds were added (default:
 *      backups/2026-11-11T22-56-27-248Z.json, taken just before the merge that
 *      shipped "Add N"). Its last entry is anchored so the daily job never
 *      recomputes it; the days after it are computed on the Stocks book.
 *   2. Stocks BOOK (pim|stocks in pm:pim-positions) = the stock positions of
 *      the LIVE Alpha book, units and cost untouched (so it starts on today's
 *      Positioning weights, not the model's), with the Alpha book's cash.
 *   3. Alpha SERIES: any live entry dated on/before the backup's last Alpha
 *      date that differs from the backup (i.e. was recomputed after the funds
 *      were added) is restored to the backup value, and that last date is
 *      anchored — so Alpha switches to stocks + Thematic from the NEXT day and
 *      its history is otherwise untouched. Later Alpha entries are kept.
 *
 * Dry run by default (writes nothing, shows everything). `&confirm=YES` writes.
 * Refuses if a Stocks series or book already exists, or if the backup's Alpha
 * book held anything but stocks (then its history is not stock-only).
 * Stashes pm:pim-performance / pm:pim-positions `.pre-stocks-seed-<ts>` first.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Seed-stocks-book");
const GROUP = "pim";
const DEFAULT_BACKUP = "backups/2026-11-11T22-56-27-248Z.json";

type PositionsBlob = { portfolios: PimPortfolioPositions[] } & Record<string, unknown>;
type StockLite = { ticker: string; designation?: "core" | "alpha" | "thematic" };

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const confirm = url.searchParams.get("confirm") === "YES";
    const backupPath = url.searchParams.get("backup") || DEFAULT_BACKUP;
    const redis = await getRedis();

    const [perfRaw, posRaw, modelsRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-performance"),
      redis.get("pm:pim-positions"),
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!perfRaw || !posRaw || !modelsRaw) return NextResponse.json({ error: "performance, positions or models missing — nothing written" }, { status: 409 });
    const perf = JSON.parse(perfRaw) as PimPerformanceData;
    const pos = JSON.parse(posRaw) as PositionsBlob;
    const models = JSON.parse(modelsRaw) as PimModelData;
    const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as StockLite[];
    const bt = bucketTests(stocks, models);
    const isStock = (sym: string) => !bt.isCore(sym) && !bt.isThematic(sym);

    // ── Backup (pre-fill) ──
    const snap = await readBackupBlob(backupPath);
    const bPerfRaw = snap.data["pm:pim-performance"];
    const bPosRaw = snap.data["pm:pim-positions"];
    if (!bPerfRaw || !bPosRaw) return NextResponse.json({ error: `backup ${backupPath} has no performance or positions — nothing written` }, { status: 409 });
    const bPerf = JSON.parse(bPerfRaw) as PimPerformanceData;
    const bPos = JSON.parse(bPosRaw) as PositionsBlob;
    const bAlphaSeries = bPerf.models.find((m) => m.groupId === GROUP && m.profile === "alpha");
    const bAlphaBook = bPos.portfolios.find((b) => b.groupId === GROUP && b.profile === "alpha");
    if (!bAlphaSeries || bAlphaSeries.history.length < 2) return NextResponse.json({ error: "backup has no Alpha series — nothing written" }, { status: 409 });
    const backupNonStocks = (bAlphaBook?.positions ?? []).filter((p) => p.units > 0 && !isStock(p.symbol)).map((p) => p.symbol);
    const cutDate = bAlphaSeries.history[bAlphaSeries.history.length - 1].date;

    // ── Live ──
    const liveAlphaSeries = perf.models.find((m) => m.groupId === GROUP && m.profile === "alpha");
    const liveAlphaBook = pos.portfolios.find((b) => b.groupId === GROUP && b.profile === "alpha");
    const stocksSeriesExists = perf.models.some((m) => m.groupId === GROUP && (m.profile as string) === "stocks");
    const stocksBookExists = pos.portfolios.some((b) => b.groupId === GROUP && (b.profile as string) === "stocks");
    if (!liveAlphaSeries || !liveAlphaBook) return NextResponse.json({ error: "no live Alpha series or book — nothing written" }, { status: 409 });

    const stockPositions = liveAlphaBook.positions.filter((p) => p.units > 0 && isStock(p.symbol));
    const leftOut = liveAlphaBook.positions.filter((p) => p.units > 0 && !isStock(p.symbol)).map((p) => p.symbol);
    // Stock units should be exactly what the backup's Alpha book held (the fill keeps them).
    const unitDiffs = stockPositions
      .map((p) => {
        const b = bAlphaBook?.positions.find((x) => sameSymbol(x.symbol, p.symbol));
        return b && Math.abs(b.units - p.units) < 1e-6 ? null : { symbol: p.symbol, backupUnits: b?.units ?? 0, liveUnits: p.units };
      })
      .filter(Boolean);
    const droppedSinceBackup = (bAlphaBook?.positions ?? [])
      .filter((b) => b.units > 0 && isStock(b.symbol) && !stockPositions.some((p) => sameSymbol(p.symbol, b.symbol)))
      .map((b) => b.symbol);

    // Alpha entries recomputed after the fill (on/before cutDate, differing from the backup).
    const bByDate = new Map(bAlphaSeries.history.map((h) => [h.date, h]));
    const alphaRestores = liveAlphaSeries.history
      .filter((h) => h.date <= cutDate && bByDate.has(h.date))
      .filter((h) => {
        const b = bByDate.get(h.date)!;
        return Math.abs(b.value - h.value) > 1e-9 || Math.abs(b.dailyReturn - h.dailyReturn) > 1e-9;
      })
      .map((h) => ({ date: h.date, live: { value: h.value, dailyReturn: h.dailyReturn }, backup: { value: bByDate.get(h.date)!.value, dailyReturn: bByDate.get(h.date)!.dailyReturn } }));
    const alphaAfterCut = liveAlphaSeries.history.filter((h) => h.date > cutDate).map((h) => h.date);

    const stocksHistory: PimDailyReturn[] = bAlphaSeries.history.map((h) => ({ date: h.date, value: h.value, dailyReturn: h.dailyReturn }));
    stocksHistory[stocksHistory.length - 1].anchored = true;

    const summary = {
      backup: backupPath,
      backedUpAt: snap.backedUpAt,
      stocksSeries: {
        entries: stocksHistory.length,
        from: stocksHistory[0].date,
        through: cutDate,
        lastValue: stocksHistory[stocksHistory.length - 1].value,
        note: "copied from the Alpha series in the backup; the daily job adds the days after this on the Stocks book",
      },
      stocksBook: {
        positions: stockPositions.map((p) => ({ symbol: p.symbol, units: p.units, costBasis: p.costBasis })),
        cashBalance: liveAlphaBook.cashBalance || 0,
        leftOutOfStocksBook: leftOut,
      },
      checks: {
        backupAlphaBookNonStocks: backupNonStocks,
        backupAlphaBookWasStocksOnly: backupNonStocks.length === 0,
        stockUnitDifferencesVsBackup: unitDiffs,
        stocksInBackupNoLongerHeld: droppedSinceBackup,
        stocksSeriesAlreadyExists: stocksSeriesExists,
        stocksBookAlreadyExists: stocksBookExists,
      },
      alphaSeries: {
        anchoredAt: cutDate,
        entriesRestoredToBackup: alphaRestores,
        laterEntriesKept: alphaAfterCut,
        note: "Alpha = stocks only through the anchored date, stocks + Thematic funds from the next day",
      },
    };

    if (!confirm) return NextResponse.json({ dryRun: true, ...summary, next: "add &confirm=YES to write" });

    // ── Refusals before any write ──
    if (stocksSeriesExists || stocksBookExists) return NextResponse.json({ error: "a Stocks series or book already exists — nothing written", ...summary }, { status: 409 });
    if (backupNonStocks.length) return NextResponse.json({ error: `the backup's Alpha book held non-stocks (${backupNonStocks.join(", ")}) — its history is not stock-only; nothing written`, ...summary }, { status: 409 });
    if (!stockPositions.length) return NextResponse.json({ error: "the live Alpha book has no stock positions — nothing written", ...summary }, { status: 409 });

    const stamp = Date.now();
    await redis.set(`pm:pim-performance.pre-stocks-seed-${stamp}`, perfRaw);
    await redis.set(`pm:pim-positions.pre-stocks-seed-${stamp}`, posRaw);

    // Re-read right before writing; refuse if either key moved under us.
    const [perfNow, posNow] = await Promise.all([redis.get("pm:pim-performance"), redis.get("pm:pim-positions")]);
    if (perfNow !== perfRaw || posNow !== posRaw) return NextResponse.json({ error: "performance or positions changed while this ran — nothing written; re-run" }, { status: 409 });

    const nowIso = new Date().toISOString();
    const restoreMap = new Map(alphaRestores.map((r) => [r.date, r.backup]));
    const nextModels = perf.models.map((m) => {
      if (m.groupId !== GROUP || m.profile !== "alpha") return m;
      return {
        ...m,
        history: m.history.map((h) => {
          const r = restoreMap.get(h.date);
          const base = r ? { ...h, value: r.value, dailyReturn: r.dailyReturn } : h;
          return h.date === cutDate ? { ...base, anchored: true } : base;
        }),
      };
    });
    nextModels.push({ groupId: GROUP, profile: "stocks", history: stocksHistory, lastUpdated: nowIso });
    await redis.set("pm:pim-performance", JSON.stringify({ ...perf, models: nextModels, lastUpdated: nowIso }));

    await redis.set("pm:pim-positions", JSON.stringify({
      ...pos,
      portfolios: [
        ...pos.portfolios,
        {
          groupId: GROUP,
          profile: "stocks",
          positions: stockPositions.map((p) => ({ symbol: p.symbol, units: p.units, costBasis: p.costBasis })),
          cashBalance: liveAlphaBook.cashBalance || 0,
          lastUpdated: nowIso,
        },
      ],
    }));

    log.info(`Stocks book seeded: ${stocksHistory.length} entries through ${cutDate}, ${stockPositions.length} positions; ${alphaRestores.length} alpha entries restored`);
    return NextResponse.json({
      ok: true,
      ...summary,
      stashes: [`pm:pim-performance.pre-stocks-seed-${stamp}`, `pm:pim-positions.pre-stocks-seed-${stamp}`],
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: `seed failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
