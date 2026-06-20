/**
 * Pure helpers that compute per-stock field patches + score updates from
 * SIA / BoostedAI / MarketEdge entries. Used by BOTH:
 *   - the manual Inbox-tab importer (client side, applies via React context)
 *   - the email webhook (server side, applies via direct pm:stocks read-modify-write)
 *
 * Pure functions — no Redis, no React, no fetches. They take stocks + entries
 * and return a `StockPatch[]` plus a summary the caller renders. Keeps the
 * priority rule ("screenshot wins only when value is present"), the
 * dual-listing match, and the timestamp bookkeeping in ONE place.
 */

import type { Stock, ScoreKey } from "./types";
import {
  mapSmaxToRelativeStrength,
  mapBoostedAiToAiRating,
  mapPowerRatingToMarketEdge,
  type BoostedAiConsensus,
} from "./external-scoring";
import { sameCompanyLoose } from "./ticker";
import type { ScrapedSia, ScrapedBoosted } from "./screenshot-extractors";
import type { MarketEdgeCsvRow } from "./marketedge-csv";

export type StockPatch = {
  ticker: string;
  fields: Partial<Stock>;
  scoreUpdates?: { key: ScoreKey; value: number }[];
};

export type IngestSummary = {
  rowsParsed: number;
  matched: number;
  updated: number;
  inScreenshotButUnreadable: string[]; // tickers vision saw but couldn't parse the value
  expectedButMissing: string[];        // scoreable P+W stocks not in screenshot
  unmatched: string[];                 // tickers in screenshot not in P+W
};

/** Default empty summary — used by the email webhook when there are no expected names. */
const emptySummary = (): IngestSummary => ({
  rowsParsed: 0,
  matched: 0,
  updated: 0,
  inScreenshotButUnreadable: [],
  expectedButMissing: [],
  unmatched: [],
});

// ── SIA ─────────────────────────────────────────────────────────────

export function applySiaEntries(
  /** Pool of stocks to match against (typically scoreable Portfolio + Watchlist).
   *  Pass an empty array on the server when you don't want to compute
   *  "expectedButMissing" — only the matched-name patches will be returned. */
  expected: Stock[],
  entries: ScrapedSia[],
  /** Wall-clock to stamp on siaLastScreenshotAt / siaLastReadAt. Pass an
   *  explicit value so the caller (server) can use one timestamp per upload. */
  now: string,
): { patches: StockPatch[]; summary: IngestSummary } {
  const patches: StockPatch[] = [];
  const summary = emptySummary();
  summary.rowsParsed = entries.length;
  const matchedStockTickers = new Set<string>();

  for (const e of entries) {
    const stock = expected.find((s) => sameCompanyLoose(s.ticker, e.ticker));
    if (!stock) { summary.unmatched.push(e.ticker); continue; }
    summary.matched += 1;
    matchedStockTickers.add(stock.ticker);
    if (typeof e.smax === "number" && Number.isFinite(e.smax)) {
      const mapped = mapSmaxToRelativeStrength(e.smax);
      patches.push({
        ticker: stock.ticker,
        fields: { sia: e.smax, siaLastScreenshotAt: now, siaLastReadAt: now },
        scoreUpdates: mapped != null ? [{ key: "relativeStrength", value: mapped }] : undefined,
      });
      summary.updated += 1;
    } else {
      summary.inScreenshotButUnreadable.push(stock.ticker);
      patches.push({ ticker: stock.ticker, fields: { siaLastScreenshotAt: now } });
    }
  }

  // Stamp every expected stock that wasn't in the screenshot.
  for (const s of expected) {
    if (matchedStockTickers.has(s.ticker)) continue;
    summary.expectedButMissing.push(s.ticker);
    patches.push({ ticker: s.ticker, fields: { siaLastScreenshotAt: now } });
  }

  return { patches, summary };
}

// ── BoostedAI ───────────────────────────────────────────────────────

