/**
 * Synthesis screen — per-name AI base/bull/bear synthesis over a
 * deterministic evidence payload. This is the "front door" screen that
 * replaces score-as-gate for triaging watchlist names and monitoring
 * portfolio theses. Design notes: memory `synthesis-screen-idea`.
 *
 * Evidence payload (assembled server-side; the model may ONLY use this):
 *   - FactSet company snapshot (fundamentals/valuation) — factset-fundamentals
 *   - pm:analyst-snapshots (.rbc/.jpm targets + .factset consensus/revisions)
 *   - pm:analyst-reports extracted content (thesis/risks/catalysts/scenarios)
 *   - pm:street-takeaways (post-earnings roundups)
 *   - Research list mentions (tallyResearchMentions)
 *   - Price action / technicals (Yahoo daily closes, computed here)
 *   - Sector/subsector leadership (sector-leadership.ts)
 *   - Next earnings date (pm:stocks `earningsDate`, already Yahoo-sourced)
 *
 * Deliberately EXCLUDED (2026-08-26 decisions): the 41-pt score and the
 * factor model — the append-only history provides a clean A/B against them.
 *
 * Redis keys owned by this feature:
 *   - pm:synthesis-screen-cache — { [ticker]: SynthesisEntry }. Hash-gated
 *     cache of the latest synthesis per name. Matches the `-cache$` backup
 *     exclude; regenerable at the cost of one Anthropic call per name.
 *   - pm:synthesis-history — { [ticker]: SynthesisHistoryRow[] } append-only
 *     verdict log (one row per ticker per day, today-only writes, same
 *     invariant family as pm:portfolio-snapshots). BACKED UP — this is the
 *     evidence base for validating the screen's hit rate later.
 */

import { createHash } from "crypto";
import type { TickerSnapshot, ExtractedReport } from "./analyst-snapshots";
import type { StreetTakeaway } from "./street-takeaways";
import type { ResearchMentionsResult } from "./research-mentions";
import { formatStreetTakeawaysForPrompt } from "./street-takeaways";
import { sectorEtfFor, sectorRank, formatLeadershipForPrompt, type SectorLeadership } from "./sector-leadership";
import {
  WATCHLIST_VERDICTS,
  PORTFOLIO_VERDICTS,
  STALE_PRICE_MOVE_PCT,
  type SynthesisVerdict,
  type SynthesisBullet,
  type SynthesisResult,
  type SynthesisEntry,
  type StaleReason,
  type SynthesisPlain,
  type TargetLine,
} from "./synthesis-screen-display";

// Client-safe types + labels live in synthesis-screen-display.ts (this module
// pulls crypto + redis-backed imports and must stay server-only). Re-exported
// here so server code can import everything from one place.
export * from "./synthesis-screen-display";

export const SYNTHESIS_CACHE_KEY = "pm:synthesis-screen-cache";
export const SYNTHESIS_HISTORY_KEY = "pm:synthesis-history";

/** Bump to invalidate every cached synthesis when the prompt changes shape. */
export const SYNTHESIS_PROMPT_VERSION = "v2";

// ── Cheap-inputs hash ────────────────────────────────────────────────
// Computed from Redis-only inputs so the GET staleness pass never has to
// hit Yahoo/FactSet. Technicals and the FactSet snapshot deliberately ride
// along at generation time without gating the cache (prices move daily —
// hashing them would make every entry permanently "stale").

export function computeInputsHash(input: {
  snapshot?: TickerSnapshot;
  reports?: { rbc?: { extractedAt?: string; hash?: string }; jpm?: { extractedAt?: string; hash?: string }; morningstar?: { extractedAt?: string; hash?: string } };
  takeaways: Pick<StreetTakeaway, "date" | "event">[] | { date?: string; event?: string }[];
  mentionsFingerprint: string;
  earningsDate?: string;
}): string {
  const projection = {
    v: SYNTHESIS_PROMPT_VERSION,
    snapshot: input.snapshot ?? null,
    reports: {
      rbc: input.reports?.rbc ? { at: input.reports.rbc.extractedAt ?? null, h: input.reports.rbc.hash ?? null } : null,
      jpm: input.reports?.jpm ? { at: input.reports.jpm.extractedAt ?? null, h: input.reports.jpm.hash ?? null } : null,
      ms: input.reports?.morningstar
        ? { at: input.reports.morningstar.extractedAt ?? null, h: input.reports.morningstar.hash ?? null }
        : null,
    },
    takeaways: input.takeaways.map((t) => `${t.date ?? ""}|${t.event ?? ""}`).sort(),
    mentions: input.mentionsFingerprint,
    earnings: input.earningsDate ?? null,
  };
  return createHash("md5").update(stableStringify(projection)).digest("hex");
}

