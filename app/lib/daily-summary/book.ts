/**
 * Book health, journal scorecard and funnel pulse — all READ-ONLY over
 * existing caches (pm:risk-analytics, pm:thesis-health, journal attribution,
 * entry scan, pm:stocks, pm:suggested-watchlist).
 */

import { getRedis } from "@/app/lib/redis";
import { readRiskAnalytics } from "@/app/lib/risk-analytics";
import { readThesisCache } from "@/app/lib/thesis-health-refresh";
import { readJournalAttribution, type AttributedDecision } from "@/app/lib/journal-attribution";
import { readEntryScan } from "@/app/lib/entry-scan";
import { SUGGESTED_STORE_KEY, type SuggestedStore } from "@/app/lib/suggested-watchlist";
import type { Stock } from "@/app/lib/types";

export type BookSection = {
  computedAt: string | null;
  weightedBeta: number | null;
  annVol: number | null;
  top5Weight: number | null; // 0..1
  hhi: number | null;
  topRisk: { ticker: string; name: string; weight: number; ctrPct: number | null; beta: number }[];
  sectors: { sector: string; weight: number; spWeight: number | null; activePct: number | null }[];
  betaScenario: { label: string; portfolioImpact: number } | null;
  thesis: { intact: number; eroding: number; broken: number; builtAt: string | null };
  holdings: number;
};

export type JournalSection = {
  computedAt: string | null;
  recent: AttributedDecision[];
  stats: { buys: { n: number; hits: number; avgRel3m: number | null }; trims: { n: number; hits: number; avgRel3m: number | null } } | null;
};

export type FunnelSection = {
  suggested: number;
  watchlist: number;
  portfolio: number;
  entryReady: number;
  entryBuilding: number;
  newlyReady: string[];
  scanBuiltAt: string | null;
};

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function buildBookSections(): Promise<{ book: BookSection; journal: JournalSection; funnel: FunnelSection }> {
  const [risk, thesis, journal, scan, stocksRaw, suggested] = await Promise.all([
    readRiskAnalytics().catch(() => null),
    readThesisCache().catch(() => null),
    readJournalAttribution().catch(() => null),
    readEntryScan().catch(() => null),
    readJson<Stock[] | { stocks?: Stock[] }>("pm:stocks"),
    readJson<SuggestedStore>(SUGGESTED_STORE_KEY),
  ]);
  const stocks: Stock[] = Array.isArray(stocksRaw) ? stocksRaw : stocksRaw?.stocks ?? [];

  const book: BookSection = {
    computedAt: risk?.computedAt ?? null,
    weightedBeta: risk ? parseFloat(risk.weightedBeta.toFixed(2)) : null,
    annVol: risk?.portfolioAnnVol == null ? null : parseFloat(risk.portfolioAnnVol.toFixed(1)),
    top5Weight: risk ? parseFloat(risk.top5Weight.toFixed(3)) : null,
    hhi: risk ? parseFloat(risk.hhi.toFixed(3)) : null,
    topRisk: (risk?.names ?? [])
      .filter((n) => n.ctrPct != null)
      .sort((a, b) => (b.ctrPct as number) - (a.ctrPct as number))
      .slice(0, 5)
      .map((n) => ({ ticker: n.ticker, name: n.name, weight: parseFloat((n.weight * 100).toFixed(1)), ctrPct: n.ctrPct == null ? null : parseFloat(n.ctrPct.toFixed(1)), beta: parseFloat(n.beta.toFixed(2)) })),
    sectors: (risk?.sectors ?? [])
      .map((s) => ({
        sector: s.sector,
        weight: parseFloat((s.weight * 100).toFixed(1)),
        spWeight: s.spWeight == null ? null : parseFloat((s.spWeight * 100).toFixed(1)),
        activePct: s.spWeight == null ? null : parseFloat(((s.weight - s.spWeight) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.weight - a.weight),
    betaScenario: risk?.betaScenario ?? null,
    thesis: {
      intact: thesis?.counts?.intact ?? 0,
      eroding: thesis?.counts?.eroding ?? 0,
      broken: thesis?.counts?.broken ?? 0,
      builtAt: thesis?.builtAt ?? null,
    },
    holdings: stocks.filter((s) => s.bucket === "Portfolio").length,
  };

  const journalSection: JournalSection = {
    computedAt: journal?.computedAt ?? null,
    recent: (journal?.rows ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6),
    stats: journal?.stats ?? null,
  };

  const cutoff = Date.now() - 21 * 86_400_000;
  const suggestedCount = Object.values(suggested?.entries ?? {}).filter((e) => e && Date.parse(e.lastSeenAt) >= cutoff).length;
  const rows = scan?.rows ?? [];
  const funnel: FunnelSection = {
    suggested: suggestedCount,
    watchlist: stocks.filter((s) => s.bucket === "Watchlist").length,
    portfolio: book.holdings,
    entryReady: rows.filter((r) => r.ready).length,
    entryBuilding: rows.filter((r) => !r.ready && r.strength === "building").length,
    newlyReady: scan ? rows.filter((r) => r.ready && r.readySince && r.readySince >= new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)).map((r) => r.ticker) : [],
    scanBuiltAt: scan?.builtAt ?? null,
  };

  return { book, journal: journalSection, funnel };
}
