/**
 * Server-side merge functions for emailed research lists. Each function
 * takes the current ResearchState (pm:research blob) and a list of
 * scraped entries from one research source, returning a new ResearchState
 * with the entries merged in.
 *
 * Behavior model: REPLACE mode by default. A screenshot represents a full
 * snapshot of the source list, so tickers no longer in the screenshot are
 * removed automatically — the lists track the current state of the
 * upstream service. Matched rows preserve their existing metadata
 * (priceWhenAdded, name, sector, etc.) so manually-backfilled fields
 * aren't lost.
 *
 * Safety check: if the new screenshot's row count is less than
 * SAFETY_THRESHOLD (30%) of the existing list size, the merger falls back
 * to ADDITIVE mode and the summary surfaces a `fallback` reason. This
 * catches the most common mistakes: a partial / paginated screenshot, or
 * vision missing most rows. The PM can then re-upload a complete
 * screenshot.
 *
 * Alpha Picks special case: PM-flagged `manualSell` picks are preserved
 * even in replace mode — those are the PM's explicit "I sold this" tags
 * that must survive a fresh Seeking Alpha screenshot.
 *
 * Used by the inbox dispatcher (app/lib/inbox-dispatch.ts) so emailed
 * research lists land in pm:research the same way as manual uploads.
 */

import type {
  ResearchState,
  IdeaEntry,
  RBCEntry,
  AlphaPickEntry,
  FewEntry,
} from "./defaults";
import type {
  SourceKey,
  ScrapedIdea,
  ScrapedRbcRow,
  ScrapedAlphaPick,
  ScrapedFewRow,
} from "@/app/api/research-scrape/route";
import { dedupeRbcEntries } from "./rbc-canonical";

/** Normalize a ticker the same way the client does — strip "$" / class slash,
 *  uppercase, drop suffix differences (.TO vs -T). */
function normalize(t: string): string {
  return t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
}

/** When a fresh screenshot has fewer than this fraction of the existing
 *  list's rows, fall back to additive merge instead of replace. Catches
 *  partial / paginated screenshots and vision misreads. */
export const SAFETY_THRESHOLD = 0.3;

export type ResearchMergeSummary = {
  source: SourceKey;
  rowsParsed: number;
  matched: number;
  added: number;
  /** Tickers present in the previous list but absent from the screenshot. 0 in
   *  additive-fallback mode (nothing was removed). */
  removed: number;
  /** The actual tickers removed (for the Change Monitor). Empty in additive
   *  mode. Excludes PM-preserved rows (e.g. Alpha Picks manualSell tags). */
  removedTickers: string[];
  /** "replace" (default) or "additive" (safety fallback when the screenshot
   *  was suspiciously small vs the existing list). */
  mode: "replace" | "additive";
  /** Set when mode === "additive" to explain why. */
  fallbackReason?: string;
  /** True when additive because this source was already scanned TODAY (a second
   *  screenshot of the same list accumulating), as opposed to the small-screenshot
   *  safety fallback. Lets the UI show "same-day" rather than "ADDITIVE FALLBACK". */
  sameDayAccumulate?: boolean;
};

/** Decide whether to use replace mode (default) or fall back to additive
 *  (when the new screenshot has suspiciously few rows). */
function decideMode(oldSize: number, newSize: number): { mode: "replace" | "additive"; reason?: string } {
  if (oldSize === 0) return { mode: "replace" }; // first upload — nothing to lose
  if (newSize === 0) {
    return { mode: "additive", reason: "screenshot returned 0 rows — likely a vision failure; keeping existing list" };
  }
  if (newSize / oldSize < SAFETY_THRESHOLD) {
    const pct = Math.round((newSize / oldSize) * 100);
    return { mode: "additive", reason: `new screenshot has ${newSize} rows vs existing ${oldSize} (${pct}%) — likely a partial screenshot; falling back to additive merge` };
  }
  return { mode: "replace" };
}

// ── Fundstrat Idea entries ────────────────────────────────────────────

