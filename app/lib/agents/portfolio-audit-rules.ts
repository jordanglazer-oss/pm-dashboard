import { bookTargets } from "@/app/lib/staged-rebalance";
import { sameSymbol } from "@/app/lib/model-staging";
import { analystTrend, type AnalystHistory } from "@/app/lib/analyst-history";
import type { EquityBucket, PimModelGroup, PimPortfolioPositions, PimProfileType } from "@/app/lib/pim-types";
import type { FlagPriority } from "./flags";

/**
 * Portfolio audit — the rules that need more than the thesis store
 * (Nov 2026): position DRIFT vs the model, how the stock sleeve is
 * CONSTRUCTED, and the sell-side TREND from pm:analyst-history.
 *
 * Every function here is PURE (no I/O) — app/lib/agents/portfolio-audit.ts
 * loads the data, fetches prices and raises the flags. Each rule stays
 * silent when its inputs are missing: a price that could not be fetched, a
 * sector that is not on file, or an analyst log too young to compare never
 * produces a finding.
 */

/** Defaults — proposed to the PM for approval; change here only. */
export const AUDIT_RULES = {
  /** A thesis signed longer ago than this is "stale". */
  thesisStaleDays: 180,
  /** A pillar marked broken this long with the name still held. */
  brokenPillarDays: 14,
  /** A breaker tripped this long with the name still held. */
  trippedDays: 14,
  /** Two or more pillars on "watch" for this long. */
  watchPillarDays: 60,
  /** Drift: live weight off the model by this many points of the portfolio… */
  driftAbsPts: 0.01,
  /** …or by this share of its model weight. */
  driftRelative: 0.35,
  /** Construction: one stock above this share of the All-Equity portfolio. */
  maxStockOfPortfolio: 0.1,
  /** Construction: one sector above this share of the individual-stock sleeve. */
  maxSectorOfStocks: 0.35,
  /** Construction: the five largest stocks above this share of the stock sleeve. */
  maxTop5OfStocks: 0.6,
  /** Construction: fewer sectors than this among the stocks. */
  minSectors: 3,
  /** Sector rules need a sector on file for at least this share of the sleeve. */
  minSectorCoverage: 0.8,
  /** Analysts: mean target down this much (%) in 30 days. */
  targetCutPct30d: 10,
  /** Analysts: this many fewer analysts than 90 days ago. */
  analystDrop90d: 3,
  /** Analysts: this many target cuts in a row. */
  targetCutStreak: 3,
};

export type AuditFinding = { rule: string; priority: FlagPriority; ticker?: string; title: string; detail: string; suggestion: string; dedupeKey: string; names?: string[] };

const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;
export const MAIN_PROFILES: PimProfileType[] = ["conservative", "balanced", "growth", "allEquity"];
const PROFILE_LABEL: Record<string, string> = { conservative: "Conservative", balanced: "Balanced", growth: "Growth", allEquity: "All-Equity" };

