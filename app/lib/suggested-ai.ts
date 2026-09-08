import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { canonicalTicker, crossListingRoot } from "./ticker";
import { loadRankedResearch } from "./research-ranked-server";
import type { RankedRow } from "./research-ranked";
import { getSectorLeadership, formatLeadershipForPrompt } from "./sector-leadership";
import { loadKillSignalSources, killSignalExtrasFor } from "./metric-resolver";
import { siaPercentileDrift } from "./sia-history";
import { loadStreetTakeaways, type StreetTakeawaysStore } from "./street-takeaways";
import { readEntryScan } from "./entry-scan";
import { fetchLivePriceSnapshot } from "./live-prices";
import { parseModelJson } from "./json-repair";
import { isCreditError, recordAnthropicCreditError, markAnthropicHealthy } from "./anthropic-status";

/**
 * AI-positioned Suggested — which names on the ranked Research list are WELL
 * POSITIONED given the market backdrop (funnel stage 2, the AI lens).
 *
 * NOT a factor model and not a score. One call per sector group: the model
 * sees the backdrop ONCE (regime composite, the brief's regime verdict and
 * bottom line, sector / industry leadership, Newton's and Lee's sector views)
 * and every candidate in that sector with its own reads (lists, technicals,
 * SIA / Equate / MarketEdge / Boosted, revisions, target upside, latest
 * FactSet flash, entry setup). It returns a tier per name — positioned /
 * neutral / against — with a one-line reason that must cite the backdrop.
 *
 * Anchored like the research synthesis: persisted with the brief date and
 * regime label; regenerated on demand (Suggested tab button) or by the nightly
 * job when older than STALE_DAYS. ~10 calls per run for a 150-name list.
 *
 * Redis:
 *   pm:suggested-ai          — the current view. Regenerable; safe to nuke.
 *   pm:suggested-ai-history  — append-only { [YYYY-MM-DD]: picks[] } with the
 *                              price at pick time, so the tier's hit rate can
 *                              be measured before it is allowed to gate. Today
 *                              only, never rewrites a prior day. BACKED UP.
 */

const log = createLogger("SuggestedAI");
const client = new Anthropic();

export const SUGGESTED_AI_KEY = "pm:suggested-ai";
export const SUGGESTED_AI_HISTORY_KEY = "pm:suggested-ai-history";
export const STALE_DAYS = 7;
const MAX_NAMES = 160;
const NAMES_PER_CALL = 16;
const MIN_SECTOR_GROUP = 4;

export type PositionTier = "positioned" | "neutral" | "against";

export type PositionedName = {
  tier: PositionTier;
  reason: string;
  sector: string;
  listCount: number;
};

export type SuggestedAiView = {
  generatedAt: string;
  regimeLabel: string | null;
  briefDate: string | null;
  briefVerdict: string | null;
  sectorBackdrops: Record<string, string>;
  names: Record<string, PositionedName>;
  calls: number;
  namesConsidered: number;
  error?: string;
};

type Pick = { ticker: string; tier: PositionTier; sector: string; listCount: number; price: number | null };

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await (await getRedis()).get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function readSuggestedAi(): Promise<SuggestedAiView | null> {
  const v = await readJson<SuggestedAiView | null>(SUGGESTED_AI_KEY, null);
  return v && v.names && typeof v.names === "object" ? v : null;
}

export function isSuggestedAiStale(v: SuggestedAiView | null, regimeLabel: string | null): boolean {
  if (!v) return true;
  if (Date.now() - Date.parse(v.generatedAt) > STALE_DAYS * 86_400_000) return true;
  if (regimeLabel && v.regimeLabel && regimeLabel !== v.regimeLabel) return true;
  return false;
}

type StockRow = {
  ticker?: string; name?: string; sector?: string; bucket?: string; price?: number; earningsDate?: string;
  healthData?: { currentPrice?: number; twoHundredDayAvg?: number; earningsDate?: string };
  technicals?: { dmaSignal?: string; rsi14?: number }; riskAlert?: { level?: string };
  sia?: number; marketEdge?: { opinion?: string; powerRating?: number }; boostedAi?: number; boostedAiConsensus?: string;
};
type Snap = Record<string, { factset?: { revUp?: number; revDown?: number; averageTarget?: number }; rbc?: { target?: number }; jpm?: { target?: number } }>;
type Brief = { date?: string; dateISO?: string; generatedAt?: string; marketRegime?: string; regimeVerdict?: string; bottomLine?: string };
type ResearchViews = { newtonSectors?: Array<{ sector: string; view: string }>; leeSectors?: Array<{ sector: string; view: string }>; leeFocusAreas?: Array<{ label: string }> };

const pct = (n: number | null | undefined, dp = 0) => (n == null || !Number.isFinite(n) ? null : `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`);

