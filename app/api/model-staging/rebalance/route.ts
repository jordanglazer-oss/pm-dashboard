import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { getTodayET } from "@/app/lib/market-hours";
import { readDraftStore } from "@/app/lib/model-drafts-store";
import { sameSymbol, stagedBucket, type StagingStock } from "@/app/lib/model-staging";
import { applyDraft, prevWeekday } from "@/app/lib/staged-apply";
import { closeBefore, closeOn, closeOnOrBefore, dailyCloses, isFundservSymbol } from "@/app/lib/historical-closes";
import { planBook, type BookPlan, type PlanPrices, type PositionsBook } from "@/app/lib/staged-rebalance";
import { POST as updateDailyValue } from "@/app/api/update-daily-value/route";
import type { PimModelData, PimModelGroup, PimPerformanceData, PimPortfolioState, PimTransaction } from "@/app/lib/pim-types";

/**
 * POST /api/model-staging/rebalance — apply the active Stage-changes draft AND
 * record the rebalance the desk already traded on `asOf` (the previous trading
 * day). Rules: app/lib/staged-rebalance.ts.
 *
 *   { mode: "plan", draftId, asOf }
 *     → dry run, NO writes: prices (prior close for sizing, asOf close / NAV),
 *       every PIM book's trades, and the symbols that need an average price.
 *
 *   { mode: "commit", draftId, asOf, expectedRevision, execPrices: {sym: price},
 *     confirm: "REBALANCE <asOf>" }
 *     1. refresh performance (update-daily-value) so `asOf` is recorded on the
 *        OLD holdings, and refuse unless every PIM series has an `asOf` entry;
 *     2. stash pm:pim-performance, then ANCHOR each series' last entry on or
 *        before `asOf` and drop entries after it (they were computed on the
 *        old holdings) — the cutover is `asOf`'s close;
 *     3. applyDraft (revision guard, validation, model snapshot, bucket
 *        targets, Thematic series based at `asOf`);
 *     4. stash pm:pim-positions + pm:pim-portfolio-state, then write every PIM
 *        book's units / cost basis (read-merge-write; other groups and fields
 *        untouched) and the transactions + lastRebalance dated `asOf`;
 *     5. refresh performance again so today is computed on the new holdings.
 *
 * Writes pm:pim-performance, pm:pim-models (+ version snapshot),
 * pm:model-drafts, pm:pim-positions, pm:pim-portfolio-state — each pre-image
 * stashed at `<key>.pre-staged-rebalance-<ts>` (models: the version history).
 * Never pm:stocks — the client tags roles and moves exited names afterwards.
 */

const log = createLogger("Staged-rebalance");
const GROUP = "pim";

type Body = {
  mode?: "plan" | "commit";
  draftId?: string;
  asOf?: string;
  expectedRevision?: number;
  execPrices?: Record<string, number>;
  confirm?: string;
  /** Models to write (the ones that differ from live); PIM always included. */
  groupIds?: string[];
};

function validAsOf(asOf: string | undefined): string | null {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "asOf (YYYY-MM-DD) required";
  const today = getTodayET();
  if (asOf !== prevWeekday(today)) return `the rebalance date must be the previous trading day (${prevWeekday(today)}) — performance can only be cut over within its 2-day recalc window`;
  return null;
}