function applyIdeaEntries(
  state: ResearchState,
  source: SourceKey,
  entries: ScrapedIdea[],
  forceAdditive: boolean,
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const stateKey =
    source === "fundstrat-top"         ? "fundstratTop"
  : source === "fundstrat-bottom"      ? "fundstratBottom"
  : source === "fundstrat-smid-top"    ? "fundstratSmidTop"
  : /* fundstrat-smid-bottom */         "fundstratSmidBottom";
  const existing: IdeaEntry[] = ((state[stateKey as keyof ResearchState] as IdeaEntry[]) || []);
  const existingByNorm = new Map(existing.map((i) => [normalize(i.ticker), i]));
  const { mode, reason } = forceAdditive
    ? { mode: "additive" as const, reason: undefined }
    : decideMode(existing.length, entries.length);

  const byNorm = new Map<string, IdeaEntry>();
  // In additive mode, seed the map with existing entries (they survive).
  if (mode === "additive") {
    for (const i of existing) byNorm.set(normalize(i.ticker), i);
  }
  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = existingByNorm.get(norm);
    if (ex) {
      matched += 1;
      byNorm.set(norm, { ticker: ex.ticker, priceWhenAdded: e.priceWhenAdded ?? ex.priceWhenAdded });
    } else {
      added += 1;
      byNorm.set(norm, { ticker: norm, priceWhenAdded: e.priceWhenAdded ?? 0 });
    }
  }
  const removed = mode === "replace" ? existing.length - matched : 0;
  const entryNorms = new Set(entries.map((e) => normalize(e.ticker)));
  const removedTickers = mode === "replace"
    ? existing.filter((i) => !entryNorms.has(normalize(i.ticker))).map((i) => i.ticker)
    : [];
  const nextState = { ...state, [stateKey]: Array.from(byNorm.values()) } as ResearchState;
  return {
    nextState,
    summary: { source, rowsParsed: entries.length, matched, added, removed, removedTickers, mode, fallbackReason: reason, sameDayAccumulate: forceAdditive },
  };
}

// ── RBC Canadian / US Focus ──────────────────────────────────────────

function applyRbcEntries(
  state: ResearchState,
  source: "rbc-focus" | "rbc-us-focus" | "jpm-us-analyst-focus" | "rbc-equate-cad" | "rbc-equate-usd" | "fundstrat-largecap-core" | "fundstrat-smid-core",
  entries: ScrapedRbcRow[],
  forceAdditive: boolean,
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const stateKey =
    source === "rbc-focus" ? "rbcCanadianFocus"
    : source === "rbc-us-focus" ? "rbcUsFocus"
    : source === "jpm-us-analyst-focus" ? "jpmUsAnalystFocus"
    : source === "rbc-equate-cad" ? "equateCad"
    : source === "rbc-equate-usd" ? "equateUsd"
    : source === "fundstrat-largecap-core" ? "fundstratLargeCapCore"
    : "fundstratSmidCore";
  const existing = ((state[stateKey as keyof ResearchState] as RBCEntry[]) || []);
  const existingByNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
  const { mode, reason } = forceAdditive
    ? { mode: "additive" as const, reason: undefined }
    : decideMode(existing.length, entries.length);
  const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

  const byNorm = new Map<string, RBCEntry>();
  if (mode === "additive") {
    for (const r of existing) byNorm.set(normalize(r.ticker), r);
  }
  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = existingByNorm.get(norm);
    if (ex) {
      matched += 1;
      byNorm.set(norm, {
        ticker: e.ticker || ex.ticker,
        // RBC lists have no name in the scrape (backfilled from Yahoo → ex.name);
        // JPM carries the company name in the screenshot → e.name wins.
        name: e.name ?? ex.name,
        sector: e.sector ?? ex.sector,
        weight: e.weight ?? ex.weight,
        dateAdded: e.dateAdded ?? ex.dateAdded,
        // JPM-only fields (undefined for RBC scrapes → preserve any existing).
        industry: e.industry ?? ex.industry,
        strategy: e.strategy ?? ex.strategy,
        priceTarget: e.priceTarget ?? ex.priceTarget,
        // Fundstrat Core-Ideas quant fields (undefined elsewhere → preserved).
        mktCap: e.mktCap ?? ex.mktCap,
        perf1M: e.perf1M ?? ex.perf1M,
        perfYTD: e.perfYTD ?? ex.perfYTD,
        pe: e.pe ?? ex.pe,
        dqmRank: e.dqmRank ?? ex.dqmRank,
        momentumRating: e.momentumRating ?? ex.momentumRating,
        priceVs20d: e.priceVs20d ?? ex.priceVs20d,
        ma20vs200: e.ma20vs200 ?? ex.ma20vs200,
        trendAligned: e.trendAligned ?? ex.trendAligned,
      });
    } else {
      added += 1;
      byNorm.set(norm, {
        ticker: e.ticker,
        name: e.name,
        sector: e.sector ?? "—",
        weight: e.weight ?? 0,
        dateAdded: e.dateAdded ?? today,
        industry: e.industry,
        strategy: e.strategy,
        priceTarget: e.priceTarget,
        mktCap: e.mktCap,
        perf1M: e.perf1M,
        perfYTD: e.perfYTD,
        pe: e.pe,
        dqmRank: e.dqmRank,
        momentumRating: e.momentumRating,
        priceVs20d: e.priceVs20d,
        ma20vs200: e.ma20vs200,
        trendAligned: e.trendAligned,
      });
    }
  }
  const merged = Array.from(byNorm.values());
  const finalList = source === "rbc-focus" || source === "rbc-equate-cad" ? dedupeRbcEntries(merged).entries : merged;
  const removed = mode === "replace" ? existing.length - matched : 0;
  const entryNorms = new Set(entries.map((e) => normalize(e.ticker)));
  const removedTickers = mode === "replace"
    ? existing.filter((r) => !entryNorms.has(normalize(r.ticker))).map((r) => r.ticker)
    : [];
  const nextState = { ...state, [stateKey]: finalList } as ResearchState;
  return {
    nextState,
    summary: { source, rowsParsed: entries.length, matched, added, removed, removedTickers, mode, fallbackReason: reason, sameDayAccumulate: forceAdditive },
  };
}

