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
 * record to that date IS the stock-only record. On the evening of 2026-11-11
 * the Thematic funds were added to the Alpha book ("Add N at model weight");
 * the daily job's 2-day recalc window then recomputed the last Alpha days on
 * the new book. pm:pim-performance is NOT in the nightly backups (derived), but
 * the settled ledger pm:appendix-daily-values IS — so the pre-fill backup's
 * Alpha ledger (default backups/2026-11-11T22-56-27-248Z.json, taken just
 * before the merge that shipped "Add N") is the source of truth:
 *
 *   1. Stocks SERIES (pim|stocks) = the live Alpha series up to the backup
 *      ledger's last date ("cut date"), with every date the ledger covers taken
 *      from the ledger (undoing any post-fill recompute). Last entry anchored;
 *      the daily job computes the days after it on the Stocks book. A matching
 *      Appendix ledger is written so the Appendix agrees.
 *   2. Stocks BOOK = the live Alpha book's stock positions, units/cost
 *      untouched (today's Positioning weights), with the Alpha book's cash.
 *   3. Alpha SERIES + Appendix ledger: dates on/before the cut date that were
 *      recomputed after the fill are restored from the backup ledger, the cut
 *      date is anchored, and later entries keep their daily returns with values
 *      re-chained from the restored level.
 *
 * Dry run by default. `&confirm=YES` writes. Refuses if a Stocks series or book
 * already exists, if the backup's Alpha book held anything but stocks, or if
 * the live series and the backup ledger disagree on any date more than 10 days
 * before the cut date (then they are not the same record). Stashes
 * pm:pim-performance / pm:pim-positions / pm:appendix-daily-values
 * `.pre-stocks-seed-<ts>` first.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Seed-stocks-book");
const GROUP = "pim";
const DEFAULT_BACKUP = "backups/2026-11-11T22-56-27-248Z.json";

type PositionsBlob = { portfolios: PimPortfolioPositions[] } & Record<string, unknown>;
type StockLite = { ticker: string; designation?: "core" | "alpha" | "thematic" };
type LedgerEntry = { date: string; value: number; dailyReturn: number; addedAt?: string };
type AppendixBlob = { ledgers: { profile: string; entries: LedgerEntry[] }[] } & Record<string, unknown>;
const differs = (a: { value: number; dailyReturn: number }, b: { value: number; dailyReturn: number }) =>
  Math.abs(a.dailyReturn - b.dailyReturn) > 0.0001 || Math.abs(a.value - b.value) > Math.max(1e-6, Math.abs(b.value) * 1e-7);
const daysBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 86400000;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const confirm = url.searchParams.get("confirm") === "YES";
    const backupPath = url.searchParams.get("backup") || DEFAULT_BACKUP;
    const redis = await getRedis();

    const [perfRaw, posRaw, appRaw, modelsRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-performance"),
      redis.get("pm:pim-positions"),
      redis.get("pm:appendix-daily-values"),
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!perfRaw || !posRaw || !appRaw || !modelsRaw) return NextResponse.json({ error: "performance, positions, appendix or models missing — nothing written" }, { status: 409 });
    const perf = JSON.parse(perfRaw) as PimPerformanceData;
    const pos = JSON.parse(posRaw) as PositionsBlob;
    const app = JSON.parse(appRaw) as AppendixBlob;
    const models = JSON.parse(modelsRaw) as PimModelData;
    const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as StockLite[];
    const bt = bucketTests(stocks, models);
    const isStock = (sym: string) => !bt.isCore(sym) && !bt.isThematic(sym);

    // ── Backup (pre-fill): the settled Alpha ledger + the Alpha book ──
    const snap = await readBackupBlob(backupPath);
    const bAppRaw = snap.data["pm:appendix-daily-values"];
    const bPosRaw = snap.data["pm:pim-positions"];
    if (!bAppRaw || !bPosRaw) return NextResponse.json({ error: `backup ${backupPath} has no appendix ledger or positions — nothing written` }, { status: 409 });
    const bApp = JSON.parse(bAppRaw) as AppendixBlob;
    const bPos = JSON.parse(bPosRaw) as PositionsBlob;
    const bLedger = [...(bApp.ledgers.find((l) => l.profile === "alpha")?.entries ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const bAlphaBook = bPos.portfolios.find((b) => b.groupId === GROUP && b.profile === "alpha");
    if (bLedger.length < 2) return NextResponse.json({ error: "backup has no Alpha ledger — nothing written" }, { status: 409 });
    const backupNonStocks = (bAlphaBook?.positions ?? []).filter((p) => p.units > 0 && !isStock(p.symbol)).map((p) => p.symbol);
    const cutDate = bLedger[bLedger.length - 1].date;
    const bByDate = new Map(bLedger.map((e) => [e.date, e]));

    // ── Live ──
    const liveAlphaSeries = perf.models.find((m) => m.groupId === GROUP && m.profile === "alpha");
    const liveAlphaBook = pos.portfolios.find((b) => b.groupId === GROUP && b.profile === "alpha");
    const stocksSeriesExists = perf.models.some((m) => m.groupId === GROUP && (m.profile as string) === "stocks");
    const stocksBookExists = pos.portfolios.some((b) => b.groupId === GROUP && (b.profile as string) === "stocks");
    const stocksLedgerExists = app.ledgers.some((l) => l.profile === "stocks");
    if (!liveAlphaSeries || !liveAlphaBook) return NextResponse.json({ error: "no live Alpha series or book — nothing written" }, { status: 409 });

    const stockPositions = liveAlphaBook.positions.filter((p) => p.units > 0 && isStock(p.symbol));
    const leftOut = liveAlphaBook.positions.filter((p) => p.units > 0 && !isStock(p.symbol)).map((p) => p.symbol);
    const unitDiffs = stockPositions
      .map((p) => {
        const b = bAlphaBook?.positions.find((x) => sameSymbol(x.symbol, p.symbol));
        return b && Math.abs(b.units - p.units) < 1e-6 ? null : { symbol: p.symbol, backupUnits: b?.units ?? 0, liveUnits: p.units };
      })
      .filter(Boolean);
    const droppedSinceBackup = (bAlphaBook?.positions ?? [])
      .filter((b) => b.units > 0 && isStock(b.symbol) && !stockPositions.some((p) => sameSymbol(p.symbol, b.symbol)))
      .map((b) => b.symbol);

    // Live Alpha series vs the backup ledger, on every date the ledger covers.
    const mismatches = liveAlphaSeries.history
      .filter((h) => bByDate.has(h.date) && differs(h, bByDate.get(h.date)!))
      .map((h) => ({ date: h.date, live: { value: h.value, dailyReturn: h.dailyReturn }, backup: { value: bByDate.get(h.date)!.value, dailyReturn: bByDate.get(h.date)!.dailyReturn } }));
    const oldMismatches = mismatches.filter((m) => daysBetween(m.date, cutDate) > 10);
    const missingInLive = bLedger.filter((e) => !liveAlphaSeries.history.some((h) => h.date === e.date)).map((e) => e.date);

    // Stocks history: live Alpha up to the cut date, ledger values wherever the ledger has the date.
    const upToCut = new Map<string, PimDailyReturn>();
    for (const h of liveAlphaSeries.history) if (h.date <= cutDate) upToCut.set(h.date, { date: h.date, value: h.value, dailyReturn: h.dailyReturn });
    for (const e of bLedger) upToCut.set(e.date, { date: e.date, value: e.value, dailyReturn: e.dailyReturn });
    const stocksHistory = [...upToCut.values()].sort((a, b) => a.date.localeCompare(b.date));
    stocksHistory[stocksHistory.length - 1] = { ...stocksHistory[stocksHistory.length - 1], anchored: true };

    // Alpha: restored through the cut date, later days re-chained from the restored level.
    const restoredAlpha: PimDailyReturn[] = [];
    let prevValue: number | null = null;
    for (const h of liveAlphaSeries.history) {
      let next: PimDailyReturn;
      if (h.date <= cutDate) {
        const b = bByDate.get(h.date);
        next = b ? { ...h, value: b.value, dailyReturn: b.dailyReturn } : { ...h };
        if (h.date === cutDate) next.anchored = true;
      } else {
        next = { ...h, value: prevValue != null ? prevValue * (1 + h.dailyReturn / 100) : h.value };
      }
      restoredAlpha.push(next);
      prevValue = next.value;
    }
    const rechained = restoredAlpha
      .filter((h) => h.date > cutDate)
      .map((h) => ({ date: h.date, dailyReturn: h.dailyReturn, valueBefore: liveAlphaSeries.history.find((x) => x.date === h.date)!.value, valueAfter: +h.value.toFixed(6) }));

    const summary = {
      backup: backupPath,
      backedUpAt: snap.backedUpAt,
      cutDate,
      stocksSeries: {
        entries: stocksHistory.length,
        from: stocksHistory[0].date,
        through: cutDate,
        lastValue: stocksHistory[stocksHistory.length - 1].value,
        note: "the Alpha record through the cut date (backup ledger wins); the daily job adds the days after it on the Stocks book",
      },
      stocksBook: {
        positions: stockPositions.map((p) => ({ symbol: p.symbol, units: p.units, costBasis: p.costBasis })),
        cashBalance: liveAlphaBook.cashBalance || 0,
        leftOutOfStocksBook: leftOut,
      },
      checks: {
        backupAlphaBookWasStocksOnly: backupNonStocks.length === 0,
        backupAlphaBookNonStocks: backupNonStocks,
        stockUnitDifferencesVsBackup: unitDiffs,
        stocksInBackupNoLongerHeld: droppedSinceBackup,
        liveVsBackupMismatchedDates: mismatches,
        mismatchesOlderThan10Days: oldMismatches.map((m) => m.date),
        backupLedgerDatesMissingInLive: missingInLive,
        stocksAlreadyExists: stocksSeriesExists || stocksBookExists || stocksLedgerExists,
      },
      alphaSeries: {
        anchoredAt: cutDate,
        datesRestoredFromBackup: mismatches.map((m) => m.date),
        laterDaysRechained: rechained,
        note: "Alpha = stocks only through the cut date; stocks + Thematic funds after it",
      },
    };

    if (!confirm) return NextResponse.json({ dryRun: true, ...summary, next: "add &confirm=YES to write" });

    // ── Refusals before any write ──
    if (stocksSeriesExists || stocksBookExists || stocksLedgerExists) return NextResponse.json({ error: "a Stocks series, book or ledger already exists — nothing written", ...summary }, { status: 409 });
    if (backupNonStocks.length) return NextResponse.json({ error: `the backup's Alpha book held non-stocks (${backupNonStocks.join(", ")}) — its history is not stock-only; nothing written`, ...summary }, { status: 409 });
    if (oldMismatches.length) return NextResponse.json({ error: "the live Alpha series and the backup ledger disagree more than 10 days before the cut date — nothing written", ...summary }, { status: 409 });
    if (!stockPositions.length) return NextResponse.json({ error: "the live Alpha book has no stock positions — nothing written", ...summary }, { status: 409 });

    const stamp = Date.now();
    await redis.set(`pm:pim-performance.pre-stocks-seed-${stamp}`, perfRaw);
    await redis.set(`pm:pim-positions.pre-stocks-seed-${stamp}`, posRaw);
    await redis.set(`pm:appendix-daily-values.pre-stocks-seed-${stamp}`, appRaw);

    // Re-read right before writing; refuse if any key moved under us.
    const [perfNow, posNow, appNow] = await Promise.all([redis.get("pm:pim-performance"), redis.get("pm:pim-positions"), redis.get("pm:appendix-daily-values")]);
    if (perfNow !== perfRaw || posNow !== posRaw || appNow !== appRaw) return NextResponse.json({ error: "performance, positions or appendix changed while this ran — nothing written; re-run" }, { status: 409 });

    const nowIso = new Date().toISOString();
    const nextModels = perf.models.map((m) => (m.groupId === GROUP && m.profile === "alpha" ? { ...m, history: restoredAlpha, lastUpdated: nowIso } : m));
    nextModels.push({ groupId: GROUP, profile: "stocks", history: stocksHistory, lastUpdated: nowIso });
    await redis.set("pm:pim-performance", JSON.stringify({ ...perf, models: nextModels, lastUpdated: nowIso }));

    // Appendix: Alpha ledger follows the restored series; a Stocks ledger mirrors the Stocks series.
    const alphaByDate = new Map(restoredAlpha.map((h) => [h.date, h]));
    const nextLedgers = app.ledgers.map((l) => {
      if (l.profile !== "alpha") return l;
      return { ...l, entries: l.entries.map((e) => { const h = alphaByDate.get(e.date); return h ? { ...e, value: h.value, dailyReturn: h.dailyReturn } : e; }) };
    });
    nextLedgers.push({
      profile: "stocks",
      entries: stocksHistory.filter((h) => bByDate.has(h.date)).map((h) => ({ date: h.date, value: h.value, dailyReturn: h.dailyReturn, addedAt: bByDate.get(h.date)!.addedAt ?? nowIso })),
    });
    await redis.set("pm:appendix-daily-values", JSON.stringify({ ...app, ledgers: nextLedgers }));

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

    log.info(`Stocks book seeded: ${stocksHistory.length} entries through ${cutDate}, ${stockPositions.length} positions; ${mismatches.length} alpha dates restored, ${rechained.length} re-chained`);
    return NextResponse.json({
      ok: true,
      ...summary,
      stashes: [`pm:pim-performance.pre-stocks-seed-${stamp}`, `pm:pim-positions.pre-stocks-seed-${stamp}`, `pm:appendix-daily-values.pre-stocks-seed-${stamp}`],
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: `seed failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
