/**
 * Entry scan — evaluates the entry scorecard (entry-conditions.ts) for every
 * Watchlist name and every Suggested name, from data already in Redis. Zero
 * tokens, zero upstream calls.
 *
 * Redis:
 *   reads  pm:stocks, pm:research, pm:sia-history, pm:analyst-snapshots,
 *          pm:synthesis-screen-cache, pm:suggested-watchlist, pm:synthesis-decisions,
 *          pm:entry-cases
 *   writes pm:entry-scan — { builtAt, rows, readySince: { [ticker]: date } }.
 *          Regenerable cache; `readySince` is the small piece of memory that
 *          lets "newly ready" flip exactly once (the push), so it is carried
 *          forward from the previous scan rather than recomputed.
 */

import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { canonicalTicker, crossListingRoot } from "./ticker";
import { evaluateEntry, evaluateEntryLegacy, type EntrySignal, type EntryInputs } from "./entry-conditions";
import { computeSetup } from "./setup-grade";
import { readStockPool, findInPool } from "./stock-pool";
import type { Stock } from "./types";
import { loadKillSignalSources, killSignalExtrasFor } from "./metric-resolver";
import { siaPercentileDrift } from "./sia-history";
import { loadRankedResearch } from "./research-ranked-server";
import { qualifyingRows, activeDecision, emptySuggestedStore, SUGGESTED_STORE_KEY, DECISIONS_KEY, type SuggestedStore, type DecisionStore } from "./suggested-watchlist";
import type { SynthesisScreenCache } from "./synthesis-screen-display";
import { computeLane, type LaneRead } from "./lanes";
import { computeScores } from "./scoring";
import type { MarketData } from "./types";
import { getReportsForTicker, type AnalystReports } from "./analyst-snapshots";

const log = createLogger("EntryScan");
export const ENTRY_SCAN_KEY = "pm:entry-scan";
export const ENTRY_CASES_KEY = "pm:entry-cases";
const STALE_MS = 6 * 60 * 60 * 1000;

export type EntryRow = {
  ticker: string;
  name: string;
  sector: string;
  bucket: "Watchlist" | "Suggested";
  signals: EntrySignal[];
  met: number;
  known: number;
  ready: boolean;
  strength: "ready" | "building" | "early";
  /** YYYY-MM-DD the name first read ready in the current streak. */
  readySince?: string;
  /** "Why I'm watching" captured at Advance time (pm:entry-cases). */
  why?: string;
  /** Pre-unification readiness (five separate technical signals) — TEMPORARY,
   *  feeds /api/admin/entry-unification-diff; remove with evaluateEntryLegacy. */
  legacyReady?: boolean;
  legacyStrength?: "ready" | "building" | "early";
  /** Thesis / Tactical lane read (app/lib/lanes) — additive. */
  lane?: LaneRead;
};

export type EntryScan = {
  builtAt: string;
  rows: EntryRow[];
  readySince: Record<string, string>;
};

export type EntryCase = { why: string; addedAt: string; source?: string };

type StockRow = {
  ticker?: string; name?: string; sector?: string; bucket?: string; instrumentType?: string;
  price?: number; healthData?: { currentPrice?: number; twoHundredDayAvg?: number; earningsDate?: string };
  technicals?: { dmaSignal?: string }; riskAlert?: { level?: string }; earningsDate?: string;
};

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function readEntryScan(): Promise<EntryScan | null> {
  const s = await readJson<EntryScan | null>(ENTRY_SCAN_KEY, null);
  return s && Array.isArray(s.rows) ? s : null;
}

/** Cached when fresh, else rebuilt. */
export async function getEntryScan(opts: { refresh?: boolean } = {}): Promise<EntryScan> {
  const cached = await readEntryScan();
  if (cached && !opts.refresh && Date.now() - Date.parse(cached.builtAt) < STALE_MS) return cached;
  try {
    return await buildEntryScan();
  } catch (e) {
    log.error("rebuild failed:", e);
    if (cached) return cached;
    return { builtAt: new Date().toISOString(), rows: [], readySince: {} };
  }
}