export function applyBoostedEntries(
  expected: Stock[],
  entries: ScrapedBoosted[],
  now: string,
): { patches: StockPatch[]; summary: IngestSummary } {
  const patches: StockPatch[] = [];
  const summary = emptySummary();
  summary.rowsParsed = entries.length;
  const matchedStockTickers = new Set<string>();

  for (const e of entries) {
    const stock = expected.find((s) => sameCompanyLoose(s.ticker, e.ticker));
    if (!stock) { summary.unmatched.push(e.ticker); continue; }
    summary.matched += 1;
    matchedStockTickers.add(stock.ticker);

    const hasRating = typeof e.rating === "number" && Number.isFinite(e.rating);
    const hasConsensus = !!e.consensus;
    if (hasRating || hasConsensus) {
      const fields: Partial<Stock> = {
        boostedLastScreenshotAt: now,
        boostedLastReadAt: now,
      };
      if (hasRating) fields.boostedAi = e.rating;
      if (hasConsensus) fields.boostedAiConsensus = e.consensus as BoostedAiConsensus;
      const nextRating = hasRating ? e.rating! : stock.boostedAi ?? null;
      const nextConsensus = hasConsensus ? (e.consensus as BoostedAiConsensus) : stock.boostedAiConsensus ?? null;
      const mapped = mapBoostedAiToAiRating(nextRating, nextConsensus);
      patches.push({
        ticker: stock.ticker,
        fields,
        scoreUpdates: mapped != null ? [{ key: "aiRating", value: mapped }] : undefined,
      });
      summary.updated += 1;
    } else {
      summary.inScreenshotButUnreadable.push(stock.ticker);
      patches.push({ ticker: stock.ticker, fields: { boostedLastScreenshotAt: now } });
    }
  }

  for (const s of expected) {
    if (matchedStockTickers.has(s.ticker)) continue;
    summary.expectedButMissing.push(s.ticker);
    patches.push({ ticker: s.ticker, fields: { boostedLastScreenshotAt: now } });
  }

  return { patches, summary };
}

// ── MarketEdge CSV ─────────────────────────────────────────────────

export function applyMarketEdgeRows(
  expected: Stock[],
  rows: MarketEdgeCsvRow[],
): { patches: StockPatch[]; summary: Omit<IngestSummary, "expectedButMissing" | "inScreenshotButUnreadable"> } {
  const patches: StockPatch[] = [];
  let matched = 0;
  let updated = 0;
  const unmatched: string[] = [];

  for (const r of rows) {
    const stock = expected.find((s) => sameCompanyLoose(s.ticker, r.ticker));
    if (!stock) { unmatched.push(r.ticker); continue; }
    matched += 1;
    const me = { ...(stock.marketEdge ?? {}) };
    let touched = false;
    if (r.opinion !== undefined && r.opinion !== me.opinion) {
      me.opinion = r.opinion; touched = true;
    }
    if (r.opinionScore !== undefined && r.opinionScore !== me.opinionScore) {
      me.opinionScore = r.opinionScore; touched = true;
    }
    let prMapped: number | null = null;
    if (r.powerRating !== undefined && r.powerRating !== me.powerRating) {
      me.powerRating = r.powerRating; touched = true;
    }
    if (r.powerRating !== undefined) {
      prMapped = mapPowerRatingToMarketEdge(r.powerRating);
    }
    if (r.opinionDate !== undefined && r.opinionDate !== me.opinionDate) {
      me.opinionDate = r.opinionDate; touched = true;
    }
    if (!touched) continue;
    const scoreUpdates = prMapped != null && stock.scores.marketEdge !== prMapped
      ? [{ key: "marketEdge" as ScoreKey, value: prMapped }]
      : undefined;
    patches.push({ ticker: stock.ticker, fields: { marketEdge: me }, scoreUpdates });
    updated += 1;
  }

  return { patches, summary: { rowsParsed: rows.length, matched, updated, unmatched } };
}