function nameLine(
  r: RankedRow,
  stock: StockRow | undefined,
  extras: ReturnType<typeof killSignalExtrasFor>,
  siaDrift: number | null,
  snap: Snap[string] | undefined,
  flash: string | null,
  setup: { met: number; known: number; ready: boolean } | undefined,
): string {
  const price = typeof stock?.price === "number" ? stock.price : stock?.healthData?.currentPrice ?? null;
  const ma = stock?.healthData?.twoHundredDayAvg ?? null;
  const vsMa = price != null && ma ? pct(((price - ma) / ma) * 100) : null;
  const fs = snap?.factset;
  const netRev = fs && (typeof fs.revUp === "number" || typeof fs.revDown === "number") ? (fs.revUp ?? 0) - (fs.revDown ?? 0) : null;
  const tgt = fs?.averageTarget ?? snap?.rbc?.target ?? snap?.jpm?.target ?? null;
  const upside = tgt != null && price ? pct(((tgt - price) / price) * 100) : null;
  const bits = [
    `lists ${r.listCount} (${r.lists.map((l) => l.short).join(", ")})${r.bearish.length ? ` · BEARISH on ${r.bearish.map((b) => b.short).join(", ")}` : ""}`,
    r.held ? `held: ${r.held}` : null,
    vsMa ? `${vsMa} vs 200d` : null,
    stock?.technicals?.dmaSignal ? stock.technicals.dmaSignal.replace(/_/g, " ") : null,
    stock?.riskAlert?.level ? `risk ${stock.riskAlert.level}` : null,
    extras.siaPercentile != null ? `SIA ${extras.siaPercentile}th pct${siaDrift != null ? ` (${siaDrift >= 0 ? "+" : ""}${siaDrift} 2w)` : ""}` : extras.siaSmax != null ? `SMAX ${extras.siaSmax}` : null,
    extras.equateRank != null ? `Equate rank ${extras.equateRank}` : null,
    extras.marketEdgeOpinion ? `MarketEdge ${extras.marketEdgeOpinion}${extras.marketEdgePower != null ? ` ${extras.marketEdgePower}` : ""}` : null,
    stock?.boostedAi != null ? `Boosted ${stock.boostedAi}${stock.boostedAiConsensus ? ` ${stock.boostedAiConsensus}` : ""}` : null,
    netRev != null ? `net revisions ${netRev >= 0 ? "+" : ""}${netRev}` : null,
    upside ? `target upside ${upside}` : null,
    stock?.earningsDate ?? stock?.healthData?.earningsDate ? `earnings ${(stock?.earningsDate ?? stock?.healthData?.earningsDate)!.slice(0, 10)}` : null,
    setup ? `entry setup ${setup.met}/${setup.known}${setup.ready ? " READY" : ""}` : null,
    flash ? `latest: ${flash}` : null,
  ].filter(Boolean);
  return `- ${r.ticker}${r.name ? ` (${r.name})` : ""}${r.sector ? ` [${r.sector}]` : ""}: ${bits.join(" · ")}`;
}