/** JSON.stringify with sorted object keys — order-independent hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ── Staleness ────────────────────────────────────────────────────────

export function evaluateStaleness(
  entry: SynthesisEntry | undefined,
  currentInputsHash: string,
  currentPrice: number | undefined,
  todayStr: string,
): StaleReason[] {
  if (!entry) return ["never-generated"];
  const reasons: StaleReason[] = [];
  if (entry.promptVersion !== SYNTHESIS_PROMPT_VERSION) reasons.push("prompt-version");
  if (entry.inputsHash !== currentInputsHash) reasons.push("inputs-changed");
  if (
    entry.priceAtGeneration != null &&
    currentPrice != null &&
    entry.priceAtGeneration > 0 &&
    Math.abs(currentPrice / entry.priceAtGeneration - 1) * 100 >= STALE_PRICE_MOVE_PCT
  ) {
    reasons.push("price-move");
  }
  // Earnings that were upcoming at generation time and have since passed.
  const ed = entry.earningsDateAtGeneration?.slice(0, 10);
  if (ed && ed >= entry.generatedAt.slice(0, 10) && ed < todayStr) reasons.push("earnings-passed");
  return reasons;
}

// ── Technicals (computed at generation time only) ────────────────────

export type Technicals = {
  last: number;
  r1wPct: number | null;
  r1mPct: number | null;
  r3mPct: number | null;
  r6mPct: number | null;
  offHigh52wPct: number | null;
  vs50dmaPct: number | null;
  vs200dmaPct: number | null;
};

export function computeTechnicalsFromCloses(closes: number[]): Technicals | null {
  const c = closes.filter((v) => typeof v === "number" && isFinite(v));
  if (c.length < 30) return null;
  const last = c[c.length - 1];
  const ret = (days: number): number | null => {
    if (c.length < days + 1) return null;
    const prior = c[c.length - 1 - days];
    return prior ? +(((last - prior) / prior) * 100).toFixed(2) : null;
  };
  const sma = (days: number): number | null => {
    if (c.length < days) return null;
    const slice = c.slice(-days);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };
  const high52 = Math.max(...c.slice(-252));
  const s50 = sma(50);
  const s200 = sma(200);
  return {
    last,
    r1wPct: ret(5),
    r1mPct: ret(21),
    r3mPct: ret(63),
    r6mPct: ret(126),
    offHigh52wPct: high52 > 0 ? +(((last - high52) / high52) * 100).toFixed(2) : null,
    vs50dmaPct: s50 ? +(((last - s50) / s50) * 100).toFixed(2) : null,
    vs200dmaPct: s200 ? +(((last - s200) / s200) * 100).toFixed(2) : null,
  };
}

const pct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

export function formatTechnicalsForPrompt(t: Technicals | null): string {
  if (!t) return "=== PRICE ACTION / TECHNICALS ===\nDATA GAP — insufficient price history.";
  return [
    "=== PRICE ACTION / TECHNICALS (Yahoo daily closes) ===",
    `Last: ${t.last.toFixed(2)}`,
    `Returns: 1W ${pct(t.r1wPct)} | 1M ${pct(t.r1mPct)} | 3M ${pct(t.r3mPct)} | 6M ${pct(t.r6mPct)}`,
    `Vs 52-week high: ${pct(t.offHigh52wPct)}`,
    `Vs 50-DMA: ${pct(t.vs50dmaPct)} | Vs 200-DMA: ${pct(t.vs200dmaPct)}`,
  ].join("\n");
}

// ── Deterministic target summary ─────────────────────────────────────
// Computed server-side from the analyst snapshot, never model-generated,
// so the displayed targets/upside are exact. Ordering reflects the PM's
// stated hierarchy: RBC/JPM first, street average as breadth check,
// Morningstar FVE last.

export function computeTargets(snapshot: TickerSnapshot | undefined, currentPrice: number | undefined): TargetLine[] {
  if (!snapshot) return [];
  const upside = (target: number): number | null =>
    currentPrice && currentPrice > 0 ? +(((target - currentPrice) / currentPrice) * 100).toFixed(1) : null;
  const out: TargetLine[] = [];
  if (snapshot.rbc?.target != null)
    out.push({ source: "RBC", target: snapshot.rbc.target, upsidePct: upside(snapshot.rbc.target), asOf: snapshot.rbc.asOf });
  if (snapshot.jpm?.target != null)
    out.push({ source: "JPM", target: snapshot.jpm.target, upsidePct: upside(snapshot.jpm.target), asOf: snapshot.jpm.asOf });
  if (snapshot.factset?.averageTarget != null)
    out.push({
      source: "Street avg",
      target: snapshot.factset.averageTarget,
      upsidePct: upside(snapshot.factset.averageTarget),
      asOf: snapshot.factset.asOf,
    });
  if (snapshot.morningstar?.fairValue != null)
    out.push({
      source: "Morningstar FVE",
      target: snapshot.morningstar.fairValue,
      upsidePct: upside(snapshot.morningstar.fairValue),
      asOf: snapshot.morningstar.asOf,
    });
  return out;
}

// ── Prompt assembly ──────────────────────────────────────────────────

function formatAnalystBlock(snapshot: TickerSnapshot | undefined, reports: { rbc?: ExtractedReport; jpm?: ExtractedReport; morningstar?: ExtractedReport } | undefined, currentPrice: number | undefined): string {
  const lines: string[] = ["=== ANALYST EVIDENCE (pm:analyst-snapshots + report extracts) ==="];
  const upside = (target?: number) =>
    target != null && currentPrice ? ` (${(((target - currentPrice) / currentPrice) * 100).toFixed(0)}% vs last)` : "";
  const entry = (name: string, e?: { rating?: string; target?: number; asOf?: string }) => {
    if (!e) return;
    lines.push(`${name}: ${e.rating ?? "no rating"}${e.target != null ? `, target ${e.target}${upside(e.target)}` : ""}${e.asOf ? `, as of ${e.asOf}` : ""}`);
  };
  entry("RBC", snapshot?.rbc);
  entry("JPM", snapshot?.jpm);
  const fs = snapshot?.factset;
  if (fs) {
    lines.push(
      `FactSet street consensus: avg target ${fs.averageTarget ?? "n/a"}${upside(fs.averageTarget)}, ${fs.analystCount ?? "?"} analysts, EPS FY+1 revisions last 30d: ${fs.revUp ?? 0} up / ${fs.revDown ?? 0} down${fs.asOf ? `, as of ${fs.asOf}` : ""}`,
    );
  }
  const ms = snapshot?.morningstar;
  if (ms) {
    lines.push(
      `Morningstar: ${ms.stars ?? "?"}★, moat ${ms.moat ?? "n/a"} (${ms.moatTrend ?? "n/a"}), uncertainty ${ms.uncertainty ?? "n/a"}${ms.fairValue != null ? `, FVE ${ms.fairValue}` : ""}${ms.asOf ? `, as of ${ms.asOf}` : ""}`,
    );
  }
  const reportBlock = (name: string, r?: ExtractedReport) => {
    if (!r) return;
    lines.push(`--- ${name} report extract${r.asOf ? ` (${r.asOf})` : ""} ---`);
    if (r.thesis?.length) lines.push(`Thesis: ${r.thesis.join(" | ")}`);
    if (r.risks?.length) lines.push(`Risks: ${r.risks.join(" | ")}`);
    if (r.valuationBasis) lines.push(`Valuation basis: ${r.valuationBasis}`);
    if (r.scenarios && (r.scenarios.bull != null || r.scenarios.bear != null))
      lines.push(`Analyst scenarios: bull ${r.scenarios.bull ?? "n/a"} / base ${r.scenarios.base ?? "n/a"} / bear ${r.scenarios.bear ?? "n/a"}`);
    if (r.catalysts?.length)
      lines.push(`Report catalysts: ${r.catalysts.map((cat) => `${cat.date ?? "undated"}: ${cat.event}`).join(" | ")}`);
  };
  reportBlock("RBC", reports?.rbc);
  reportBlock("JPM", reports?.jpm);
  reportBlock("Morningstar", reports?.morningstar);
  if (lines.length === 1) lines.push("DATA GAP — no analyst coverage on file.");
  return lines.join("\n");
}

function formatMentionsBlock(mentions: ResearchMentionsResult | null): string {
  if (!mentions || mentions.mentions.length === 0)
    return "=== RESEARCH LIST MEMBERSHIP ===\nNot currently on any tracked research list (neutral — absence is not a negative).";
  return [
    "=== RESEARCH LIST MEMBERSHIP (tracked source lists) ===",
    ...mentions.mentions.map((m) => `${m.label}: ${m.direction}`),
  ].join("\n");
}

export type SynthesisPayload = {
  ticker: string;
  name: string;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  currentPrice?: number;
  earningsDate?: string;
  factsetBlock: string; // formatSnapshotForPrompt output or DATA GAP line
  snapshot?: TickerSnapshot;
  reports?: { rbc?: ExtractedReport; jpm?: ExtractedReport; morningstar?: ExtractedReport };
  takeaways: StreetTakeaway[];
  mentions: ResearchMentionsResult | null;
  technicals: Technicals | null;
  leadership: SectorLeadership;
};

export function buildSynthesisPrompt(p: SynthesisPayload): { system: string; user: string } {
  const isPortfolio = p.bucket === "Portfolio";
  const verdicts = isPortfolio ? PORTFOLIO_VERDICTS : WATCHLIST_VERDICTS;
  const verdictGuide = isPortfolio
    ? `- "thesis-intact": the evidence still supports owning the name; no action needed.
- "review": something material has shifted (estimates, price action, analyst view) — the position deserves a formal look.
- "exit-watch": the weight of evidence has turned against the holding; put it on a decision clock.`
    : `- "advance": evidence supports moving this name into active work (underwrite / deeper diligence).
- "watch": interesting but unresolved — name the missing piece in keyDebate.
- "pass": the evidence does not support spending more time now.`;

  const etf = sectorEtfFor(p.sector);
  const rank = etf ? sectorRank(p.leadership, etf) : null;
  const sectorLine = etf && rank
    ? `This name's sector (${p.sector}, ${etf}) currently ranks #${rank.rank} of ${rank.of} sectors by 3M return.`
    : `Sector: ${p.sector || "unknown"} (no ETF mapping — treat sector standing as a DATA GAP).`;

  const system = `You are an institutional buy-side analyst producing a disciplined, evidence-bound synthesis of one ${isPortfolio ? "portfolio holding" : "watchlist candidate"} for a portfolio manager's screening view.

STRICT EVIDENCE RULES:
1. Use ONLY the data blocks provided in the user message${p ? "" : ""}. Never use general knowledge about the company, its products, or its history that is not in the blocks. If web search is available, you may use it ONLY to fill a gap the blocks explicitly lack, citing reputable financial sources (exchange filings, major financial press); mark any web-sourced bullet with source "web".
2. Where an important input is missing, list it in "dataGaps" — do not guess or fill from memory.
3. Every bullet must cite its supporting block in "source" (one of: "factset", "rbc report", "jpm report", "morningstar", "consensus", "revisions", "street takeaways", "research lists", "technicals", "sector leadership", "earnings", "web").
4. The BEAR case must be built from actual negatives present in the data (downward revisions, target cuts, bearish list mentions, deteriorating technicals, analyst-stated risks, lagging sector). If the data contains no genuine negatives, say so in one bullet rather than inventing generic risks.
5. Be direct and specific — numbers over adjectives. No hedging boilerplate.
6. Price-target hierarchy: the RBC and JPM report targets are the PRIMARY anchors; the FactSet street average is a breadth/consensus check on them; the Morningstar FVE carries the least weight. When citing a target range, anchor it on RBC/JPM.
7. "priceAction" is the ONLY place for price/sector/subsector movement commentary. "keyDebate" must be the fundamental question (demand, competition, margins, valuation vs growth) — do not restate price action there.

OUTPUT: respond with ONLY a JSON object, no markdown fences:
{
  "verdict": one of ${JSON.stringify([...verdicts])},
  "verdictReason": "one sentence",
  "skew": integer -2..2 (risk/reward asymmetry: +2 strongly bull-skewed, 0 balanced, -2 strongly bear-skewed),
  "base": [{"text": "...", "source": "..."}] (2-3 bullets — the most likely path),
  "bull": [{"text": "...", "source": "..."}] (2-3 bullets),
  "bear": [{"text": "...", "source": "..."}] (2-3 bullets),
  "plain": {"base": "...", "bull": "...", "bear": "..."} (REQUIRED — one sentence each, plain English a non-specialist gets in 10 seconds: no tickers-as-shorthand, no jargon like "revisions" or "multiple re-rating", just what would happen and why it matters),
  "priceAction": "1-2 sentences: what the stock itself has done recently AND how its sector/subsector are trading (leading or lagging), from the technicals and sector-leadership blocks",
  "nextStep": "ONE concrete action consistent with the verdict (e.g. 'Underwrite now; pressure-test hyperscaler capex assumptions at the Oct earnings', 'Revisit after the Q3 print', 'Trim review: confirm whether the estimate cuts extend to FY+2') — an instruction, not an observation",
  "keyDebate": "the single FUNDAMENTAL question that decides this name",
  "catalysts": [{"date": "YYYY-MM-DD or period", "event": "..."}] (from the data only; [] if none),
  "wouldChangeCall": ["observable development that would flip the verdict", ...] (REQUIRED, 1-3 items — never empty; there is always at least one observable that would flip the call),
  "dataGaps": ["missing input", ...] ([] if none)
}

Verdict guide:
${verdictGuide}`;

  const user = [
    `NAME: ${p.name} (${p.ticker}) — ${p.bucket}`,
    `Current price: ${p.currentPrice ?? "DATA GAP"}`,
    p.earningsDate ? `Next earnings: ${p.earningsDate.slice(0, 10)}` : "Next earnings: DATA GAP",
    "",
    p.factsetBlock,
    "",
    formatAnalystBlock(p.snapshot, p.reports, p.currentPrice),
    "",
    p.takeaways.length
      ? formatStreetTakeawaysForPrompt(p.takeaways)
      : "=== STREET TAKEAWAYS ===\nNone on file (no post-earnings roundup ingested).",
    "",
    formatMentionsBlock(p.mentions),
    "",
    formatTechnicalsForPrompt(p.technicals),
    "",
    formatLeadershipForPrompt(p.leadership),
    sectorLine,
  ].join("\n");

  return { system, user };
}

// ── Result validation ────────────────────────────────────────────────

export function normalizeSynthesisResult(raw: unknown, bucket: "Portfolio" | "Watchlist"): SynthesisResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const allowed: readonly string[] = bucket === "Portfolio" ? PORTFOLIO_VERDICTS : WATCHLIST_VERDICTS;
  let verdict = String(r.verdict ?? "").toLowerCase().trim();
  if (!allowed.includes(verdict)) {
    // Coerce cross-bucket slips ("watch" for a holding etc.) to the middle option.
    verdict = allowed[1];
  }
  const bullets = (v: unknown): SynthesisBullet[] =>
    Array.isArray(v)
      ? v
          .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
          .map((b) => ({ text: String(b.text ?? ""), source: String(b.source ?? "unspecified") }))
          .filter((b) => b.text.length > 0)
          .slice(0, 4)
      : [];
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => String(s)).filter(Boolean).slice(0, 4) : [];
  const skewNum = Number(r.skew);
  const base = bullets(r.base);
  if (base.length === 0) return null;
  const plainRaw = r.plain && typeof r.plain === "object" ? (r.plain as Record<string, unknown>) : null;
  const plain: SynthesisPlain | undefined = plainRaw
    ? { base: String(plainRaw.base ?? ""), bull: String(plainRaw.bull ?? ""), bear: String(plainRaw.bear ?? "") }
    : undefined;
  return {
    verdict: verdict as SynthesisVerdict,
    verdictReason: String(r.verdictReason ?? ""),
    skew: isFinite(skewNum) ? Math.max(-2, Math.min(2, Math.round(skewNum))) : 0,
    base,
    bull: bullets(r.bull),
    bear: bullets(r.bear),
    plain,
    priceAction: r.priceAction != null ? String(r.priceAction) : undefined,
    nextStep: r.nextStep != null ? String(r.nextStep) : undefined,
    keyDebate: String(r.keyDebate ?? ""),
    catalysts: Array.isArray(r.catalysts)
      ? r.catalysts
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({ date: c.date != null ? String(c.date) : undefined, event: String(c.event ?? "") }))
          .filter((c) => c.event.length > 0)
          .slice(0, 5)
      : [],
    wouldChangeCall: strings(r.wouldChangeCall),
    dataGaps: strings(r.dataGaps),
  };
}