export async function buildEntryScan(): Promise<EntryScan> {
  const today = new Date().toISOString().slice(0, 10);
  const [stocks, src, ranked, snaps, synth, suggestedStore, decisions, cases, prev] = await Promise.all([
    readJson<StockRow[]>("pm:stocks", []),
    loadKillSignalSources(),
    loadRankedResearch(),
    readJson<Record<string, { factset?: { revUp?: number; revDown?: number } }>>("pm:analyst-snapshots", {}),
    readJson<SynthesisScreenCache>("pm:synthesis-screen-cache", {}),
    readJson<SuggestedStore>(SUGGESTED_STORE_KEY, emptySuggestedStore()),
    readJson<DecisionStore>(DECISIONS_KEY, {}),
    readJson<Record<string, EntryCase>>(ENTRY_CASES_KEY, {}),
    readEntryScan(),
  ]);
  // Lane inputs the scorecard does not need: the reports manifest (Thesis
  // requires reports on file) and market data for the composite.
  const [reports, market] = await Promise.all([
    readJson<AnalystReports>("pm:analyst-reports", {}),
    readJson<MarketData>("pm:market", { riskRegime: "Neutral" } as MarketData),
  ]);
  // Full Stock records (book + Suggested staging) for the setup grade: the
  // narrow StockRow above is enough for the case signals, but computeSetup
  // needs scores / provider fields / manualScoredAt.
  const pool = await readStockPool().catch(() => [] as Stock[]);
  const windowStart = Date.now() - 14 * 86_400_000;
  const rankedByRoot = new Map(ranked.rows.map((r) => [r.key, r]));

  const evaluateOne = (ticker: string, stock: StockRow | undefined, bucket: "Watchlist" | "Suggested", listCount: number | null, listDelta: number | null): EntryRow => {
    const tk = canonicalTicker(ticker).toUpperCase();
    const root = crossListingRoot(ticker).toUpperCase();
    const extras = killSignalExtrasFor(tk, [], src);
    const siaEntries = src.sia[tk] ?? src.sia[root] ?? src.sia[`${root}.TO`];
    const drift = siaPercentileDrift(siaEntries, tk, windowStart);
    const fs = snaps[tk]?.factset ?? snaps[root]?.factset;
    const netRev = fs && (typeof fs.revUp === "number" || typeof fs.revDown === "number") ? (fs.revUp ?? 0) - (fs.revDown ?? 0) : null;
    const entry = synth[tk] ?? synth[canonicalTicker(ticker)];
    // Stale = a newer price move / earnings would already have flagged it on
    // the Synthesis page; here we only discount an entry older than 45 days.
    const synthStale = entry ? Date.now() - Date.parse(entry.generatedAt) > 45 * 86_400_000 : false;
    const price = typeof stock?.price === "number" ? stock.price : stock?.healthData?.currentPrice ?? null;
    const full = findInPool(pool, ticker);
    const setup = full ? computeSetup(full, { siaPercentileDelta: drift ? Math.round(drift.delta) : null }) : null;
    const inputs: EntryInputs = {
      setup: setup ? { grade: setup.grade, rawPoints: setup.rawPoints, availableMax: setup.availableMax, notches: setup.notches } : undefined,
      price,
      ma200: stock?.healthData?.twoHundredDayAvg ?? null,
      dmaSignal: stock?.technicals?.dmaSignal ?? null,
      riskLevel: stock ? (stock.riskAlert?.level ?? null) : undefined,
      siaPercentile: extras.siaPercentile ?? null,
      siaSmax: extras.siaSmax ?? null,
      siaDrift: drift ? Math.round(drift.delta) : null,
      equateRank: extras.equateRank,
      marketEdgeOpinion: extras.marketEdgeOpinion ?? null,
      marketEdgePower: extras.marketEdgePower ?? null,
      netRevisions: netRev,
      synthesisVerdict: entry?.result.verdict ?? null,
      synthesisStale: synthStale,
      catalystDate: stock?.earningsDate ?? stock?.healthData?.earningsDate ?? entry?.result.catalysts?.find((c) => c.date)?.date ?? null,
      listCount,
      listDelta,
    };
    const ev = evaluateEntry(inputs, today);
    const legacy = evaluateEntryLegacy(inputs, today);
    let lane: LaneRead | undefined;
    try {
      const tr = getReportsForTicker(reports, ticker);
      const stamps = [tr?.rbc, tr?.jpm, tr?.morningstar].map((m) => m?.extractedAt || m?.uploadedAt).filter((x): x is string => Boolean(x)).sort();
      const conviction = full && (!full.instrumentType || full.instrumentType === "stock") && full.lastScored ? computeScores(full, market).adjusted : null;
      lane = computeLane({
        latestReportAt: stamps.length ? stamps[stamps.length - 1] : null,
        synthesis: entry ? { verdict: entry.result.verdict, generatedAt: entry.generatedAt, earningsDateAtGeneration: entry.earningsDateAtGeneration ?? null } : null,
        conviction,
        setupGrade: setup?.grade ?? null,
        riskLevel: inputs.riskLevel,
        siaDrift: inputs.siaDrift ?? null,
        marketEdgeOpinion: inputs.marketEdgeOpinion ?? null,
        netRevisions: netRev,
        catalystDate: inputs.catalystDate ?? null,
        today,
      });
    } catch { lane = undefined; }
    const rankedRow = rankedByRoot.get(root);
    return {
      ticker: tk,
      name: stock?.name || rankedRow?.name || tk,
      sector: stock?.sector || rankedRow?.sector || "",
      bucket,
      ...ev,
      why: cases[tk]?.why ?? cases[root]?.why,
      legacyReady: legacy.ready,
      legacyStrength: legacy.strength,
      lane,
    };
  };

  const rows: EntryRow[] = [];
  const seen = new Set<string>();
  for (const s of stocks) {
    if (!s.ticker || s.bucket !== "Watchlist") continue;
    if (s.instrumentType && s.instrumentType !== "stock") continue;
    const root = crossListingRoot(s.ticker).toUpperCase();
    const r = rankedByRoot.get(root);
    const e = suggestedStore.entries?.[r?.ticker.toUpperCase() ?? ""];
    rows.push(evaluateOne(s.ticker, s, "Watchlist", r ? r.listCount : null, e?.prevListCount != null && r ? r.listCount - e.prevListCount : null));
    seen.add(root);
  }
  for (const r of qualifyingRows(ranked.rows)) {
    if (r.held || seen.has(r.key)) continue;
    if (activeDecision(decisions, r.ticker)?.verdict === "pass") continue;
    const e = suggestedStore.entries?.[r.ticker.toUpperCase()];
    rows.push(evaluateOne(r.ticker, undefined, "Suggested", r.listCount, e?.prevListCount != null ? r.listCount - e.prevListCount : null));
  }

  // Carry the ready streak forward; a name that stops reading ready loses it,
  // so the next flip is "new" again.
  const readySince: Record<string, string> = {};
  for (const row of rows) {
    if (!row.ready) continue;
    readySince[row.ticker] = prev?.readySince?.[row.ticker] ?? today;
    row.readySince = readySince[row.ticker];
  }
  rows.sort((a, b) => (b.met - a.met) || (b.known - a.known) || a.ticker.localeCompare(b.ticker));

  const scan: EntryScan = { builtAt: new Date().toISOString(), rows, readySince };
  try {
    await (await getRedis()).set(ENTRY_SCAN_KEY, JSON.stringify(scan));
  } catch (e) {
    log.warn("cache write failed:", e);
  }
  return scan;
}

/** Names that flipped to ready today (or yesterday, so the 06:00 UTC digest
 *  catches an afternoon flip) — the push set. */
export function newlyReady(scan: EntryScan, todayIso = new Date().toISOString().slice(0, 10)): EntryRow[] {
  const y = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return scan.rows.filter((r) => r.ready && r.readySince && (r.readySince === todayIso || r.readySince === y));
}
