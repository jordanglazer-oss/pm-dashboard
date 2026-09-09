/**
 * Suggested-name records — `pm:stocks-suggested`.
 *
 * WHY A SEPARATE KEY, NOT A THIRD BUCKET INSIDE pm:stocks.
 *
 * A Suggested name needs a real `Stock` record: that is the only shape the
 * ingest matchers, the scoring route and the score maps understand, so without
 * one every MarketEdge / SIA / BoostedAI row for a suggested name is parsed and
 * dropped on the floor. But `pm:stocks` IS the book — 60+ server modules read
 * it, and ~113 of those call sites treat `bucket` as a binary ("Portfolio" vs
 * everything-else) in a way TypeScript cannot flag. Adding a third bucket value
 * to that blob would silently fold staging names into the morning brief, the
 * alert digests, the change monitor, PIM eligibility and the risk lens.
 *
 * So the records live in their own key with the SAME `Stock[]` shape. Every
 * existing reader of `pm:stocks` is unchanged BY CONSTRUCTION — it cannot see a
 * suggested record — and the paths that should see them (ingest, scoring, the
 * Suggested tab) opt in explicitly. It also keeps `pm:stocks` small, which the
 * Redis tier cares about.
 *
 * Records carry `bucket: "Suggested"` so a record is self-describing even if it
 * is ever copied around, and so a stray one in `pm:stocks` would be filtered by
 * `bookStocks()` rather than read as a holding.
 *
 * LIFECYCLE
 *   - created by the sync (POST /api/suggested-watchlist) for every name on
 *     2+ bullish lists that the book does not already track;
 *   - external data lands on it exactly as it does for a watchlist name;
 *   - scored on demand from the Suggested tab (never automatically — a full
 *     score is the expensive path and this list turns over weekly);
 *   - on promotion the record moves into `pm:stocks` WITH its data, so nothing
 *     gathered while the name was in staging is lost;
 *   - when a name stops qualifying: an EMPTY record (nothing scored, no
 *     provider data) is pruned, because there is nothing to lose; a record that
 *     carries data is KEPT and marked `fallenOffAt` so the PM decides.
 *
 * Never deletes anything that holds data. Prunes stash the pre-image first.
 */

import { SCORE_GROUPS, type Stock, type Scores, type ScoreKey } from "./types";
import { canonicalTicker } from "./ticker";

export const SUGGESTED_STOCKS_KEY = "pm:stocks-suggested";

/** A staging record. Same shape as a book stock plus its staging dates. */
export type SuggestedStock = Stock & {
  /** ISO the sync first created this record. */
  suggestedSince?: string;
  /** ISO the name stopped qualifying. Only set on records worth keeping. */
  fallenOffAt?: string;
};

/** Every score key at 0 — a new staging record starts unscored. */
export function zeroScores(): Scores {
  const out = {} as Scores;
  for (const g of SCORE_GROUPS) {
    for (const c of g.categories) out[c.key as ScoreKey] = 0;
  }
  return out;
}

/** What the sync knows about a qualifying name (from the ranked research). */
export type SuggestedSeed = {
  ticker: string;
  name?: string;
  sector?: string;
  currency?: string;
};

/** True when the record holds nothing worth keeping — no score has ever been
 *  set, no provider has ever reported on it, and the PM has written nothing.
 *  Only these are pruned on fall-off. */
export function isEmptyRecord(s: SuggestedStock): boolean {
  const scored = Object.values(s.scores ?? {}).some((v) => typeof v === "number" && v > 0);
  if (scored) return false;
  if (s.lastScored) return false;
  if (s.explanations && Object.keys(s.explanations).length > 0) return false;
  if (s.marketEdge && Object.keys(s.marketEdge).length > 0) return false;
  if (typeof s.sia === "number") return false;
  if (typeof s.boostedAi === "number" || s.boostedAiConsensus) return false;
  if (s.notes && s.notes.trim().length > 0) return false;
  return true;
}

/** Create a fresh staging record for a qualifying name. */
export function newSuggestedRecord(seed: SuggestedSeed, nowIso: string): SuggestedStock {
  return {
    ticker: seed.ticker,
    name: seed.name || seed.ticker,
    bucket: "Suggested",
    sector: seed.sector || "",
    beta: 1.0,
    weights: { portfolio: 0 },
    scores: zeroScores(),
    currency: seed.currency,
    notes: "",
    suggestedSince: nowIso,
  };
}

export type SyncResult = {
  next: SuggestedStock[];
  /** Tickers that got a new staging record. */
  created: string[];
  /** Records kept but marked as no longer qualifying (they carry data). */
  fellOff: string[];
  /** Empty records dropped because the name stopped qualifying. */
  pruned: string[];
  /** Records dropped because the book now tracks the name (promoted). */
  promotedAway: string[];
};

/**
 * Reconcile the staging store against the current qualifying list.
 *
 * PURE — no Redis, no fetch, so the invariants are readable in one place. The
 * route supplies the previous store and persists the result.
 *
 * `bookTickers` is every ticker in `pm:stocks` (any bucket). A name the book
 * already tracks never gets a staging record, and an existing staging record
 * for such a name is dropped — the book record is the real one from then on.
 * (The promote path copies the staging data into the book record BEFORE this
 * runs, so dropping it here loses nothing.)
 */
export function syncSuggestedStocks(
  prev: SuggestedStock[],
  qualifying: SuggestedSeed[],
  bookTickers: string[],
  nowIso: string,
): SyncResult {
  const book = new Set(bookTickers.map((t) => canonicalTicker(t)));
  const qualifyingByKey = new Map<string, SuggestedSeed>();
  for (const q of qualifying) {
    const key = canonicalTicker(q.ticker);
    if (key && !book.has(key)) qualifyingByKey.set(key, q);
  }

  const next: SuggestedStock[] = [];
  const created: string[] = [];
  const fellOff: string[] = [];
  const pruned: string[] = [];
  const promotedAway: string[] = [];
  const seen = new Set<string>();

  for (const rec of prev) {
    const key = canonicalTicker(rec.ticker);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (book.has(key)) {
      promotedAway.push(rec.ticker);
      continue;
    }
    const stillQualifies = qualifyingByKey.has(key);
    if (stillQualifies) {
      // Re-qualified after a fall-off: clear the mark, keep everything else.
      const { fallenOffAt: _dropped, ...rest } = rec;
      void _dropped;
      next.push(rest as SuggestedStock);
      continue;
    }
    if (isEmptyRecord(rec)) {
      pruned.push(rec.ticker);
      continue;
    }
    fellOff.push(rec.ticker);
    next.push({ ...rec, fallenOffAt: rec.fallenOffAt ?? nowIso });
  }

  for (const [key, seed] of qualifyingByKey) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(newSuggestedRecord(seed, nowIso));
    created.push(seed.ticker);
  }

  return { next, created, fellOff, pruned, promotedAway };
}