async function callTier(backdrop: string, sectorLabel: string, lines: string[]): Promise<{ backdrop: string; names: Array<{ ticker: string; tier: PositionTier; reason: string }> } | null> {
  const prompt = `You are a portfolio manager's research assistant. Given TODAY'S MARKET BACKDROP and a set of candidate stocks that the desk's research sources have nominated, decide which names are WELL POSITIONED to perform over the next one to three months given that backdrop. This is positioning, not valuation: the question is whether the tape, the sector, the regime and the name's own momentum reads line up for it now.

${backdrop}

CANDIDATES (${sectorLabel}):
${lines.join("\n")}

Answer in JSON only:
{
  "sectorBackdrop": "one or two sentences on how this sector/group sits in the current backdrop, citing the leadership numbers or regime facts above",
  "names": [ { "ticker": "<exactly as listed>", "tier": "positioned" | "neutral" | "against", "reason": "one line, ≤ 160 chars, MUST cite a backdrop fact or a read from the name's line (sector rank, regime, 200-day, SIA, revisions, flash)" } ]
}

Rules:
- Every candidate gets exactly one entry.
- "positioned" is selective: the sector or industry is leading or turning, the regime supports the style, AND the name's own reads (200-day, SIA/Equate/MarketEdge, revisions) agree. Roughly the top third at most; fewer in a Risk-Off backdrop for cyclicals and growth.
- "against": the backdrop argues AGAINST the name now (lagging sector in a Risk-Off tape, breaking the 200-day, revisions cutting, a bearish list nomination) even if the sources like it.
- Use ONLY the facts above. Do not invent figures or events.`;
  const resp = await client.messages.create({
    model: "claude-sonnet-5",
    thinking: { type: "disabled" },
    max_tokens: 1800,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const parsed = parseModelJson<{ sectorBackdrop?: unknown; names?: unknown }>(text);
  if (!parsed.ok) {
    log.warn(`${sectorLabel}: unparseable — ${parsed.error}`);
    return null;
  }
  const tiers = new Set<PositionTier>(["positioned", "neutral", "against"]);
  const names: Array<{ ticker: string; tier: PositionTier; reason: string }> = [];
  for (const n of Array.isArray(parsed.value.names) ? parsed.value.names : []) {
    const nn = n as { ticker?: unknown; tier?: unknown; reason?: unknown };
    if (typeof nn.ticker !== "string" || !tiers.has(nn.tier as PositionTier)) continue;
    names.push({ ticker: nn.ticker.trim().toUpperCase(), tier: nn.tier as PositionTier, reason: String(nn.reason ?? "").trim().slice(0, 200) });
  }
  return { backdrop: typeof parsed.value.sectorBackdrop === "string" ? parsed.value.sectorBackdrop.trim().slice(0, 400) : "", names };
}

/** Build the view. Writes pm:suggested-ai and appends today's picks to history. */
export async function buildSuggestedAi(): Promise<SuggestedAiView> {
  const redis = await getRedis();
  const [{ rows: ranked }, leadership, src, snaps, takeaways, entryScan, regime, brief, research] = await Promise.all([
    loadRankedResearch(),
    getSectorLeadership().catch(() => null),
    loadKillSignalSources(),
    readJson<Snap>("pm:analyst-snapshots", {}),
    loadStreetTakeaways().catch(() => ({}) as StreetTakeawaysStore),
    readEntryScan(),
    readJson<{ composite?: { label?: string; score?: number; total?: number } } | null>("pm:market-regime", null),
    readJson<Brief | null>("pm:brief", null),
    readJson<ResearchViews>("pm:research", {}),
  ]);
  const regimeLabel = regime?.composite?.label ?? null;
  const briefDate = brief?.dateISO?.slice(0, 10) || brief?.generatedAt?.slice(0, 10) || brief?.date?.slice(0, 10) || null;

  // Candidates: every ranked name the book doesn't already OWN (Watchlist
  // names stay in — they're still candidates), strongest confluence first.
  const candidates = ranked.filter((r) => r.held !== "Portfolio").slice(0, MAX_NAMES);
  const stockByRoot = new Map<string, StockRow>();
  for (const s of src.stocks as StockRow[]) if (s.ticker) stockByRoot.set(crossListingRoot(s.ticker).toUpperCase(), s);
  const setupByTicker = new Map((entryScan?.rows ?? []).map((r) => [r.ticker.toUpperCase(), { met: r.met, known: r.known, ready: r.ready }]));
  const windowStart = Date.now() - 14 * 86_400_000;

  const views = [
    research.newtonSectors?.length ? `Newton sector views — overweight: ${research.newtonSectors.filter((s) => s.view === "overweight").map((s) => s.sector).join(", ") || "none"}; underweight: ${research.newtonSectors.filter((s) => s.view === "underweight").map((s) => s.sector).join(", ") || "none"}` : null,
    research.leeSectors?.length ? `Tom Lee sector views — overweight: ${research.leeSectors.filter((s) => s.view === "overweight").map((s) => s.sector).join(", ") || "none"}; underweight: ${research.leeSectors.filter((s) => s.view === "underweight").map((s) => s.sector).join(", ") || "none"}` : null,
    research.leeFocusAreas?.length ? `Lee focus themes: ${research.leeFocusAreas.map((a) => a.label).join(", ")}` : null,
  ].filter(Boolean);
  const backdrop = [
    `=== MARKET BACKDROP (${new Date().toISOString().slice(0, 10)}) ===`,
    regimeLabel ? `Regime composite: ${regimeLabel}${regime?.composite?.score != null ? ` (${regime.composite.score}/${regime.composite.total} risk-on signals)` : ""}` : "Regime composite: unavailable",
    brief?.marketRegime || brief?.regimeVerdict ? `Morning brief (${briefDate ?? "n/a"}): regime ${brief.marketRegime ?? "n/a"}${brief.regimeVerdict ? ` — "${brief.regimeVerdict}"` : ""}` : null,
    brief?.bottomLine ? `Brief bottom line: ${brief.bottomLine}` : null,
    ...views,
    leadership ? formatLeadershipForPrompt(leadership) : "(sector leadership unavailable)",
  ].filter(Boolean).join("\n");

  // Group by sector; fold small sectors into a mixed batch.
  const bySector = new Map<string, RankedRow[]>();
  for (const r of candidates) {
    const key = r.sector || "Unclassified";
    bySector.set(key, [...(bySector.get(key) ?? []), r]);
  }
  const batches: Array<{ label: string; rows: RankedRow[] }> = [];
  const mixed: RankedRow[] = [];
  for (const [sector, rows] of bySector) {
    if (rows.length < MIN_SECTOR_GROUP) { mixed.push(...rows); continue; }
    for (let i = 0; i < rows.length; i += NAMES_PER_CALL) batches.push({ label: sector, rows: rows.slice(i, i + NAMES_PER_CALL) });
  }
  for (let i = 0; i < mixed.length; i += NAMES_PER_CALL) batches.push({ label: "Mixed sectors", rows: mixed.slice(i, i + NAMES_PER_CALL) });

  const names: Record<string, PositionedName> = {};
  const sectorBackdrops: Record<string, string> = {};
  let calls = 0;
  let error: string | undefined;
  for (const b of batches) {
    const lines = b.rows.map((r) => {
      const root = r.key.toUpperCase();
      const stock = stockByRoot.get(root);
      const extras = killSignalExtrasFor(r.ticker, [], src);
      const siaEntries = src.sia[r.ticker.toUpperCase()] ?? src.sia[root] ?? src.sia[`${root}.TO`];
      const drift = siaPercentileDrift(siaEntries, r.ticker, windowStart);
      const snap = snaps[r.ticker.toUpperCase()] ?? snaps[canonicalTicker(r.ticker)] ?? snaps[root];
      const tk = takeaways[r.ticker.toUpperCase()] ?? takeaways[root] ?? [];
      const latest = [...tk].sort((a, b2) => b2.date.localeCompare(a.date))[0];
      const flash = latest ? `${latest.date} ${latest.headline ?? latest.event ?? latest.kind}${latest.overview ? ` — ${latest.overview.slice(0, 120)}` : ""}` : null;
      return nameLine(r, stock, extras, drift ? Math.round(drift.delta) : null, snap, flash, setupByTicker.get(r.ticker.toUpperCase()));
    });
    try {
      const out = await callTier(backdrop, b.label, lines);
      calls++;
      if (!out) continue;
      if (out.backdrop && !sectorBackdrops[b.label]) sectorBackdrops[b.label] = out.backdrop;
      const byTicker = new Map(b.rows.map((r) => [r.ticker.toUpperCase(), r]));
      for (const n of out.names) {
        const r = byTicker.get(n.ticker) ?? b.rows.find((x) => crossListingRoot(x.ticker).toUpperCase() === crossListingRoot(n.ticker).toUpperCase());
        if (!r) continue;
        names[r.ticker.toUpperCase()] = { tier: n.tier, reason: n.reason, sector: r.sector, listCount: r.listCount };
      }
      await markAnthropicHealthy().catch(() => {});
    } catch (e) {
      calls++;
      if (isCreditError(e)) {
        await recordAnthropicCreditError(e instanceof Error ? e.message : String(e)).catch(() => {});
        error = "Anthropic credits exhausted — partial view";
        break;
      }
      log.warn(`${b.label} failed:`, e);
      error = e instanceof Error ? e.message : "call failed";
    }
  }

  const view: SuggestedAiView = {
    generatedAt: new Date().toISOString(),
    regimeLabel,
    briefDate,
    briefVerdict: brief?.regimeVerdict ?? null,
    sectorBackdrops,
    names,
    calls,
    namesConsidered: candidates.length,
    ...(error ? { error } : {}),
  };
  await redis.set(SUGGESTED_AI_KEY, JSON.stringify(view));

  // Append-only history: today's positioned picks with a price, so the tier
  // can be scored later. Never rewrites a prior day. Prices for positioned
  // names only (bounded Yahoo batch).
  try {
    const today = new Date().toISOString().slice(0, 10);
    const positioned = Object.entries(names).filter(([, v]) => v.tier === "positioned").map(([t]) => t).slice(0, 50);
    const prices = positioned.length ? (await fetchLivePriceSnapshot(positioned)).prices : {};
    const picks: Pick[] = Object.entries(names).map(([t, v]) => ({ ticker: t, tier: v.tier, sector: v.sector, listCount: v.listCount, price: prices[t] ?? null }));
    const hist = await readJson<Record<string, Pick[]>>(SUGGESTED_AI_HISTORY_KEY, {});
    if (!hist[today]) {
      const dates = Object.keys(hist).sort();
      while (dates.length >= 60) { const d = dates.shift(); if (d) delete hist[d]; }
      hist[today] = picks;
      await redis.set(SUGGESTED_AI_HISTORY_KEY, JSON.stringify(hist));
    }
  } catch (e) {
    log.warn("history append failed:", e);
  }
  return view;
}
