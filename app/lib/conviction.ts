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
import { marketEdgeApplies } from "./scoring";

/** Normalize a ticker for cross-source matching (strip $, class slash → dash,
 *  drop exchange/class suffix). Mirrors app/lib/research-merge.ts. */
function norm(t: string): string {
  return String(t || "").replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
}

export type ConvictionSignalKind = "rating" | "upside" | "external" | "list";

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

/** Research lists that feed conviction, with display label + direction. */
const LISTS: { field: keyof ResearchState; label: string; dir: 1 | -1 }[] = [
  { field: "jpmUsAnalystFocus", label: "JPM Focus", dir: 1 },
  { field: "rbcUsFocus", label: "RBC US", dir: 1 },
  { field: "rbcCanadianFocus", label: "RBC Cdn", dir: 1 },
  { field: "fundstratTop", label: "Fundstrat Top", dir: 1 },
  { field: "fundstratSmidTop", label: "Fundstrat SMID Top", dir: 1 },
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
};

export function computeConviction(input: ComputeConvictionInput): ConvictionEntry[] {
  const { stocks, research, snapshots, prices } = input;

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

    // 1. Composite rating (scored names only).
    if (s && typeof s.adjusted === "number") {
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

    // 3. External category scores (SIA / BoostedAI / MarketEdge).
    if (s) {
      const sia = s.scores?.relativeStrength;
      if (sia === 2) signals.push({ label: "SIA strong", points: 1, kind: "external" });
      else if (sia === 0) signals.push({ label: "SIA weak", points: -1, kind: "external" });
      const ai = s.scores?.aiRating;
      if (ai === 2) signals.push({ label: "BoostedAI buy", points: 1, kind: "external" });
      else if (ai === 0) signals.push({ label: "BoostedAI sell", points: -1, kind: "external" });
      if (marketEdgeApplies(s)) {
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
