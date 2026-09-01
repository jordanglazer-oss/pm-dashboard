/**
 * Conviction Board engine — pure functions that fuse every independent signal
 * the dashboard tracks into ONE ranked list, so the PM can see at a glance where
 * multiple sources AGREE (high conviction) or disagree (worth a second look).
 *
 * Signals per name (each contributes transparent points; negatives allowed):
 *   - Composite rating (the dashboard's own 41-pt score → Strong Buy … Sell)
 *   - FactSet analyst upside to mean target
 *   - SIA / BoostedAI / MarketEdge external category scores
 *   - Membership on each research list (JPM, RBC, Fundstrat, Alpha Picks,
 *     Newton, FEW) — bullish lists add, Fundstrat "bottom" lists subtract
 *
 * Universe = Portfolio + Watchlist (scored stocks) UNION every research-list
 * name, so names you don't yet own but that multiple sources like still surface.
 * Nothing here is persisted — it's derived live from pm:stocks / pm:research /
 * pm:analyst-snapshots on every page load.
 */

import type { ScoredStock } from "./types";
import type { ResearchState } from "./defaults";
import type { AnalystSnapshots } from "./analyst-snapshots";
import { marketEdgeApplies, isScoreable } from "./scoring";

/** Normalize a ticker for cross-source matching (strip $, class slash → dash,
 *  drop exchange/class suffix). Mirrors app/lib/research-merge.ts. */
function norm(t: string): string {
  return String(t || "").replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
}

export type ConvictionSignalKind = "rating" | "upside" | "external" | "list" | "quant" | "setup";

export type ConvictionSignal = {
  label: string;
  points: number;
  kind: ConvictionSignalKind;
};

export type ConvictionEntry = {
  /** Normalized key used for matching across sources. */
  key: string;
  ticker: string;
  name?: string;
  /** "Portfolio" | "Watchlist" for tracked names; "Research" for names that
   *  only appear on a research list (not yet in a bucket). */
  bucket: "Portfolio" | "Watchlist" | "Research";
  total: number;
  signals: ConvictionSignal[];
  scored: boolean;
  composite?: number;
  ratingLabel?: string;
  upsidePct?: number | null;
  /** How many bullish research lists carry this name (for a quick badge). */
  listCount: number;
};

/** Research lists that feed conviction, with display label + direction.
 *
 * equateCad / equateUsd are deliberately ABSENT. They used to be RBC's
 * curated CORE 40 model portfolios — an opinion independent of the quant
 * ranking — but they now hold the top decile of the EQUATE sheets, the same
 * data behind the `Equate rank` signal below. Listing them here would score
 * one reading twice, and the rank says it better: #3 and #130 are both
 * decile 1, and rank <= 25 already scores double. They still feed
 * researchMentions, which is a separate category. */
const LISTS: { field: keyof ResearchState; label: string; dir: 1 | -1 }[] = [
  { field: "jpmUsAnalystFocus", label: "JPM Focus", dir: 1 },
  { field: "rbcUsFocus", label: "RBC US", dir: 1 },
  { field: "rbcCanadianFocus", label: "RBC Cdn", dir: 1 },
  { field: "fundstratTop", label: "Fundstrat Top", dir: 1 },
  { field: "fundstratSmidTop", label: "Fundstrat SMID Top", dir: 1 },
  { field: "fundstratLargeCapCore", label: "Fundstrat Large-Cap Core", dir: 1 },
  { field: "fundstratSmidCore", label: "Fundstrat SMID Core", dir: 1 },
  { field: "alphaPicks", label: "Alpha Picks", dir: 1 },
  { field: "newtonUpticks", label: "Newton Upticks", dir: 1 },
  { field: "rbccmFew", label: "RBCCM FEW", dir: 1 },
  { field: "fundstratBottom", label: "Fundstrat Bottom", dir: -1 },
  { field: "fundstratSmidBottom", label: "Fundstrat SMID Bottom", dir: -1 },
];

function ratingFor(adjusted: number): { label: string; points: number } {
  if (adjusted >= 30) return { label: "Strong Buy", points: 3 };
  if (adjusted >= 26) return { label: "Buy", points: 2 };
  if (adjusted >= 22) return { label: "Hold", points: 0 };
  if (adjusted >= 18) return { label: "Underweight", points: -1 };
  return { label: "Sell", points: -2 };
}

