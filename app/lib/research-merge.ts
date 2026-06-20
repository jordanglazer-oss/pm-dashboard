/**
 * Server-side merge functions for emailed research lists. Each function
 * takes the current ResearchState (pm:research blob) and a list of
 * scraped entries from one research source, returning a new ResearchState
 * with the entries merged in.
 *
 * Behavior mirrors the client-side merge in app/(dashboard)/research/page.tsx
 * (scrapeResearchSource callback). The client-side path stays unchanged so
 * the manual upload UI keeps its richer name-backfill/refresh side-effects;
 * this lib is a leaner version sufficient for the email-driven path.
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

export type ResearchMergeSummary = {
  source: SourceKey;
  rowsParsed: number;
  matched: number;
  added: number;
};

/** Apply Fundstrat-style IdeaEntry rows (top/bottom large-cap, top/bottom SMID-cap). */
function applyIdeaEntries(
  state: ResearchState,
  source: SourceKey,
  entries: ScrapedIdea[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const stateKey =
    source === "fundstrat-top"         ? "fundstratTop"
  : source === "fundstrat-bottom"      ? "fundstratBottom"
  : source === "fundstrat-smid-top"    ? "fundstratSmidTop"
  : /* fundstrat-smid-bottom */         "fundstratSmidBottom";
  const existing: IdeaEntry[] = ((state[stateKey as keyof ResearchState] as IdeaEntry[]) || []);
  const byNorm = new Map(existing.map((i) => [normalize(i.ticker), i]));
  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = byNorm.get(norm);
    if (ex) {
      matched += 1;
      byNorm.set(norm, { ticker: ex.ticker, priceWhenAdded: e.priceWhenAdded ?? ex.priceWhenAdded });
    } else {
      added += 1;
      byNorm.set(norm, { ticker: norm, priceWhenAdded: e.priceWhenAdded ?? 0 });
    }
  }
  const nextState = { ...state, [stateKey]: Array.from(byNorm.values()) } as ResearchState;
  return { nextState, summary: { source, rowsParsed: entries.length, matched, added } };
}

/** Apply RBC Canadian or US Focus rows. */
function applyRbcEntries(
  state: ResearchState,
  source: "rbc-focus" | "rbc-us-focus",
  entries: ScrapedRbcRow[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const stateKey = source === "rbc-focus" ? "rbcCanadianFocus" : "rbcUsFocus";
  const existing = ((state[stateKey as keyof ResearchState] as RBCEntry[]) || []);
  const byNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
  let matched = 0;
  let added = 0;
  const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = byNorm.get(norm);
    if (ex) {
      matched += 1;
      byNorm.set(norm, {
        ticker: e.ticker || ex.ticker,
        name: ex.name,
        sector: e.sector ?? ex.sector,
        weight: e.weight ?? ex.weight,
        dateAdded: e.dateAdded ?? ex.dateAdded,
      });
    } else {
      added += 1;
      byNorm.set(norm, {
        ticker: e.ticker,
        sector: e.sector ?? "—",
        weight: e.weight ?? 0,
        dateAdded: e.dateAdded ?? today,
      });
    }
  }
  const merged = Array.from(byNorm.values());
  const finalList = source === "rbc-focus" ? dedupeRbcEntries(merged).entries : merged;
  const nextState = { ...state, [stateKey]: finalList } as ResearchState;
  return { nextState, summary: { source, rowsParsed: entries.length, matched, added } };
}

/** Apply Seeking Alpha Alpha Picks rows.
 *  Composite key (ticker + dateAdded) — the same name can appear twice on
 *  different dates legitimately. Server-side merge is leaner than the
 *  client's: no cross-stem name dedup. The Refresh UI in Research can
 *  reconcile if it ever matters. */
function applyAlphaPicks(
  state: ResearchState,
  entries: ScrapedAlphaPick[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const existing: AlphaPickEntry[] = state.alphaPicks || [];
  const dateKey = (d: string | undefined) => (d || "").trim();
  const compositeKey = (ticker: string, date: string | undefined) => `${normalize(ticker)}|${dateKey(date)}`;
  const byKey = new Map(existing.map((i) => [compositeKey(i.ticker, i.dateAdded), i]));
  let matched = 0;
  let added = 0;
  const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const date = dateKey(e.dateAdded);
    const key = `${norm}|${date}`;
    const ex = byKey.get(key);
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
  const nextState = { ...state, alphaPicks: Array.from(byKey.values()) };
  return { nextState, summary: { source: "seeking-alpha-picks", rowsParsed: entries.length, matched, added } };
}

/** Apply RBCCM FEW rows. */
function applyFewEntries(
  state: ResearchState,
  entries: ScrapedFewRow[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  const existing: FewEntry[] = state.rbccmFew || [];
  const byNorm = new Map(existing.map((r) => [normalize(r.ticker), r]));
  let matched = 0;
  let added = 0;
  for (const e of entries) {
    const norm = normalize(e.ticker);
    const ex = byNorm.get(norm);
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
  const nextState = { ...state, rbccmFew: Array.from(byNorm.values()) };
  return { nextState, summary: { source: "rbccm-few", rowsParsed: entries.length, matched, added } };
}

/** Universal entry point — dispatches to the right merger based on source. */
export function applyResearchEntries(
  state: ResearchState,
  source: SourceKey,
  entries: unknown[],
): { nextState: ResearchState; summary: ResearchMergeSummary } {
  switch (source) {
    case "fundstrat-top":
    case "fundstrat-bottom":
    case "fundstrat-smid-top":
    case "fundstrat-smid-bottom":
      return applyIdeaEntries(state, source, entries as ScrapedIdea[]);
    case "rbc-focus":
    case "rbc-us-focus":
      return applyRbcEntries(state, source, entries as ScrapedRbcRow[]);
    case "seeking-alpha-picks":
      return applyAlphaPicks(state, entries as ScrapedAlphaPick[]);
    case "rbccm-few":
      return applyFewEntries(state, entries as ScrapedFewRow[]);
  }
}
