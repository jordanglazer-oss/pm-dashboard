/**
 * Suggested Watchlist — candidates assembled from every research source the
 * inbox already ingests, refreshed weekly.
 *
 * WHAT THIS IS FOR. The sources each live in their own store and get read one
 * at a time, so a name appearing on four lists at once looks exactly like a
 * name appearing on one. Confluence is the signal, and nothing surfaced it.
 *
 * TWO THINGS IT TRACKS, not one:
 *   - what ARRIVED, and on how many independent lists
 *   - what FELL OFF — a name that was on three lists last week and none this
 *     week has told you something, and a purely additive list would simply
 *     forget it. Fall-off is kept for FALLOFF_RETENTION_WEEKS with the date it
 *     dropped, so a fading name is visible rather than absent.
 *
 * DELIBERATELY NOT DEDUPED AGAINST THE REAL WATCHLIST. A name you already
 * track still carries signal when four sources light up on it, and promoting a
 * candidate must not make it vanish from the list that recommended it. Only
 * the weekly refresh removes anything.
 *
 * Pure: no Redis, no fetch. The route supplies the previous state and the
 * fresh hits and persists whatever comes back.
 */

/** Every list that can nominate a name. Weight = how much one hit is worth. */
export const SOURCE_WEIGHTS = {
  "rbc-equate-cad": 3,
  "rbc-equate-usd": 3,
  sia: 3,
  boosted: 3,
  marketedge: 2,
  "rbc-focus": 2,
  "rbc-us-focus": 2,
  "jpm-us-analyst-focus": 2,
  "fundstrat-top": 2,
  "fundstrat-smid-top": 2,
  "fundstrat-largecap-core": 1,
  "fundstrat-smid-core": 1,
  "rbccm-few": 1,
  "seeking-alpha-picks": 1,
  "newton-upticks": 1,
} as const;

export type CandidateSource = keyof typeof SOURCE_WEIGHTS | string;

/** One nomination of one ticker by one source, from this week's ingest. */
export type SourceHit = {
  ticker: string;
  name?: string;
  source: CandidateSource;
  sector?: string;
  /** Rank within that source's list, when it publishes one (1 = best). */
  rank?: number;
  /** The source's own verdict, when it has one. NEGATIVE hits never add to a
   *  candidate's score — a "strong sell" is not a reason to look at a name. */
  signal?: "buy" | "strong-buy" | "sell" | "strong-sell" | "neutral";
  /**
   * How STRONG this nomination is beyond mere presence on the list, 0..1.
   *
   * Presence and conviction are different things, and a binary strong-buy flag
   * collapsed them: a name climbing 30 places scored exactly the same as one
   * climbing 300. Normalised per source so no single list can dominate by
   * publishing a bigger number — SIA maps places-climbed onto it, a quant rank
   * sheet maps position within the universe.
   */
  magnitude?: number;
};

export type Candidate = {
  ticker: string;
  name: string;
  sector?: string;
  /** source → what that source said, most recent wins. */
  sources: Record<string, { rank?: number; signal?: string; magnitude?: number; seenAt: string }>;
  score: number;
  /** Score at the previous refresh, so movement is visible. */
  previousScore?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Set when a refresh no longer finds the name on ANY source. */
  fallenOffAt?: string;
  /** Sources it held at the moment it fell off — what it lost. */
  fellFrom?: string[];
};

export type CandidateStore = {
  candidates: Candidate[];
  generatedAt?: string;
  /** Sources that reported in the latest refresh. A source that did not
   *  deliver must NOT be read as every one of its names falling off. */
  sourcesSeen?: string[];
};

const FALLOFF_RETENTION_WEEKS = 6;
const NEGATIVE: string[] = ["sell", "strong-sell"];

const norm = (t: string) => t.trim().toUpperCase().replace(/-T$/, ".TO");

/** A hit's contribution: source weight, doubled for a strong buy, plus a
 *  small bonus for ranking near the top of a ranked list. */
function hitScore(h: SourceHit): number {
  if (h.signal && NEGATIVE.includes(h.signal)) return 0;
  const base = (SOURCE_WEIGHTS as Record<string, number>)[h.source] ?? 1;
  const conviction = h.signal === "strong-buy" ? 2 : 1;
  const rankBonus = h.rank != null && h.rank > 0 ? (h.rank <= 5 ? 2 : h.rank <= 15 ? 1 : 0) : 0;
  // Graduated, and capped at 3 so a source with a dramatic number cannot
  // outweigh genuine confluence across several independent lists.
  const mag = h.magnitude == null ? 0 : Math.round(Math.min(Math.max(h.magnitude, 0), 1) * 3);
  return base * conviction + rankBonus + mag;
}