/** Monday (YYYY-MM-DD) of the week `today` falls in — the weekly dedupe key. */
export function weekOf(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export type DriftRow = { symbol: string; profile: string; live: number; model: number; diff: number };

/**
 * Live weight vs model weight for every INDIVIDUAL STOCK in the PIM group's
 * main books. `priceCad(symbol)` = latest C$ price per unit, or null.
 * A book with any held position that cannot be priced is skipped whole (its
 * total would be wrong), as is a book with no units. One row per stock: the
 * book where it is furthest from the model. Core ETFs and Managed Alpha
 * funds are never reported.
 */
export function driftRows(pim: PimModelGroup, bucket: (symbol: string) => EquityBucket, books: PimPortfolioPositions[], priceCad: (symbol: string) => number | null): DriftRow[] {
  const worst = new Map<string, DriftRow>();
  for (const profile of MAIN_PROFILES) {
    if (!pim.profiles[profile]) continue;
    const book = books.find((b) => b.groupId === pim.id && b.profile === profile);
    const held = (book?.positions ?? []).filter((p) => p.units > 0);
    if (!book || !held.length) continue;
    let total = Number.isFinite(book.cashBalance) ? book.cashBalance : 0;
    const values = new Map<string, number>();
    let priced = true;
    for (const p of held) {
      const px = priceCad(p.symbol);
      if (px == null || !(px > 0)) {
        priced = false;
        break;
      }
      values.set(p.symbol, p.units * px);
      total += p.units * px;
    }
    if (!priced || !(total > 0)) continue;
    const targets = bookTargets(pim, profile, bucket);
    const seen = new Set<string>();
    const consider = (symbol: string, model: number) => {
      const key = symbol.toUpperCase();
      if (seen.has(key) || bucket(symbol) !== "alpha") return;
      seen.add(key);
      const value = [...values.entries()].filter(([s]) => sameSymbol(s, symbol)).reduce((a, [, v]) => a + v, 0);
      const live = value / total;
      const diff = live - model;
      const off = Math.abs(diff) >= AUDIT_RULES.driftAbsPts || (model > 0 && Math.abs(diff) / model >= AUDIT_RULES.driftRelative);
      if (!off) return;
      const prev = worst.get(key);
      if (!prev || Math.abs(diff) > Math.abs(prev.diff)) worst.set(key, { symbol: key, profile, live, model, diff });
    };
    for (const t of targets) consider(t.h.symbol, t.pct);
    // Held but no longer in the model: only the absolute rule can apply.
    for (const p of held) if (!targets.some((t) => sameSymbol(t.h.symbol, p.symbol))) consider(p.symbol, 0);
  }
  return [...worst.values()].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

export function driftFindings(rows: DriftRow[], today: string): AuditFinding[] {
  if (!rows.length) return [];
  const names = rows.map((r) => `${r.symbol} (${PROFILE_LABEL[r.profile] ?? r.profile}: ${pct(r.live)} vs model ${pct(r.model)})`);
  return [
    {
      rule: "position-drift",
      priority: "medium",
      title: `${rows.length} stock${rows.length === 1 ? " has" : "s have"} drifted from model weight`,
      detail: `Live weight is off the model by at least ${(AUDIT_RULES.driftAbsPts * 100).toFixed(1)} point of the portfolio or ${Math.round(AUDIT_RULES.driftRelative * 100)}% of the target: ${names.join(", ")}.`,
      suggestion: "Decide for each: trim or add back to model, or change the model weight to what you actually want to hold.",
      dedupeKey: `audit-position-drift-${weekOf(today)}`,
      names,
    },
  ];
}

export type SectorStock = { ticker: string; sector?: string };

/** How the individual-stock sleeve is built, from the PIM model's weights. */
export function constructionFindings(pim: PimModelGroup, bucket: (symbol: string) => EquityBucket, stocks: SectorStock[], today: string): AuditFinding[] {
  const month = today.slice(0, 7);
  const sleeve = pim.holdings.filter((h) => h.assetClass === "equity" && h.weightInClass > 0 && bucket(h.symbol) === "alpha");
  const total = sleeve.reduce((a, h) => a + h.weightInClass, 0);
  if (!sleeve.length || !(total > 0)) return [];
  const out: AuditFinding[] = [];
  const equity = pim.profiles.allEquity?.equity ?? 1;
  const cap = pct(AUDIT_RULES.maxStockOfPortfolio, 0);

  const big = sleeve.filter((h) => h.weightInClass * equity > AUDIT_RULES.maxStockOfPortfolio).map((h) => `${h.symbol.toUpperCase()} (${pct(h.weightInClass * equity)})`);
  if (big.length)
    out.push({
      rule: "stock-over-cap",
      priority: "medium",
      title: `${big.length} stock${big.length === 1 ? " is" : "s are"} above ${cap} of the All-Equity portfolio`,
      detail: `Model weight above the ${cap} single-stock limit: ${big.join(", ")}.`,
      suggestion: "Cut the model weight to the limit, or record why this position is the exception.",
      dedupeKey: `audit-stock-over-cap-${month}`,
      names: big,
    });

  const top5 = [...sleeve].sort((a, b) => b.weightInClass - a.weightInClass).slice(0, 5);
  const top5Share = top5.reduce((a, h) => a + h.weightInClass, 0) / total;
  // With five stocks or fewer the top five are the whole sleeve by definition.
  if (sleeve.length > 5 && top5Share > AUDIT_RULES.maxTop5OfStocks)
    out.push({
      rule: "top5-concentration",
      priority: "low",
      title: `The five largest stocks are ${pct(top5Share, 0)} of the stock sleeve`,
      detail: `The five largest stocks make up ${pct(top5Share, 0)} of the individual-stock sleeve (limit ${pct(AUDIT_RULES.maxTop5OfStocks, 0)}): ${top5.map((h) => `${h.symbol.toUpperCase()} ${pct(h.weightInClass / total, 0)}`).join(", ")}.`,
      suggestion: "Check this concentration is intended.",
      dedupeKey: `audit-top5-concentration-${month}`,
    });

  const sectorOf = (sym: string) => (stocks.find((s) => sameSymbol(s.ticker, sym))?.sector ?? "").trim();
  const bySector = new Map<string, { weight: number; names: string[] }>();
  let known = 0;
  for (const h of sleeve) {
    const sec = sectorOf(h.symbol);
    if (!sec || /^(unknown|n\/a|other|-)$/i.test(sec)) continue;
    known += h.weightInClass;
    const cur = bySector.get(sec) ?? { weight: 0, names: [] };
    cur.weight += h.weightInClass;
    cur.names.push(h.symbol.toUpperCase());
    bySector.set(sec, cur);
  }
  // Sector rules only when the sector is on file for most of the sleeve.
  if (known / total >= AUDIT_RULES.minSectorCoverage) {
    const limit = pct(AUDIT_RULES.maxSectorOfStocks, 0);
    const heavy = [...bySector.entries()].filter(([, v]) => v.weight / total > AUDIT_RULES.maxSectorOfStocks).map(([sec, v]) => `${sec} ${pct(v.weight / total, 0)} (${v.names.join(", ")})`);
    if (heavy.length)
      out.push({
        rule: "sector-concentration",
        priority: "low",
        title: `${heavy.length} sector${heavy.length === 1 ? " is" : "s are"} above ${limit} of the stock sleeve`,
        detail: `Share of the individual-stock sleeve by sector, above the ${limit} limit: ${heavy.join("; ")}. This counts the stocks only — the Core index ETFs add to the same sectors.`,
        suggestion: "Check the sector weight is a decision, not an accident of the names picked.",
        dedupeKey: `audit-sector-concentration-${month}`,
        names: heavy,
      });
    // "Too few sectors" needs every stock's sector — a missing one could be the third.
    if (known / total >= 0.999 && bySector.size < AUDIT_RULES.minSectors)
      out.push({
        rule: "few-sectors",
        priority: "low",
        title: `The stocks sit in only ${bySector.size} sector${bySector.size === 1 ? "" : "s"}`,
        detail: `The individual stocks cover ${bySector.size} sector${bySector.size === 1 ? "" : "s"} (${[...bySector.keys()].join(", ")}); fewer than ${AUDIT_RULES.minSectors}.`,
        suggestion: "Check the stock sleeve is as diversified as intended.",
        dedupeKey: `audit-few-sectors-${month}`,
      });
  }
  return out;
}

/** Sell-side trend on held stocks, from pm:analyst-history. Silent until a reading is old enough. */
export function analystFindings(held: string[], history: AnalystHistory, today: string): AuditFinding[] {
  const names: string[] = [];
  for (const sym of held) {
    const entries = Object.entries(history).find(([k]) => sameSymbol(k, sym))?.[1];
    if (!Array.isArray(entries) || entries.length < 2) continue;
    const t = analystTrend(entries, today);
    const why: string[] = [];
    if (t.d30?.targetPct != null && t.d30.targetPct <= -AUDIT_RULES.targetCutPct30d) why.push(`average target down ${Math.abs(t.d30.targetPct).toFixed(1)}% in 30 days`);
    if (t.d90?.count != null && t.d90.count <= -AUDIT_RULES.analystDrop90d) why.push(`${Math.abs(t.d90.count)} fewer analysts than 90 days ago`);
    if (t.targetStreak?.direction === "down" && t.targetStreak.changes >= AUDIT_RULES.targetCutStreak) why.push(`${t.targetStreak.changes} target cuts in a row`);
    if (why.length) names.push(`${sym} (${why.join("; ")})`);
  }
  if (!names.length) return [];
  return [
    {
      rule: "analyst-trend",
      priority: "medium",
      title: `Analysts are turning on ${names.length} held stock${names.length === 1 ? "" : "s"}`,
      detail: `From the nightly FactSet consensus log: ${names.join(", ")}.`,
      suggestion: "Check whether the thesis already accounts for what the analysts are reacting to.",
      dedupeKey: `audit-analyst-trend-${today.slice(0, 7)}`,
      names,
    },
  ];
}