export type ComputeConvictionInput = {
  stocks: ScoredStock[];
  research: ResearchState | null | undefined;
  snapshots: AnalystSnapshots;
  /** ticker → live price, for the FactSet upside calc (falls back to stock.price). */
  prices: Record<string, number | null | undefined>;
  /** Weekly RBC EQUATE composite ranks. Optional — absent simply means the
   *  quant signal does not fire, never that a name scores worse. */
  equateRanks?: { symbol: string; compositeRank: number; decile: number }[];
  /** Latest setup-scan rows. Optional, same reasoning. */
  setups?: { ticker: string; base: { score: number; label: string } | null }[];
};

export function computeConviction(input: ComputeConvictionInput): ConvictionEntry[] {
  const { stocks, research, snapshots, prices, equateRanks, setups } = input;

  /**
   * RBC EQUATE composite RANK, from the weekly rank sheets.
   *
   * Deliberately separate from the existing "Equate CAD / USD" list signals:
   * those are membership of the CORE 40 MODEL PORTFOLIO — forty names RBC has
   * actually picked — whereas this is position within a 1,360-name quant
   * ranking. Folding one into the other would destroy the distinction and
   * overwrite a curated list with a screen.
   *
   * Decile 1 is the top 10% of the universe; rank <= 25 is the sharp end of
   * that, and scores double.
   */
  const rankByKey = new Map<string, { rank: number; decile: number }>();
  for (const r of equateRanks || []) {
    const key = norm(r.symbol);
    const prev = rankByKey.get(key);
    // A name can appear in both regional sheets; keep the better reading.
    if (!prev || r.compositeRank < prev.rank) rankByKey.set(key, { rank: r.compositeRank, decile: r.decile });
  }

  /**
   * Technical SETUP, from the setup scan.
   *
   * The only forward-looking signal here. Every other input describes what has
   * already happened — a rating earned, a list published, a rank achieved — so
   * the board systematically favours names that have already moved. A coiled
   * base is the one reading that says "not yet".
   */
  const setupByKey = new Map<string, { base: number; label: string }>();
  for (const row of setups || []) {
    if (!row.base || row.base.score < 3) continue; // Building or better only
    setupByKey.set(norm(row.ticker), { base: row.base.score, label: row.base.label });
  }

  // Per-list membership sets keyed by normalized ticker + a display-ticker map.
  const listSets = LISTS.map((l) => {
    const arr = (research?.[l.field] as Array<{ ticker?: string }> | undefined) || [];
    return { ...l, keys: new Set(arr.map((e) => norm(e?.ticker || "")).filter(Boolean)) };
  });

  // FactSet target + estimate revisions keyed by normalized ticker
  // (analyst-snapshots is canonical-ticker keyed, so normalize on read).
  const targetByKey = new Map<string, number>();
  const revByKey = new Map<string, { up: number; down: number }>();
  for (const [t, snap] of Object.entries(snapshots || {})) {
    const key = norm(t);
    const tgt = snap?.factset?.averageTarget;
    if (typeof tgt === "number" && tgt > 0) targetByKey.set(key, tgt);
    const up = snap?.factset?.revUp;
    const down = snap?.factset?.revDown;
    if (typeof up === "number" || typeof down === "number") {
      revByKey.set(key, { up: up ?? 0, down: down ?? 0 });
    }
  }

  // Build the universe: scored stocks first (richest data), then any research
  // name not already present.
  const entries = new Map<string, ConvictionEntry>();
  const stockByKey = new Map<string, ScoredStock>();
  for (const s of stocks) {
    // Conviction is an equity-selection tool — exclude ETFs / mutual funds.
    if (!isScoreable(s)) continue;
    const key = norm(s.ticker);
    stockByKey.set(key, s);
    entries.set(key, {
      key,
      ticker: s.ticker,
      name: s.name,
      bucket: s.bucket,
      total: 0,
      signals: [],
      scored: true,
      composite: s.adjusted,
      listCount: 0,
    });
  }
  for (const l of listSets) {
    const arr = (research?.[l.field] as Array<{ ticker?: string; name?: string }> | undefined) || [];
    for (const e of arr) {
      const key = norm(e?.ticker || "");
      if (!key || entries.has(key)) continue;
      entries.set(key, {
        key,
        ticker: e.ticker || key,
        name: e.name,
        bucket: "Research",
        total: 0,
        signals: [],
        scored: false,
        listCount: 0,
      });
    }
  }

  for (const entry of entries.values()) {
    const s = stockByKey.get(entry.key);
    const signals: ConvictionSignal[] = [];

    // 1. Composite rating — only for names that have ACTUALLY been scored.
    //    A freshly-added watchlist name has raw 0 (no categories filled yet);
    //    tagging it "Composite: Sell −2" for being un-scored is the bug — an
    //    absent score must read neutral, not bearish.
    if (s && typeof s.adjusted === "number" && (s.raw ?? 0) > 0) {
      const r = ratingFor(s.adjusted);
      entry.ratingLabel = r.label;
      if (r.points !== 0) signals.push({ label: `Composite: ${r.label}`, points: r.points, kind: "rating" });
    }

    // 2. FactSet upside to mean target.
    const price = prices[entry.ticker] ?? (s?.price ?? null);
    const target = targetByKey.get(entry.key);
    if (typeof price === "number" && price > 0 && typeof target === "number") {
      const up = ((target - price) / price) * 100;
      entry.upsidePct = up;
      if (up >= 25) signals.push({ label: `Upside +${up.toFixed(0)}%`, points: 2, kind: "upside" });
      else if (up >= 10) signals.push({ label: `Upside +${up.toFixed(0)}%`, points: 1, kind: "upside" });
      else if (up <= -10) signals.push({ label: `Below target ${up.toFixed(0)}%`, points: -1, kind: "upside" });
    }

    // 3. External category scores (SIA / BoostedAI / MarketEdge) — each ONLY
    //    counts when its RAW source was actually imported. A score of 0 means
    //    "weak/sell/avoid" ONLY if the data exists; for a not-yet-imported name
    //    the 0 is just a default, and must read neutral (no signal) rather than
    //    dragging the name to the bottom for data it hasn't received yet.
    if (s) {
      if (typeof s.sia === "number") {
        const sia = s.scores?.relativeStrength;
        if (sia === 2) signals.push({ label: "SIA strong", points: 1, kind: "external" });
        else if (sia === 0) signals.push({ label: "SIA weak", points: -1, kind: "external" });
      }
      if (typeof s.boostedAi === "number" || s.boostedAiConsensus != null) {
        const ai = s.scores?.aiRating;
        if (ai === 2) signals.push({ label: "BoostedAI buy", points: 1, kind: "external" });
        else if (ai === 0) signals.push({ label: "BoostedAI sell", points: -1, kind: "external" });
      }
      // marketEdgeApplies already excludes pure-Canadian names MarketEdge can't
      // cover; also require the raw reading to be present so an un-imported US
      // name isn't tagged "avoid".
      if (marketEdgeApplies(s) && (s.marketEdge?.powerRating != null || s.marketEdge?.opinion != null)) {
        const me = s.scores?.marketEdge;
        if (me === 2) signals.push({ label: "MarketEdge long", points: 1, kind: "external" });
        else if (me === 0) signals.push({ label: "MarketEdge avoid", points: -1, kind: "external" });
      }
    }

    // 3b. Estimate-revision momentum (FactSet EPS FY+1, last 30d).
    const rev = revByKey.get(entry.key);
    if (rev && (rev.up > 0 || rev.down > 0)) {
      const net = rev.up - rev.down;
      if (net >= 2) signals.push({ label: `Estimates ↑ (${rev.up}/${rev.down})`, points: 1, kind: "external" });
      else if (net <= -2) signals.push({ label: `Estimates ↓ (${rev.up}/${rev.down})`, points: -1, kind: "external" });
    }

    // 3c. EQUATE quant rank.
    const qr = rankByKey.get(entry.key);
    if (qr && qr.decile <= 1) {
      signals.push({
        label: qr.rank <= 25 ? `Equate rank #${qr.rank}` : `Equate top decile (#${qr.rank})`,
        points: qr.rank <= 25 ? 2 : 1,
        kind: "quant",
      });
    }

    // 3d. Technical setup — the only signal that is not backward-looking.
    const su = setupByKey.get(entry.key);
    if (su) {
      signals.push({
        label: su.base >= 4 ? "Coiled base" : "Base building",
        points: su.base >= 4 ? 2 : 1,
        kind: "setup",
      });
    }

    // 4. Research-list membership.
    let listCount = 0;
    for (const l of listSets) {
      if (l.keys.has(entry.key)) {
        signals.push({ label: l.label, points: l.dir, kind: "list" });
        if (l.dir > 0) listCount += 1;
      }
    }
    entry.listCount = listCount;

    entry.signals = signals;
    entry.total = signals.reduce((sum, sig) => sum + sig.points, 0);
  }

  // Highest conviction first; tie-break by composite then ticker.
  return [...entries.values()].sort(
    (a, b) =>
      b.total - a.total ||
      (b.composite ?? -1) - (a.composite ?? -1) ||
      a.ticker.localeCompare(b.ticker)
  );
}
