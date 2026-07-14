import { NextRequest } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeScores } from "@/app/lib/scoring";
import { defaultMarketData } from "@/app/lib/defaults";
import { enqueueMail } from "@/app/lib/mail-outbox";
import { POST as scorePOST } from "@/app/api/score/route";
import type { MarketData, ScoreKey, ScoreExplanations, Stock } from "@/app/lib/types";
import type { ScoreHistoryStore, ScoreHistoryEntry } from "@/app/api/kv/score-history/route";

/**
 * Event-driven auto-rescore — rescore a name ONLY when something material
 * changed, so composites stay current without a manual Score All and without
 * re-spending credits on names where nothing happened.
 *
 * TRIGGERS (user-approved set, 2026-07-14):
 *   1. ANALYST REPORTS INGESTED → FULL rescore. NOT time-based: the inbox
 *      ingest marks the ticker when its report PDFs land (both PDFs arrive on
 *      ONE email, so one ingestion pass = reports complete; a 15-min settle
 *      guards the multi-attachment window). This IS the post-earnings trigger —
 *      the rescore waits for exactly the data it needs, however long the
 *      reports take. Bypasses the cooldown (fresh reports = re-underwrite now).
 *   2. REVISION SWING → PARTIAL (fundamentals) rescore. Net FY+1 revisions
 *      moved by ≥3 SINCE THE LAST RESCORE (change-based, NOT level-based — the
 *      rolling 30d net can sit at +5 for weeks; only fresh movement fires).
 *   No thesis-verdict trigger, no staleness backstop (explicitly declined).
 *
 * LOOP CLOSER: on earnings day (earningsDate today/yesterday) the engine also
 * emails the desk (WATCHLIST_NOTIFY_TO) a reply-shell with the ingest subject
 * "Analyst Report: <TICKER>" — reply with the updated RBC/JPM PDFs and the
 * ingestion both files the reports AND queues the full rescore. Once per
 * earnings date per name.
 *
 * PACING: one rescore per invocation (fits Vercel's 60s), pinged repeatedly by
 * the Gmail Apps Script inside an evening window; ≤5 rescores per day; ≥7-day
 * per-name cooldown; first sighting of a ticker only SEEDS its revision
 * baseline (no day-one rescore burst).
 *
 * ── REDIS SAFETY ──
 * pm:stocks is written with the SAME race-safe pattern as technicals-refresh:
 * all slow work first, then RE-READ pm:stocks and merge ONLY the score fields
 * ({ ...stock, scores: {...merged}, explanations: {...merged}, lastScored,
 * narrative fields only when a FULL rescore returned them }) into the fresh
 * copy; abort without writing on a degraded read. pm:score-history is appended
 * in its established shape (today-dated entry). pm:rescore-state is a new
 * operational marker (baselines + daily count + recent log) — safe to nuke;
 * next run re-seeds baselines.
 */

const log = createLogger("AutoRescore");

export const RESCORE_STATE_KEY = "pm:rescore-state";
const DAILY_CAP = 5;
const COOLDOWN_DAYS = 7;
const REVISION_DELTA = 3;

type TickerState = { lastAt?: string; netAtLast?: number | null };
export type RescoreState = {
  /** Per-ticker baselines (UPPER key). */
  tickers: Record<string, TickerState>;
  /** Daily budget: resets when the date changes. */
  day?: { date: string; count: number };
  /** Tickers whose analyst reports were just ingested (UPPER → ISO of the
   *  latest ingest). Written by the inbox route; consumed here as FULL-rescore
   *  triggers after a 15-min settle. */
  pendingReports?: Record<string, string>;
  /** earningsDate we already sent the report-request email for (dedupe). */
  earningsEmailed?: Record<string, string>;
  /** Rolling log of the last ~20 auto-rescores, rendered in the digest. */
  recent?: Array<{ at: string; ticker: string; trigger: string; mode: "full" | "partial"; before: number | null; after: number | null }>;
};

/** Called by the inbox ingest after a report PDF is persisted — marks the
 *  ticker so the evening engine runs a FULL rescore with the fresh reports in
 *  context. Read-modify-write on the operational pm:rescore-state only. */