async function buildPlan(body: Body) {
  const store = await readDraftStore();
  const draft = store.active;
  if (!draft || draft.id !== body.draftId) return { error: "that draft is not the active one", status: 404 } as const;
  const pimStaged = draft.models[GROUP];
  if (!pimStaged) return { error: "the draft has no PIM model", status: 400 } as const;

  const redis = await getRedis();
  const [pimRaw, posRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:pim-positions"), redis.get("pm:stocks")]);
  const models = pimRaw ? (JSON.parse(pimRaw) as PimModelData) : null;
  const livePim = models?.groups.find((g) => g.id === GROUP);
  if (!models || !livePim) return { error: "no live PIM model", status: 500 } as const;
  const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as StagingStock[];
  const positions = (posRaw ? JSON.parse(posRaw) : { portfolios: [] }) as { portfolios: PositionsBook[] };
  const books = positions.portfolios.filter((p) => p.groupId === GROUP);
  if (books.length === 0) return { error: "no PIM positions on file", status: 400 } as const;

  const newPim: PimModelGroup = { ...livePim, holdings: pimStaged.holdings };
  const bucket = (sym: string) => stagedBucket(sym, stocks, draft.parsed);

  // Prices for every symbol any book holds or will hold.
  const syms = new Set<string>(newPim.holdings.map((h) => h.symbol));
  for (const b of books) for (const p of b.positions) if (p.units > 0) syms.add(p.symbol);
  const asOf = body.asOf!;
  const fetched = await Promise.all([...syms].map(async (s) => [s, await dailyCloses(s)] as const));
  const fx = await dailyCloses("USDCAD=X");
  const prices: PlanPrices = { sizing: {}, asOf: {}, fxSizing: closeOnOrBefore(fx, prevWeekday(asOf)), fxAsOf: closeOnOrBefore(fx, asOf) };
  for (const [s, c] of fetched) {
    prices.sizing[s] = closeBefore(c, asOf);
    prices.asOf[s] = closeOn(c, asOf);
  }

  const plans: BookPlan[] = books.map((b) => planBook(b, newPim, bucket, prices));
  // One row per traded symbol across books — the price the PM enters once.
  const symbols = [...syms].map((s) => {
    const traded = plans.some((p) => p.rows.some((r) => r.symbol === s && r.action !== "HOLD"));
    const mf = isFundservSymbol(s);
    return {
      symbol: s,
      name: newPim.holdings.find((h) => h.symbol === s)?.name ?? s,
      isMF: mf,
      traded,
      sizingClose: prices.sizing[s] ?? null,
      asOfClose: prices.asOf[s] ?? null,
      netUnits: plans.reduce((a, p) => a + (p.rows.find((r) => r.symbol === s)?.deltaUnits ?? 0), 0),
      needsPrice: traded && !mf,
    };
  });
  return { draft, models, newPim, books, plans, prices, symbols, positions, redis } as const;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const bad = validAsOf(body.asOf);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    const plan = await buildPlan(body);
    if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: plan.status });
    const problems = plan.plans.flatMap((p) => p.problems.map((x) => `${p.profile}: ${x}`));
    if (!plan.prices.fxSizing || !plan.prices.fxAsOf) problems.push("no USD/CAD close for the sizing day or the trade day");

    if (body.mode !== "commit") {
      return NextResponse.json({
        asOf: body.asOf,
        sizingDate: prevWeekday(body.asOf!),
        fx: { sizing: plan.prices.fxSizing, asOf: plan.prices.fxAsOf },
        symbols: plan.symbols,
        books: plan.plans,
        problems,
        revision: plan.models.revision ?? 0,
      });
    }

    // ── Commit ──
    const asOf = body.asOf!;
    if (body.confirm !== `REBALANCE ${asOf}`) return NextResponse.json({ error: `type REBALANCE ${asOf} to confirm` }, { status: 400 });
    if (problems.length) return NextResponse.json({ error: "the trade list has problems — nothing written", problems }, { status: 409 });
    const exec: Record<string, number> = {};
    const missing: string[] = [];
    for (const s of plan.symbols) {
      if (!s.traded) continue;
      if (s.isMF) { if (s.asOfClose) exec[s.symbol] = s.asOfClose; else missing.push(`${s.symbol} (no NAV for ${asOf})`); continue; }
      const p = Number(body.execPrices?.[s.symbol]);
      if (Number.isFinite(p) && p > 0) exec[s.symbol] = p;
      else missing.push(s.symbol);
    }
    if (missing.length) return NextResponse.json({ error: "average prices missing — nothing written", missing }, { status: 400 });
    if (plan.models.revision !== body.expectedRevision) {
      return NextResponse.json({ error: "the live models changed since you reviewed this — rebuild the trade list", revision: plan.models.revision ?? 0 }, { status: 409 });
    }
    const { redis } = plan;
    const stamp = Date.now();

    // 1. Record asOf on the OLD holdings, and require it.
    try { await updateDailyValue(); } catch (e) { log.warn("pre-commit performance refresh failed:", e); }
    const perfRaw = await redis.get("pm:pim-performance");
    if (!perfRaw) return NextResponse.json({ error: "no performance data on file — nothing written" }, { status: 409 });
    const perf = JSON.parse(perfRaw) as PimPerformanceData;
    const bookProfiles = new Set(plan.books.map((b) => b.profile));
    const unrecorded = perf.models
      .filter((m) => m.groupId === GROUP && bookProfiles.has(m.profile))
      .filter((m) => !m.history.some((h) => h.date === asOf))
      .map((m) => m.profile);
    if (unrecorded.length) {
      return NextResponse.json({ error: `performance for ${asOf} isn't recorded yet for: ${unrecorded.join(", ")} — open Performance and Refresh, then try again. Nothing written.` }, { status: 409 });
    }

    // 2. Cut performance over at asOf's close.
    await redis.set(`pm:pim-performance.pre-staged-rebalance-${stamp}`, perfRaw);
    let anchored = 0;
    let dropped = 0;
    for (const m of perf.models) {
      const before = m.history.length;
      m.history = m.history.filter((h) => h.date <= asOf);
      dropped += before - m.history.length;
      const last = m.history[m.history.length - 1];
      if (last && !last.anchored) { last.anchored = true; anchored++; }
    }
    await redis.set("pm:pim-performance", JSON.stringify({ ...perf, lastUpdated: new Date().toISOString() }));

    // 3. Models.
    const groupIds = Array.isArray(body.groupIds) ? [...new Set([...body.groupIds, GROUP])] : undefined;
    const applied = await applyDraft({ draft: plan.draft, expectedRevision: body.expectedRevision, groupIds, effectiveDate: asOf, note: `before staged rebalance "${plan.draft.name}" as of ${asOf}` });
    if (!applied.ok) return NextResponse.json({ ...applied.body, note: `performance was cut over at ${asOf} (pre-image pm:pim-performance.pre-staged-rebalance-${stamp}); models and positions untouched` }, { status: applied.status });

    // 4. Positions + state (fresh reads; read-merge-write).
    const [posRaw2, stateRaw] = await Promise.all([redis.get("pm:pim-positions"), redis.get("pm:pim-portfolio-state")]);
    if (posRaw2) await redis.set(`pm:pim-positions.pre-staged-rebalance-${stamp}`, posRaw2);
    if (stateRaw) await redis.set(`pm:pim-portfolio-state.pre-staged-rebalance-${stamp}`, stateRaw);
    const positions = (posRaw2 ? JSON.parse(posRaw2) : { portfolios: [] }) as { portfolios: PositionsBook[] } & Record<string, unknown>;
    const fxAsOf = plan.prices.fxAsOf!;
    const at = `${asOf}T20:00:00.000Z`; // 4 pm ET close
    const execCad = (sym: string, ccy: "CAD" | "USD") => exec[sym] * (ccy === "USD" ? fxAsOf : 1);

    // Shared ACB: a symbol bought in several books takes one cost basis — the
    // first book (in this order) that bought it, like the existing Rebalance.
    const order = ["allEquity", "balanced", "growth", "conservative", "alpha", "core"];
    const sortedPlans = [...plan.plans].sort((a, b) => (order.indexOf(a.profile) + 1 || 99) - (order.indexOf(b.profile) + 1 || 99));
    const sharedCb = new Map<string, number>();
    const nextBooks = new Map<string, PositionsBook>();
    const transactions: PimTransaction[] = [];
    for (const bp of sortedPlans) {
      const book = positions.portfolios.find((p) => p.groupId === GROUP && p.profile === bp.profile);
      if (!book) continue;
      // Keyed by the STORED symbol form (FID5982 vs FID5982-T are one position).
      const pos = new Map(book.positions.map((p) => [p.symbol, { ...p }]));
      for (const r of bp.rows) {
        if (r.action === "HOLD") continue;
        const existing = [...pos.values()].find((p) => sameSymbol(p.symbol, r.symbol));
        const key = existing?.symbol ?? r.symbol;
        const oldU = existing?.units ?? 0;
        const oldCb = existing?.costBasis ?? 0;
        const newU = r.unitsAfter;
        let cb = oldCb;
        if (r.action === "BUY" && newU > 0) cb = parseFloat(((oldU * oldCb + (newU - oldU) * execCad(r.symbol, r.currency)) / newU).toFixed(4));
        if (r.action === "BUY" && ![...sharedCb.keys()].some((k) => sameSymbol(k, key))) sharedCb.set(key, cb);
        pos.set(key, { symbol: key, units: newU, costBasis: cb });
        transactions.push({
          id: `sr-${stamp.toString(36)}-${bp.profile}-${r.symbol}`,
          date: at,
          groupId: GROUP,
          type: "rebalance",
          symbol: key,
          direction: r.action === "BUY" ? "buy" : "sell",
          price: exec[r.symbol],
          targetWeight: r.modelPct,
          notes: `Staged rebalance "${plan.draft.name}"${r.exit ? " — exit" : ""}${r.isMF ? ` — NAV ${asOf}` : ""}`,
          status: "settled",
          profile: bp.profile as PimTransaction["profile"],
          settledAt: at,
        });
      }
      nextBooks.set(bp.profile, { ...book, positions: [...pos.values()].filter((p) => p.units > 0), lastUpdated: new Date().toISOString() });
    }
    // Apply the shared cost basis to every PIM book holding the symbol.
    for (const [profile, b] of nextBooks) {
      nextBooks.set(profile, {
        ...b,
        positions: b.positions.map((p) => {
          const k = [...sharedCb.keys()].find((x) => sameSymbol(x, p.symbol));
          return k ? { ...p, costBasis: sharedCb.get(k)! } : p;
        }),
      });
    }
    const nextPositions = {
      ...positions,
      portfolios: positions.portfolios.map((p) => (p.groupId === GROUP && nextBooks.has(p.profile) ? nextBooks.get(p.profile)! : p)),
    };
    await redis.set("pm:pim-positions", JSON.stringify(nextPositions));

    const state = (stateRaw ? JSON.parse(stateRaw) : { groupStates: [], lastUpdated: "" }) as PimPortfolioState;
    const gs = state.groupStates.find((g) => g.groupId === GROUP) ?? { groupId: GROUP, lastRebalance: null, trackingStart: null, transactions: [] };
    const rebalPrices: Record<string, number> = { ...(gs.lastRebalance?.prices ?? {}) };
    for (const h of plan.newPim.holdings) {
      const p = exec[h.symbol] ?? plan.prices.asOf[h.symbol];
      if (p) rebalPrices[h.symbol] = p;
    }
    const nextState: PimPortfolioState = {
      ...state,
      groupStates: [
        ...state.groupStates.filter((g) => g.groupId !== GROUP),
        { ...gs, lastRebalance: { date: at, prices: rebalPrices }, transactions: [...gs.transactions, ...transactions] },
      ],
      lastUpdated: new Date().toISOString(),
    };
    await redis.set("pm:pim-portfolio-state", JSON.stringify(nextState));

    // 5. Today on the new holdings (best effort).
    try { await updateDailyValue(); } catch (e) { log.warn("post-commit performance refresh failed:", e); }

    log.info(`staged rebalance as of ${asOf}: ${transactions.length} trades across ${nextBooks.size} books, models v${applied.after.revision}, perf anchored ${anchored} / dropped ${dropped}`);
    return NextResponse.json({
      ok: true,
      asOf,
      versionId: applied.versionId,
      revision: applied.after.revision,
      roles: applied.roles,
      exits: applied.exits,
      thematicSeries: applied.thematicSeries,
      trades: transactions.length,
      books: [...nextBooks.keys()],
      performance: { anchored, dropped },
      stashes: [`pm:pim-performance.pre-staged-rebalance-${stamp}`, `pm:pim-positions.pre-staged-rebalance-${stamp}`, `pm:pim-portfolio-state.pre-staged-rebalance-${stamp}`],
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "rebalance failed" }, { status: 500 });
  }
}
