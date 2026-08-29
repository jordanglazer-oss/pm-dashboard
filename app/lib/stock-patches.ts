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
import { sameCompanyLoose, tickersEqual } from "./ticker";
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

/** How recently a name must have been read for a later file in the SAME
 *  upload batch to leave its staleness stamp alone. Wide enough to span one
 *  email's attachments arriving as separate webhook calls, far narrower than
 *  the weekly SIA cadence. */
const SAME_BATCH_MS = 6 * 60 * 60 * 1000;

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
  /** Optional: full Portfolio + Watchlist (including ETFs / mutual funds).
   *  Used to silently filter held-but-not-scoreable names (ETFs/funds) out
   *  of the "unmatched" warning — those names show up in SIA exports too,
   *  but they don't feed the relativeStrength score so we just drop them
   *  rather than clutter the actionable warning. Pass `expected` (or omit)
   *  if you want the legacy behavior. */
  allHeld?: Stock[],
  /** Universe mode: the upload is a full-index export (S&P 500 / TSX), not a
   *  watchlist. Rows that don't match a held name are EXPECTED — the whole
   *  index is in the file — so they aren't collected into `unmatched`, which
   *  is meant as an actionable "this should be in your book" nudge and would
   *  otherwise be ~960 tickers of noise. The full row set is persisted
   *  separately by app/lib/sia-universe; matching behaviour for names you DO
   *  hold is unchanged. */
  universeMode?: boolean,
): { patches: StockPatch[]; summary: IngestSummary } {
  const patches: StockPatch[] = [];
  const summary = emptySummary();
  summary.rowsParsed = entries.length;
  const matchedStockTickers = new Set<string>();
  const held = allHeld ?? expected;

  // MATCH STRICTNESS DEPENDS ON THE SOURCE.
  //
  // A holdings export or screenshot lists the PM's own names, and the surface
  // form drifts between sources ("RY", "RY-T", "RY.TO"), so the loose
  // cross-listing match earns its keep there.
  //
  // A full-index export does NOT. It carries the correct listing for every
  // name it contains, so loose matching buys nothing and costs correctness:
  // crossListingRoot strips ".TO", which collapses the TSX's Loblaw (L.TO)
  // onto the S&P's Loews Corp (L) — two unrelated companies. Ingesting the
  // S&P 500 file then wrote Loews' SMAX onto the Loblaw position, and which
  // value survived depended on the order the week's attachments happened to
  // be processed in. Verified against the real exports: tightening to
  // tickersEqual in universe mode keeps all 49 genuine matches and drops only
  // that collision.
  const matches = universeMode ? tickersEqual : sameCompanyLoose;

  for (const e of entries) {
    const stock = expected.find((s) => matches(s.ticker, e.ticker));
    if (!stock) {
      // If this is an ETF/fund the PM holds, silently drop it — SIA assigns
      // SMAX scores to ETFs too but our scoring system only applies to
      // individual stocks. Putting them in "unmatched" was misleading noise.
      const heldNotScoreable = held.find((s) => matches(s.ticker, e.ticker));
      if (!heldNotScoreable && !universeMode) summary.unmatched.push(e.ticker);
      continue;
    }
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
  //
  // NOT in universe mode. The stamp means "an upload happened and this name
  // wasn't readable in it", and a newer siaLastScreenshotAt than
  // siaLastReadAt is what raises the "type this one in by hand" chip on the
  // stock page and the Inbox. An index export legitimately contains only its
  // own index, so the S&P 500 file was flagging all 26 held names outside it
  // — every Canadian position — as unreadable. The holdings exports arrive in
  // the same email and cover the whole book, so they remain the honest
  // source of that staleness signal.
  if (!universeMode) {
    for (const s of expected) {
      if (matchedStockTickers.has(s.ticker)) continue;
      // …and not if this name was read from SIA moments ago. The portfolio
      // and watchlist exports are separate attachments on the SAME email, so
      // each covers only part of the book and each was stamping every name
      // the OTHER one carried. Processed seconds apart, that leaves the first
      // file's names with siaLastScreenshotAt newer than their own
      // siaLastReadAt — the exact condition for the "SIA couldn't read this
      // one, type it in" chip — so ~42 names raised a false flag every week
      // on data that had just been read successfully. A name genuinely absent
      // from the whole batch still has a week-old read and still flags.
      const lastRead = Date.parse(s.siaLastReadAt ?? "");
      if (Number.isFinite(lastRead) && Date.parse(now) - lastRead < SAME_BATCH_MS) continue;
      summary.expectedButMissing.push(s.ticker);
      patches.push({ ticker: s.ticker, fields: { siaLastScreenshotAt: now } });
    }
  }

  return { patches, summary };
}

// ── BoostedAI ───────────────────────────────────────────────────────

export function applyBoostedEntries(
  expected: Stock[],
  entries: ScrapedBoosted[],
  now: string,
  /** See applySiaEntries — same ETF/fund silent-filter behavior. */
  allHeld?: Stock[],
): { patches: StockPatch[]; summary: IngestSummary } {
  const patches: StockPatch[] = [];
  const summary = emptySummary();
  summary.rowsParsed = entries.length;
  const matchedStockTickers = new Set<string>();
  const held = allHeld ?? expected;

  for (const e of entries) {
    const stock = expected.find((s) => sameCompanyLoose(s.ticker, e.ticker));
    if (!stock) {
      // Held ETFs/funds with BoostedAI ratings get silently filtered —
      // they don't feed aiRating and would just clutter "unmatched".
      const heldNotScoreable = held.find((s) => sameCompanyLoose(s.ticker, e.ticker));
      if (!heldNotScoreable) summary.unmatched.push(e.ticker);
      continue;
    }
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