// ── Seeking Alpha Alpha Picks ────────────────────────────────────────
//
// Composite key (ticker + dateAdded) — the same name legitimately appears
// twice on different dates (sold + re-bought). PM-flagged manualSell picks
// are PRESERVED even in replace mode: those represent the PM's explicit
// "I sold this" tag and survive a fresh screenshot.

function applyAlphaPicks(
  state: ResearchState,
  entries: ScrapedAlphaPick[],
  forceAdditive: boolean,
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const existing: AlphaPickEntry[] = state.alphaPicks || [];
  const dateKey = (d: string | undefined) => (d || "").trim();
  const compositeKey = (ticker: string, date: string | undefined) => `${normalize(ticker)}|${dateKey(date)}`;
  const existingByKey = new Map(existing.map((i) => [compositeKey(i.ticker, i.dateAdded), i]));
  const { mode, reason } = forceAdditive
    ? { mode: "additive" as const, reason: undefined }
    : decideMode(existing.length, entries.length);
  const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

  const byKey = new Map<string, AlphaPickEntry>();
  // In additive mode, ALL existing entries survive. In replace mode, only
  // manualSell picks survive (PM-flagged "sold" — protect from auto-removal).
  for (const ex of existing) {
    if (mode === "additive" || ex.manualSell) {
      byKey.set(compositeKey(ex.ticker, ex.dateAdded), ex);
    }
  }

  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const date = dateKey(e.dateAdded);
    const key = `${norm}|${date}`;
    const ex = existingByKey.get(key);
    if (ex) {
      matched += 1;
      byKey.set(key, {
        ...ex,
        ticker: norm,
        name: e.name?.trim() || ex.name,
        sector: e.sector?.trim() || ex.sector,
        dateAdded: e.dateAdded?.trim() || ex.dateAdded,
        returnSinceAdded: e.returnSinceAdded ?? ex.returnSinceAdded,
        rating: e.rating?.trim() || ex.rating,
        holdingWeight: e.holdingWeight ?? ex.holdingWeight,
        // manualSell is preserved via the ...ex spread.
      });
    } else {
      added += 1;
      byKey.set(key, {
        ticker: norm,
        name: e.name?.trim() || norm,
        sector: e.sector?.trim() || "—",
        price: 0,
        priceWhenAdded: 0,
        dateAdded: e.dateAdded?.trim() || today,
        returnSinceAdded: e.returnSinceAdded,
        rating: e.rating?.trim(),
        holdingWeight: e.holdingWeight,
      });
    }
  }
  // In replace mode, "removed" = existing that weren't matched and
  // weren't manualSell-preserved.
  const preservedCount = mode === "replace"
    ? existing.filter((p) => p.manualSell).length
    : existing.length;
  const removed = mode === "replace" ? existing.length - matched - preservedCount : 0;
  const entryKeys = new Set(entries.map((e) => compositeKey(e.ticker, e.dateAdded)));
  const removedTickers = mode === "replace"
    ? existing.filter((p) => !p.manualSell && !entryKeys.has(compositeKey(p.ticker, p.dateAdded))).map((p) => p.ticker)
    : [];
  const nextState = { ...state, alphaPicks: Array.from(byKey.values()) };
  return {
    nextState,
    summary: { source: "seeking-alpha-picks", rowsParsed: entries.length, matched, added, removed, removedTickers, mode, fallbackReason: reason, sameDayAccumulate: forceAdditive },
  };
}