/**
 * Fold this week's hits into the existing candidate list.
 *
 * `sourcesSeen` is load-bearing: fall-off is only assessed for names whose
 * sources actually reported. If the SIA export doesn't arrive one week, every
 * SIA name would otherwise appear to have dropped off at once — a fake signal
 * far worse than a missing one.
 */
export function mergeCandidates(
  prev: CandidateStore,
  hits: SourceHit[],
  asOf: string,
  sourcesSeen: string[],
): CandidateStore {
  const seen = new Set(sourcesSeen);
  const byTicker = new Map<string, Candidate>();
  for (const c of prev.candidates ?? []) byTicker.set(norm(c.ticker), { ...c, sources: { ...c.sources } });

  // 1. Apply this week's hits.
  const hitTickers = new Set<string>();
  for (const h of hits) {
    const key = norm(h.ticker);
    if (!key) continue;
    hitTickers.add(key);
    const existing = byTicker.get(key);
    const entry = { rank: h.rank, signal: h.signal, magnitude: h.magnitude, seenAt: asOf };
    if (existing) {
      existing.sources[h.source] = entry;
      if (h.name) existing.name = h.name;
      if (h.sector) existing.sector = h.sector;
      existing.lastSeenAt = asOf;
      // Back on a list — it is no longer fallen off.
      delete existing.fallenOffAt;
      delete existing.fellFrom;
    } else {
      byTicker.set(key, {
        ticker: h.ticker.trim().toUpperCase(),
        name: h.name || h.ticker.trim().toUpperCase(),
        sector: h.sector,
        sources: { [h.source]: entry },
        score: 0,
        firstSeenAt: asOf,
        lastSeenAt: asOf,
      });
    }
  }

  // 2. Drop stale source entries and assess fall-off — but ONLY for sources
  //    that actually reported this week.
  for (const c of byTicker.values()) {
    for (const src of Object.keys(c.sources)) {
      if (!seen.has(src)) continue; // that list didn't arrive; leave it alone
      if (c.sources[src].seenAt !== asOf) delete c.sources[src];
    }
    const live = Object.keys(c.sources).length > 0;
    if (!live && !c.fallenOffAt) {
      c.fallenOffAt = asOf;
      c.fellFrom = Object.keys(prev.candidates?.find((p) => norm(p.ticker) === norm(c.ticker))?.sources ?? {});
    }
  }

  // 3. Rescore, remembering the prior score so movement is readable.
  const out: Candidate[] = [];
  const cutoff = new Date(Date.parse(asOf) - FALLOFF_RETENTION_WEEKS * 7 * 86400_000).toISOString();
  for (const c of byTicker.values()) {
    const prevScore = prev.candidates?.find((p) => norm(p.ticker) === norm(c.ticker))?.score;
    const score = Object.entries(c.sources).reduce(
      (s, [src, v]) =>
        s +
        hitScore({
          ticker: c.ticker,
          source: src,
          rank: v.rank,
          signal: v.signal as SourceHit["signal"],
          magnitude: v.magnitude,
        }),
      0,
    );
    // Retire a fallen name once it has been gone long enough to stop being news.
    if (c.fallenOffAt && c.fallenOffAt < cutoff) continue;
    out.push({ ...c, score, previousScore: prevScore });
  }

  // Live names first, by score; fallen names after, most recent drop first.
  out.sort((a, b) => {
    const af = !!a.fallenOffAt, bf = !!b.fallenOffAt;
    if (af !== bf) return af ? 1 : -1;
    if (af && bf) return (b.fallenOffAt ?? "").localeCompare(a.fallenOffAt ?? "");
    return b.score - a.score || a.ticker.localeCompare(b.ticker);
  });

  return { candidates: out, generatedAt: asOf, sourcesSeen };
}

/** Names new since the previous refresh — the "new this week" lane. */
export function newThisWeek(store: CandidateStore): Candidate[] {
  return store.candidates.filter((c) => !c.fallenOffAt && c.firstSeenAt === store.generatedAt);
}

/** Names that dropped off in the latest refresh. */
export function fellOffThisWeek(store: CandidateStore): Candidate[] {
  return store.candidates.filter((c) => c.fallenOffAt === store.generatedAt);
}

/** Sector tally across live candidates — "where should we be looking". */
export function sectorStrength(store: CandidateStore): { sector: string; count: number; score: number }[] {
  const by = new Map<string, { count: number; score: number }>();
  for (const c of store.candidates) {
    if (c.fallenOffAt || !c.sector) continue;
    const cur = by.get(c.sector) ?? { count: 0, score: 0 };
    by.set(c.sector, { count: cur.count + 1, score: cur.score + c.score });
  }
  return [...by.entries()]
    .map(([sector, v]) => ({ sector, ...v }))
    .sort((a, b) => b.score - a.score);
}
