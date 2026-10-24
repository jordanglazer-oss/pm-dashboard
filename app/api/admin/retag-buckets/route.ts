import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { readDraftStore } from "@/app/lib/model-drafts-store";
import { draftHasBuckets, sameSymbol, stagedBucket, MODEL_SUBSTITUTES, type ModelDraft, type StagingStock } from "@/app/lib/model-staging";
import { snapshotModels } from "@/app/lib/model-versions";
import { closeOn, closeOnOrBefore, dailyCloses } from "@/app/lib/historical-closes";
import { bookTargets, type PositionsBook } from "@/app/lib/staged-rebalance";
import { holdingBucket } from "@/app/lib/sleeve-targets";
import { POST as updateDailyValue } from "@/app/api/update-daily-value/route";
import { ZERO_SCORES, type Stock } from "@/app/lib/types";
import type { EquityBucket, PimModelData, PimPerformanceData } from "@/app/lib/pim-types";

/**
 * GET /api/admin/retag-buckets[?asOf=YYYY-MM-DD][&confirm=YES]
 *
 * Repairs what the Oct 2026 staged rebalance should have left behind, from the
 * LAST APPLIED three-bucket draft (pm:model-drafts history — its parsed rows
 * carry each name's Core / Thematic / Alpha bucket):
 *
 *   1. pm:pim-models — records `bucket` on every equity holding of every model
 *      (substitutes take their source's bucket). Nothing else changes; the
 *      models are snapshotted first (Review → Versions) and revision bumped.
 *   2. pm:stocks — every fund in a model gets its Core / Thematic designation,
 *      a missing fund record (e.g. QQQX.U, QQC.F) is created in Portfolio, and
 *      a name the draft exited that no model holds and no book still owns moves
 *      to the Watchlist. Read-merge-write; pre-image stashed.
 *   3. The Alpha book (pim|alpha positions) becomes everything outside Core —
 *      stocks + Thematic funds at the Alpha model's weights — sized at `asOf`'s
 *      close (default: the bucket model's start date). The book's value at that
 *      close is preserved; a fund takes the cost basis the other PIM books carry
 *      for it (else the asOf close). Then ONLY the pim|alpha performance series
 *      is cut at asOf (that entry anchored, later entries dropped) and the daily
 *      job recomputes the days after it on the new book. Pre-images stashed.
 *
 * Dry run by default: returns every change it would make. `&confirm=YES`
 * writes, in the order above. Stashes: pm:stocks / pm:pim-positions /
 * pm:pim-performance `.pre-retag-<ts>` (+ the model snapshot).
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const log = createLogger("Retag-buckets");
const GROUP = "pim";

const ccyOf = (symbol: string): "CAD" | "USD" => {
  const t = symbol.toUpperCase();
  if (t.endsWith(".U")) return "USD";
  if (t.endsWith("-T") || t.endsWith(".TO") || t.endsWith(".NE") || /^[A-Z]{2,4}\d{2,5}(-T)?$/.test(t)) return "CAD";
  return "USD";
};

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const confirm = url.searchParams.get("confirm") === "YES";
    const redis = await getRedis();

    // ── Source: the last applied three-bucket draft ──
    const store = await readDraftStore();
    const draft = (store.history as ModelDraft[]).find((d) => draftHasBuckets(d.parsed));
    if (!draft) return NextResponse.json({ error: "no applied three-bucket draft in pm:model-drafts history — nothing to re-tag from" }, { status: 409 });

    const [pimRaw, stocksRaw, posRaw, perfRaw] = await Promise.all([
      redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get("pm:pim-positions"), redis.get("pm:pim-performance"),
    ]);
    if (!pimRaw || !stocksRaw) return NextResponse.json({ error: "pm:pim-models or pm:stocks missing — nothing written" }, { status: 500 });
    const models = JSON.parse(pimRaw) as PimModelData;
    const stocks = JSON.parse(stocksRaw) as Stock[];
    const bucket = (sym: string): EquityBucket => stagedBucket(sym, stocks as unknown as StagingStock[], draft.parsed);

    // ── 1. Buckets on the model holdings ──
    const holdingChanges: string[] = [];
    const nextGroups = models.groups.map((g) => ({
      ...g,
      holdings: g.holdings.map((h) => {
        if (h.assetClass !== "equity") return h;
        const b = bucket(h.symbol);
        if (h.bucket !== b) holdingChanges.push(`${g.name ?? g.id} ${h.symbol}: ${h.bucket ?? "—"} → ${b}`);
        return { ...h, bucket: b };
      }),
    }));
    const nextModels: PimModelData = { ...models, groups: nextGroups };
    const nextPim = nextGroups.find((g) => g.id === GROUP);
    if (!nextPim) return NextResponse.json({ error: "no PIM model" }, { status: 500 });

    // ── 2. pm:stocks tags / missing records / exits ──
    const stockChanges: string[] = [];
    const nextStocks: Stock[] = stocks.map((s) => ({ ...s }));
    const inAnyModel = (sym: string) => nextGroups.some((g) => g.holdings.some((h) => sameSymbol(h.symbol, sym)));
    const fundSymbols = new Set<string>();
    for (const g of nextGroups) for (const h of g.holdings) if (h.assetClass === "equity" && h.bucket !== "alpha") fundSymbols.add(h.symbol);
    for (const sym of fundSymbols) {
      // A substitute (FINN, QQQM) carries its source's bucket.
      const want = bucket(sym) === "core" ? "core" : "thematic";
      const rec = nextStocks.find((s) => sameSymbol(s.ticker, sym));
      if (rec) {
        if (rec.instrumentType && rec.instrumentType !== "stock" && rec.designation !== want) {
          stockChanges.push(`${rec.ticker}: designation ${rec.designation ?? "—"} → ${want}`);
          rec.designation = want;
        }
        if (rec.bucket === "Watchlist") {
          stockChanges.push(`${rec.ticker}: Watchlist → Portfolio (held in a model)`);
          rec.bucket = "Portfolio";
        }
        continue;
      }
      // Only PIM's own funds get a new record; a substitute that lives only in
      // another model (FINN, QQQM) is tagged when it has one, never created.
      const h = nextPim.holdings.find((x) => sameSymbol(x.symbol, sym));
      if (!h) continue;
      const row = draft.parsed.find((r) => sameSymbol(r.symbol, sym));
      const ticker = sym.replace(/-T$/, ".TO");
      const isMf = /^[A-Z]{2,4}\d{2,5}(-T|\.TO)?$/i.test(sym);
      stockChanges.push(`${ticker}: record created (${want}, Portfolio)`);
      nextStocks.push({
        ticker,
        name: row?.name ?? h.name,
        instrumentType: isMf ? "mutual-fund" : "etf",
        bucket: "Portfolio",
        sector: "",
        beta: 1.0,
        weights: { portfolio: 0 },
        scores: { ...ZERO_SCORES },
        notes: "",
        designation: want,
      } as Stock);
    }
    const books = ((posRaw ? JSON.parse(posRaw) : { portfolios: [] }) as { portfolios: PositionsBook[] } & Record<string, unknown>);
    const heldInBook = (sym: string) => books.portfolios.some((b) => b.positions.some((p) => p.units > 0 && sameSymbol(p.symbol, sym)));
    const exited = new Set(Object.values(draft.exits ?? {}).flat());
    const stillOwned: string[] = [];
    for (const sym of exited) {
      if (inAnyModel(sym)) continue;
      const rec = nextStocks.find((s) => sameSymbol(s.ticker, sym));
      if (!rec || rec.bucket !== "Portfolio") continue;
      if (heldInBook(sym)) { stillOwned.push(rec.ticker); continue; }
      stockChanges.push(`${rec.ticker}: Portfolio → Watchlist (left every model)`);
      rec.bucket = "Watchlist";
      rec.weights = { ...(rec.weights ?? {}), portfolio: 0 };
    }

    // ── 3. Alpha book = everything outside Core, at asOf's close ──
    const asOf = url.searchParams.get("asOf") ?? (models.sleeveTargets?.since ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return NextResponse.json({ error: "asOf (YYYY-MM-DD) required — no bucket-model start date on file" }, { status: 400 });
    const alphaBook = books.portfolios.find((b) => b.groupId === GROUP && b.profile === "alpha");
    const targets = bookTargets(nextPim, "alpha", (sym) => holdingBucket(nextPim.holdings.find((h) => sameSymbol(h.symbol, sym)) ?? { symbol: sym }, stocks));
    const syms = new Set<string>([...targets.map((t) => t.h.symbol), ...(alphaBook?.positions ?? []).filter((p) => p.units > 0).map((p) => p.symbol)]);
    const closes = new Map<string, number | null>();
    await Promise.all([...syms].map(async (s) => { closes.set(s, closeOn(await dailyCloses(s), asOf)); }));
    const fx = closeOnOrBefore(await dailyCloses("USDCAD=X"), asOf);
    const ccy = (sym: string) => nextPim.holdings.find((h) => sameSymbol(h.symbol, sym))?.currency ?? ccyOf(sym);
    const cad = (sym: string) => { const c = closes.get(sym); return c == null || !fx ? null : c * (ccy(sym) === "USD" ? fx : 1); };
    const missingPx = [...syms].filter((s) => cad(s) == null);
    let alphaPlan: { symbol: string; unitsBefore: number; unitsAfter: number; pct: number; costBasis: number }[] = [];
    let bookValue = 0;
    if (alphaBook && !missingPx.length) {
      bookValue = (alphaBook.cashBalance || 0) + alphaBook.positions.reduce((a, p) => a + p.units * (cad(p.symbol) ?? 0), 0);
      const sharedCb = (sym: string) =>
        books.portfolios.filter((b) => b.groupId === GROUP && b.profile !== "alpha").flatMap((b) => b.positions).find((p) => p.units > 0 && sameSymbol(p.symbol, sym))?.costBasis;
      alphaPlan = targets.map((t) => {
        const existing = alphaBook.positions.find((p) => sameSymbol(p.symbol, t.h.symbol));
        const unitsAfter = parseFloat(((bookValue * t.pct) / cad(t.h.symbol)!).toFixed(6));
        const unitsBefore = existing?.units ?? 0;
        // Trim → cost per unit unchanged; add → the shared book cost (else asOf close).
        const addCb = sharedCb(t.h.symbol) ?? cad(t.h.symbol)!;
        const costBasis = existing && unitsAfter <= unitsBefore
          ? existing.costBasis
          : parseFloat((((unitsBefore * (existing?.costBasis ?? 0)) + (unitsAfter - unitsBefore) * addCb) / unitsAfter).toFixed(4));
        return { symbol: existing?.symbol ?? t.h.symbol, unitsBefore, unitsAfter, pct: t.pct, costBasis };
      });
    }
    const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
    const alphaSeries = perf?.models.find((m) => m.groupId === GROUP && m.profile === "alpha");
    const alphaHasAsOf = !!alphaSeries?.history.some((h) => h.date === asOf);

    const summary = {
      draft: { id: draft.id, name: draft.name, appliedAt: draft.appliedAt },
      models: { holdingBucketChanges: holdingChanges.length, changes: holdingChanges },
      stocks: { changes: stockChanges, exitedButStillOwnedInABook: stillOwned },
      alphaBook: {
        asOf,
        usdCad: fx,
        bookValueCadAtAsOf: Math.round(bookValue),
        missingPrices: missingPx,
        alphaSeriesHasAsOf: alphaHasAsOf,
        dropsAlphaEntriesAfterAsOf: alphaSeries?.history.filter((h) => h.date > asOf).map((h) => h.date) ?? [],
        rows: alphaPlan.map((r) => ({ ...r, pct: parseFloat((r.pct * 100).toFixed(3)) })),
      },
    };
    if (!confirm) return NextResponse.json({ dryRun: true, ...summary, next: "add &confirm=YES to write" });

    // ── Refusals before any write ──
    if (!alphaBook) return NextResponse.json({ error: "no pim|alpha positions book — nothing written", ...summary }, { status: 409 });
    if (missingPx.length) return NextResponse.json({ error: `no ${asOf} close for ${missingPx.join(", ")} — nothing written`, ...summary }, { status: 409 });
    if (!alphaHasAsOf) return NextResponse.json({ error: `the Alpha series has no ${asOf} entry to anchor at — nothing written`, ...summary }, { status: 409 });

    const stamp = Date.now();
    const trace: string[] = [];
    // 1. Models (snapshot first, revision bumped so stale tabs reload).
    const versionId = await snapshotModels("manual", `before bucket re-tag from "${draft.name}"`);
    if (!versionId) return NextResponse.json({ error: "could not snapshot the models — nothing written" }, { status: 500 });
    const fresh = JSON.parse((await redis.get("pm:pim-models"))!) as PimModelData;
    if ((fresh.revision ?? 0) !== (models.revision ?? 0)) return NextResponse.json({ error: "the models changed while this ran — re-run the dry run" }, { status: 409 });
    await redis.set("pm:pim-models", JSON.stringify({ ...nextModels, revision: (models.revision ?? 0) + 1, lastUpdated: new Date().toISOString() }));
    trace.push(`models: ${holdingChanges.length} holding buckets recorded (snapshot ${versionId})`);

    // 2. Stocks (stash; the stale-tab guard makes open tabs merge onto this).
    await redis.set(`pm:stocks.pre-retag-${stamp}`, stocksRaw);
    const stocksNow = await redis.get("pm:stocks");
    if (stocksNow !== stocksRaw) return NextResponse.json({ error: "pm:stocks changed while this ran — models were tagged; re-run to finish the stock tags", trace }, { status: 409 });
    if (stockChanges.length) await redis.set("pm:stocks", JSON.stringify(nextStocks));
    trace.push(`stocks: ${stockChanges.length} changes`);

    // 3. Alpha book + Alpha series cut.
    await redis.set(`pm:pim-positions.pre-retag-${stamp}`, posRaw!);
    await redis.set(`pm:pim-performance.pre-retag-${stamp}`, perfRaw!);
    const nextBook: PositionsBook = {
      ...alphaBook,
      positions: alphaPlan.filter((r) => r.unitsAfter > 0).map((r) => ({ symbol: r.symbol, units: r.unitsAfter, costBasis: r.costBasis })),
      cashBalance: 0,
      lastUpdated: new Date().toISOString(),
    };
    await redis.set("pm:pim-positions", JSON.stringify({
      ...books,
      portfolios: books.portfolios.map((b) => (b.groupId === GROUP && b.profile === "alpha" ? nextBook : b)),
    }));
    const perfNow = JSON.parse((await redis.get("pm:pim-performance"))!) as PimPerformanceData;
    for (const m of perfNow.models) {
      if (m.groupId !== GROUP || m.profile !== "alpha") continue;
      m.history = m.history.filter((h) => h.date <= asOf);
      const last = m.history[m.history.length - 1];
      if (last) last.anchored = true;
    }
    await redis.set("pm:pim-performance", JSON.stringify({ ...perfNow, lastUpdated: new Date().toISOString() }));
    trace.push(`alpha book: ${nextBook.positions.length} positions at ${asOf}'s close; alpha series cut at ${asOf}`);
    try { await updateDailyValue(); trace.push("performance refreshed (days after asOf recomputed on the new Alpha book)"); }
    catch (e) { log.warn("refresh failed:", e); trace.push("performance refresh failed — open Performance and Refresh"); }

    log.info(`re-tag applied from "${draft.name}": ${holdingChanges.length} holdings, ${stockChanges.length} stock changes, alpha book at ${asOf}`);
    return NextResponse.json({
      ok: true, ...summary, trace,
      stashes: [`pm:stocks.pre-retag-${stamp}`, `pm:pim-positions.pre-retag-${stamp}`, `pm:pim-performance.pre-retag-${stamp}`],
      modelSnapshot: versionId,
      substitutesNote: Object.values(MODEL_SUBSTITUTES).flat().map((s) => `${s.local.join("/")} follows ${s.source}`),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "re-tag failed" }, { status: 500 });
  }
}