// ── RBCCM FEW ────────────────────────────────────────────────────────

function applyFewEntries(
  state: ResearchState,
  entries: ScrapedFewRow[],
  forceAdditive: boolean,
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const existing: FewEntry[] = state.rbccmFew || [];
  const existingByNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
  const { mode, reason } = forceAdditive
    ? { mode: "additive" as const, reason: undefined }
    : decideMode(existing.length, entries.length);

  const byNorm = new Map<string, FewEntry>();
  if (mode === "additive") {
    for (const r of existing) byNorm.set(normalize(r.ticker), r);
  }
  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = existingByNorm.get(norm);
    if (ex) {
      matched += 1;
      byNorm.set(norm, {
        ticker: e.ticker || ex.ticker,
        name: e.name ?? ex.name,
        industry: e.industry ?? ex.industry,
        price: e.price ?? ex.price,
      });
    } else {
      added += 1;
      byNorm.set(norm, { ticker: e.ticker, name: e.name, industry: e.industry, price: e.price });
    }
  }
  const removed = mode === "replace" ? existing.length - matched : 0;
  const entryNorms = new Set(entries.map((e) => normalize(e.ticker)));
  const removedTickers = mode === "replace"
    ? existing.filter((r) => !entryNorms.has(normalize(r.ticker))).map((r) => r.ticker)
    : [];
  const nextState = { ...state, rbccmFew: Array.from(byNorm.values()) };
  return {
    nextState,
    summary: { source: "rbccm-few", rowsParsed: entries.length, matched, added, removed, removedTickers, mode, fallbackReason: reason, sameDayAccumulate: forceAdditive },
  };
}

/**
 * Universal entry point — dispatches to the right merger based on source.
 *
 * Same-day accumulation: if this source was already scanned TODAY (per
 * state.scanDates), the merge runs ADDITIVE so a second screenshot of the same
 * list (manual upload OR email) accumulates instead of overwriting the first.
 * The first scan of a new day replaces as usual (dropping delisted names). The
 * returned nextState records today's scan date for the source.
 */
export function applyResearchEntries(
  state: ResearchState,
  source: SourceKey,
  entries: unknown[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const today = new Date().toISOString().slice(0, 10); // UTC — consistent client + server
  const forceAdditive = state.scanDates?.[source] === today;

  let result: { nextState: ResearchState; summary: ResearchMergeSummary };
  switch (source) {
    case "fundstrat-top":
    case "fundstrat-bottom":
    case "fundstrat-smid-top":
    case "fundstrat-smid-bottom":
      result = applyIdeaEntries(state, source, entries as ScrapedIdea[], forceAdditive);
      break;
    case "rbc-focus":
    case "rbc-us-focus":
    case "jpm-us-analyst-focus":
    case "rbc-equate-cad":
    case "rbc-equate-usd":
    case "fundstrat-largecap-core":
    case "fundstrat-smid-core":
      result = applyRbcEntries(state, source, entries as ScrapedRbcRow[], forceAdditive);
      break;
    case "seeking-alpha-picks":
      result = applyAlphaPicks(state, entries as ScrapedAlphaPick[], forceAdditive);
      break;
    case "rbccm-few":
      result = applyFewEntries(state, entries as ScrapedFewRow[], forceAdditive);
      break;
  }

  // Stamp today's scan date so subsequent same-day scans accumulate.
  result.nextState = {
    ...result.nextState,
    scanDates: { ...(state.scanDates ?? {}), [source]: today },
  };
  return result;
}