export async function markReportsIngested(ticker: string): Promise<void> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(RESCORE_STATE_KEY);
    const state = parse<RescoreState>(raw, { tickers: {} });
    state.tickers ??= {};
    state.pendingReports = { ...(state.pendingReports ?? {}), [ticker.toUpperCase()]: new Date().toISOString() };
    await redis.set(RESCORE_STATE_KEY, JSON.stringify(state));
    log.info("reports ingested → rescore pending:", ticker);
  } catch (e) {
    log.warn("markReportsIngested failed (ingest itself unaffected):", e instanceof Error ? e.message : e);
  }
}

type StoredStock = {
  ticker?: string;
  bucket?: string;
  instrumentType?: string;
  earningsDate?: string;
  lastScored?: string;
  scores?: Record<string, number>;
  explanations?: ScoreExplanations;
  [k: string]: unknown;
};

const FUNDAMENTAL_CATS: ScoreKey[] = ["growth", "relativeValuation", "historicalValuation"];

function daysSinceUtc(dateIso: string): number | null {
  const t = Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(t)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - t) / 86_400_000);
}

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fb;
  }
}

/** Run ONE step of the queue: seed baselines, pick the top-priority trigger,
 *  rescore it, apply + log. Returns what happened (for the ping response). */
export async function autoRescoreStep(): Promise<{
  status: "rescored" | "idle" | "cap-reached" | "aborted";
  ticker?: string;
  trigger?: string;
  detail?: string;
}> {
  const redis = await getRedis();
  const today = new Date().toISOString().slice(0, 10);

  const [stocksRaw, snapsRaw, stateRaw, marketRaw] = await Promise.all([
    redis.get("pm:stocks"),
    redis.get("pm:analyst-snapshots"),
    redis.get(RESCORE_STATE_KEY),
    redis.get("pm:market"),
  ]);
  const stocks = parse<StoredStock[]>(stocksRaw, []);
  if (!Array.isArray(stocks) || stocks.length === 0) return { status: "idle", detail: "no stocks" };
  const snaps = parse<Record<string, { factset?: { revUp?: number; revDown?: number } }>>(snapsRaw, {});
  const state = parse<RescoreState>(stateRaw, { tickers: {} });
  state.tickers ??= {};
  const marketData = { ...defaultMarketData, ...parse<Partial<MarketData>>(marketRaw, {}) } as MarketData;

  // Daily budget.
  if (!state.day || state.day.date !== today) state.day = { date: today, count: 0 };
  if (state.day.count >= DAILY_CAP) return { status: "cap-reached" };

  const netFor = (tk: string): number | null => {
    const fs = snaps[tk]?.factset;
    if (!fs || (typeof fs.revUp !== "number" && typeof fs.revDown !== "number")) return null;
    return (fs.revUp ?? 0) - (fs.revDown ?? 0);
  };

  // ── Earnings-day report request — the loop closer. A name that just
  // reported gets a reply-shell email to the desk asking for the updated
  // RBC/JPM PDFs; the reply's ingestion is what triggers the full rescore.
  state.earningsEmailed ??= {};
  let stateDirty = false;
  const notifyTo = process.env.WATCHLIST_NOTIFY_TO || "jordan.glazer@rbc.com";
  for (const s of stocks) {
    const tk = (s.ticker || "").trim().toUpperCase();
    if (!tk) continue;
    if (s.bucket !== "Portfolio" && s.bucket !== "Watchlist") continue;
    if (s.instrumentType != null && s.instrumentType !== "stock") continue;
    const ed = typeof s.earningsDate === "string" ? s.earningsDate.slice(0, 10) : "";
    const dse = ed ? daysSinceUtc(ed) : null;
    if (dse == null || dse < 0 || dse > 1) continue; // reported today/yesterday
    if (state.earningsEmailed[tk] === ed) continue;
    const queued = await enqueueMail({
      id: `earnings-${tk}-${ed}`,
      to: notifyTo,
      subject: `Analyst Report: ${tk}`,
      text: [
        `${tk} reported earnings (${ed}).`,
        ``,
        `Reply to THIS email with the updated RBC and/or JPM analyst report PDF(s)`,
        `attached — both in one reply is perfect. Name each file so the source is clear:`,
        ``,
        `    ${tk}-RBC.pdf     (RBC coverage)`,
        `    ${tk}-JPM.pdf     (JPM coverage)`,
        ``,
        `Once ingested, the dashboard automatically runs a full post-earnings rescore`,
        `of ${tk} with the fresh reports in context. Keep the subject intact (a normal`,
        `"Re:" reply is fine).`,
      ].join("\n"),
      queuedAt: new Date().toISOString(),
    });
    state.earningsEmailed[tk] = ed;
    stateDirty = true;
    if (queued) log.info("earnings report-request queued:", tk, ed);
  }

  // ── Build rescore candidates + seed baselines for first-seen tickers ──
  type Candidate = { ticker: string; mode: "full" | "partial"; trigger: string; rank: number };
  const candidates: Candidate[] = [];
  let seeded = 0;

  // 1. Reports ingested → FULL rescore. 15-min settle guards the window where
  //    a second attachment from the same email is still being POSTed. Bypasses
  //    the cooldown — fresh reports mean re-underwrite now.
  const universe = new Set(
    stocks
      .filter((s) => (s.bucket === "Portfolio" || s.bucket === "Watchlist") && (s.instrumentType == null || s.instrumentType === "stock"))
      .map((s) => (s.ticker || "").trim().toUpperCase())
      .filter(Boolean)
  );
  for (const [tk, atIso] of Object.entries(state.pendingReports ?? {})) {
    if (!universe.has(tk)) {
      // No longer tracked — drop the pending mark so it can't linger forever.
      delete state.pendingReports![tk];
      stateDirty = true;
      continue;
    }
    const ageMin = (Date.now() - Date.parse(atIso)) / 60_000;
    if (!isFinite(ageMin) || ageMin < 15) continue;
    candidates.push({ ticker: tk, mode: "full", trigger: `analyst reports ingested ${atIso.slice(0, 10)}`, rank: 100 });
  }

  // 2. Revision swing since last rescore (change-based, cooldown applies).
  for (const s of stocks) {
    const tk = (s.ticker || "").trim().toUpperCase();
    if (!tk || !universe.has(tk)) continue;

    const ts = (state.tickers[tk] ??= {});
    const net = netFor(tk);

    // First sighting → seed the baseline, never fire.
    if (ts.netAtLast === undefined) {
      ts.netAtLast = net;
      seeded++;
      continue;
    }
    if (candidates.some((c) => c.ticker === tk)) continue; // already queued as full

    const sinceLast = ts.lastAt ? daysSinceUtc(ts.lastAt) : null;
    if (sinceLast != null && sinceLast < COOLDOWN_DAYS) continue;

    if (net != null && ts.netAtLast != null) {
      const delta = net - ts.netAtLast;
      if (Math.abs(delta) >= REVISION_DELTA) {
        candidates.push({
          ticker: tk,
          mode: "partial",
          trigger: `revisions moved ${delta > 0 ? "+" : ""}${delta} since last rescore (net ${net})`,
          rank: Math.abs(delta),
        });
      }
    }
  }

  if (candidates.length === 0) {
    if (seeded > 0 || stateDirty) await redis.set(RESCORE_STATE_KEY, JSON.stringify(state));
    return { status: "idle", detail: seeded ? `seeded ${seeded} baselines` : "no triggers" };
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const pick = candidates[0];
  const stockBefore = stocks.find((s) => (s.ticker || "").trim().toUpperCase() === pick.ticker);

  // ── The slow part: same code path as the Score button ──
  log.info(`rescoring ${pick.ticker} (${pick.mode}) — ${pick.trigger}`);
  const body = {
    ticker: pick.ticker,
    verifyWithWebSearch: pick.mode === "full",
    ...(pick.mode === "partial" ? { categories: FUNDAMENTAL_CATS } : {}),
  };
  const res = await scorePOST(
    new NextRequest("http://internal/api/score", { method: "POST", body: JSON.stringify(body) })
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Record the attempt (cooldown applies) so a chronically failing name
    // can't eat the budget every night. Clear its pending mark too — one
    // failed full attempt shouldn't retry every ping all evening.
    state.tickers[pick.ticker] = { ...(state.tickers[pick.ticker] ?? {}), lastAt: new Date().toISOString() };
    if (state.pendingReports) delete state.pendingReports[pick.ticker];
    state.day.count += 1;
    await redis.set(RESCORE_STATE_KEY, JSON.stringify(state));
    return { status: "aborted", ticker: pick.ticker, trigger: pick.trigger, detail: `score ${res.status}: ${err?.error ?? ""}` };
  }
  const data = (await res.json()) as {
    scores?: Partial<Record<ScoreKey, number>>;
    explanations?: ScoreExplanations;
    companySummary?: string;
    investmentThesis?: string;
    bearCase?: string;
  };
  if (!data.scores) {
    return { status: "aborted", ticker: pick.ticker, trigger: pick.trigger, detail: "no scores in response" };
  }

  // ── Race-safe apply: RE-READ pm:stocks, merge ONLY score fields ──
  const rawB = await redis.get("pm:stocks");
  const fresh = parse<StoredStock[]>(rawB, []);
  if (!Array.isArray(fresh) || fresh.length === 0) {
    log.error("pm:stocks re-read empty — ABORTING apply");
    return { status: "aborted", ticker: pick.ticker, trigger: pick.trigger, detail: "stocks re-read empty; nothing written" };
  }
  const nowIso = new Date().toISOString();
  let applied = false;
  let mergedScores: Record<string, number> | null = null;
  const next = fresh.map((s) => {
    if ((s.ticker || "").trim().toUpperCase() !== pick.ticker) return s;
    applied = true;
    mergedScores = { ...(s.scores ?? {}) };
    for (const [k, v] of Object.entries(data.scores!)) if (typeof v === "number") mergedScores[k] = v;
    return {
      ...s,
      scores: mergedScores,
      explanations: { ...(s.explanations ?? {}), ...(data.explanations ?? {}) },
      lastScored: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }),
      ...(data.companySummary ? { companySummary: data.companySummary } : {}),
      ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
      ...(data.bearCase ? { bearCase: data.bearCase } : {}),
    };
  });
  if (!applied || !mergedScores) {
    return { status: "aborted", ticker: pick.ticker, trigger: pick.trigger, detail: "ticker vanished mid-run; nothing written" };
  }
  await redis.set("pm:stocks", JSON.stringify(next));

  // ── Composite before/after + score-history append (established shape) ──
  const compositeOf = (sc: Record<string, number> | undefined): number | null => {
    if (!sc) return null;
    try {
      const base = { ...(stockBefore as unknown as Stock), ticker: pick.ticker, scores: sc } as Stock;
      return computeScores(base, marketData).adjusted;
    } catch {
      return null;
    }
  };
  const before = compositeOf(stockBefore?.scores);
  const after = compositeOf(mergedScores);
  try {
    const histRaw = await redis.get("pm:score-history");
    const hist = parse<ScoreHistoryStore>(histRaw, {});
    const entry: ScoreHistoryEntry = {
      date: today,
      timestamp: nowIso,
      total: after ?? 0,
      raw: after ?? 0,
      adjusted: after ?? 0,
      scores: mergedScores,
    } as ScoreHistoryEntry;
    hist[pick.ticker] = [...(hist[pick.ticker] ?? []), entry];
    await redis.set("pm:score-history", JSON.stringify(hist));
  } catch (e) {
    log.warn("score-history append failed (rescore itself applied):", e instanceof Error ? e.message : e);
  }

  // ── State: baseline reset + clear pending + budget + recent log ──
  state.tickers[pick.ticker] = { lastAt: nowIso, netAtLast: netFor(pick.ticker) };
  if (state.pendingReports) delete state.pendingReports[pick.ticker];
  state.day.count += 1;
  state.recent = [
    { at: nowIso, ticker: pick.ticker, trigger: pick.trigger, mode: pick.mode, before, after },
    ...(state.recent ?? []),
  ].slice(0, 20);
  await redis.set(RESCORE_STATE_KEY, JSON.stringify(state));

  log.info(`done ${pick.ticker}: ${before ?? "?"} → ${after ?? "?"} (${state.day.count}/${DAILY_CAP} today)`);
  return { status: "rescored", ticker: pick.ticker, trigger: pick.trigger, detail: `${before ?? "?"} → ${after ?? "?"}` };
}
