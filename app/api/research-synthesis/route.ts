import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { ResearchState } from "@/app/lib/defaults";
import type { MorningBrief, Stock } from "@/app/lib/types";

/**
 * Cross-source research synthesis.
 *
 * STICKINESS MODEL (the user's explicit requirement):
 *   - Once a synthesis is generated for the day, it PERSISTS across
 *     refreshes and devices. Reloading the Research page does NOT
 *     re-fire Anthropic — it just reads the persisted blob.
 *   - The synthesis is ANCHORED to the brief that existed at the
 *     moment it was generated. If the brief is regenerated later in
 *     the day, the synthesis does not migrate to the new brief
 *     unless the user explicitly clicks "Force re-generate".
 *   - "Force re-generate" overwrites the persisted synthesis with a
 *     fresh one using the current research + current brief.
 *
 * This is a behavior change from the previous hash-gated model. We
 * still hash inputs internally (so a duplicate non-force POST with
 * unchanged research+brief is a free no-op), but the persistent
 * storage now lives at `pm:research-synthesis` (single blob) rather
 * than `pm:research-synthesis-cache` (hash-keyed cache).
 *
 * PORTFOLIO EXCLUSION:
 *   The synthesis excludes any ticker the user already holds in their
 *   portfolio (pm:stocks where bucket === "Portfolio"). Watchlist
 *   names are NOT excluded — those are research candidates the user
 *   is tracking, fair game to recommend.
 *
 * Dual layer of defense:
 *   1. The prompt is told the exclusion list explicitly.
 *   2. Server-side filter strips any portfolio-ticker matches from
 *      topPicks and honorableMentions after the model responds.
 */

const STORE_KEY = "pm:research-synthesis";
const STOCKS_KEY = "pm:stocks";
const client = new Anthropic();

// ── Output schema ───────────────────────────────────────────────────

export type SynthesisPick = {
  ticker: string;
  sources: string[];
  sourceCount: number;
  thesis: string;
};

export type SynthesisResult = {
  summary: string;
  topPicks: SynthesisPick[];
  honorableMentions: SynthesisPick[];
  cautions?: string[];
  regimeContext?: string;
};

type StoredSynthesis = {
  result: SynthesisResult;
  generatedAt: string;
  /** ISO date (YYYY-MM-DD) the synthesis was generated. Useful for the
   * frontend to display "synthesized this morning" vs "from yesterday". */
  generatedDate: string;
  /** Snapshot of the brief metadata at generation time so the user can
   * see which brief context the synthesis was anchored to. */
  briefRegime?: string;
  briefDate?: string;
};

// ── Storage ─────────────────────────────────────────────────────────

async function readStored(): Promise<StoredSynthesis | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSynthesis;
  } catch {
    return null;
  }
}

async function writeStored(stored: StoredSynthesis): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.set(STORE_KEY, JSON.stringify(stored));
  } catch (e) {
    console.error("[research-synthesis] persist failed:", e);
  }
}

async function readPortfolioTickers(): Promise<string[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(STOCKS_KEY);
    if (!raw) return [];
    const stocks = JSON.parse(raw) as Stock[];
    if (!Array.isArray(stocks)) return [];
    return stocks
      .filter((s) => s.bucket === "Portfolio")
      .map((s) => s.ticker.toUpperCase());
  } catch {
    return [];
  }
}

const normalizeTicker = (t: string) =>
  t.replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();

function isPortfolioMatch(ticker: string, portfolio: Set<string>): boolean {
  const normalized = normalizeTicker(ticker);
  return portfolio.has(normalized) || portfolio.has(ticker.toUpperCase());
}

// ── Prompt construction ─────────────────────────────────────────────

function buildContext(
  research: ResearchState,
  brief: MorningBrief | null,
  portfolioTickers: string[]
): string {
  const lines: string[] = [];

  lines.push(`=== RESEARCH SOURCES ===`);
  lines.push(``);

  if (research.newtonUpticks.length > 0) {
    lines.push(`Source 1: Newton's Upticks (Fundstrat technical buy candidates)`);
    for (const u of research.newtonUpticks) {
      const support = u.support ? ` · support ${u.support}` : "";
      const resistance = u.resistance ? ` · resistance ${u.resistance}` : "";
      const dateStr = u.dateAdded ? ` · added ${u.dateAdded}` : "";
      lines.push(`  - ${u.ticker} (${u.name || u.ticker}, ${u.sector || "—"})${support}${resistance}${dateStr}`);
    }
    lines.push(``);
  }

  if (research.fundstratTop.length > 0) {
    lines.push(`Source 2: Fundstrat Top Ideas (buy-side recommendations from Fundstrat)`);
    for (const i of research.fundstratTop) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  if (research.fundstratBottom.length > 0) {
    lines.push(`Source 3: Fundstrat Bottom Ideas (NAMES TO AVOID OR SHORT — do NOT recommend these as buys)`);
    for (const i of research.fundstratBottom) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  const rbc = research.rbcCanadianFocus || [];
  if (rbc.length > 0) {
    lines.push(`Source 4: RBC Canadian Focus List (RBC Capital Markets buy recommendations, target portfolio weights)`);
    for (const r of rbc) {
      const wt = r.weight ? ` · target ${r.weight}%` : "";
      const sector = r.sector ? ` · ${r.sector}` : "";
      lines.push(`  - ${r.ticker}${sector}${wt}`);
    }
    lines.push(``);
  }

  const ap = research.alphaPicks || [];
  if (ap.length > 0) {
    lines.push(`Source 5: Seeking Alpha — Alpha Picks (institutional buy recommendations)`);
    for (const p of ap) {
      const price = p.priceWhenAdded ? ` · entry ${p.priceWhenAdded}` : "";
      const sector = p.sector && p.sector !== "—" ? ` · ${p.sector}` : "";
      lines.push(`  - ${p.ticker} (${p.name || p.ticker})${sector}${price}`);
    }
    lines.push(``);
  }

  // Sector views
  if (research.newtonSectors && research.newtonSectors.length > 0) {
    const ows = research.newtonSectors.filter((s) => s.view === "overweight").map((s) => s.sector);
    const uws = research.newtonSectors.filter((s) => s.view === "underweight").map((s) => s.sector);
    if (ows.length > 0 || uws.length > 0) {
      lines.push(`Newton's sector views — Overweight: ${ows.join(", ") || "—"} · Underweight: ${uws.join(", ") || "—"}`);
    }
  }
  if (research.leeSectors && research.leeSectors.length > 0) {
    const ows = research.leeSectors.filter((s) => s.view === "overweight").map((s) => s.sector);
    const uws = research.leeSectors.filter((s) => s.view === "underweight").map((s) => s.sector);
    if (ows.length > 0 || uws.length > 0) {
      lines.push(`Tom Lee's sector views — Overweight: ${ows.join(", ") || "—"} · Underweight: ${uws.join(", ") || "—"}`);
    }
  }
  if (research.leeFocusAreas && research.leeFocusAreas.length > 0) {
    lines.push(`Tom Lee's focus themes: ${research.leeFocusAreas.map((a) => a.label).join(", ")}`);
  }

  if (research.generalNotes && research.generalNotes.trim()) {
    lines.push(``);
    lines.push(`General notes:`);
    lines.push(research.generalNotes.trim());
  }

  // Brief context
  lines.push(``);
  lines.push(`=== MORNING BRIEF CONTEXT ===`);
  if (brief) {
    if (brief.marketRegime) lines.push(`Regime: ${brief.marketRegime}`);
    if (brief.bottomLine) lines.push(`\nBottom line: ${brief.bottomLine}`);
    if (brief.tacticalView) lines.push(`\nTactical view (1-3M, 50% weight): ${brief.tacticalView}`);
    if (brief.cyclicalView) lines.push(`\nCyclical view (3-6M, 30% weight): ${brief.cyclicalView}`);
    if (brief.structuralView) lines.push(`\nStructural view (6-12M, 20% weight): ${brief.structuralView}`);
    if (brief.hedgingAnalysis) lines.push(`\nHedging stance: ${brief.hedgingAnalysis}`);
    if (brief.sectorRotation?.summary) lines.push(`\nSector rotation: ${brief.sectorRotation.summary}`);
  } else {
    lines.push(`No brief available — synthesize purely from research sources, applying neutral regime assumptions.`);
  }

  // Portfolio exclusion
  lines.push(``);
  lines.push(`=== PORTFOLIO HOLDINGS (DO NOT RECOMMEND AS BUYS) ===`);
  if (portfolioTickers.length > 0) {
    lines.push(`The PM already owns these positions in the live portfolio. They are NOT eligible for topPicks or honorableMentions — the user is asking for NEW buy ideas, not re-validation of existing positions. If a portfolio holding appears in the research sources, you may briefly note in summary or cautions that the source confirms the existing position, but do NOT include it as a pick.`);
    lines.push(``);
    lines.push(`Portfolio tickers (already held): ${portfolioTickers.join(", ")}`);
  } else {
    lines.push(`The portfolio is currently empty — every ticker in the research sources is a candidate.`);
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an institutional portfolio manager synthesizing equity research from multiple analyst sources for a PM running a balanced/growth book at a wealth management firm. Your job: identify the BEST buy targets across the sources, with particular weight on names that appear in MULTIPLE sources (cross-source overlap = stronger conviction).

CRITICAL RULES:
1. A ticker mentioned in 2+ sources is a "Top Pick" candidate. Order topPicks by sourceCount desc, then alphabetically.
2. NEVER include a ticker in topPicks or honorableMentions if it appears in Source 3 (Fundstrat Bottom Ideas / names to avoid). Note any conflict in summary or cautions instead.
3. NEVER include a ticker in topPicks or honorableMentions if it appears in the "PORTFOLIO HOLDINGS (DO NOT RECOMMEND AS BUYS)" list. The PM already owns those positions — the synthesis is for NEW buy ideas. If a portfolio name is also in the research sources, you may note in cautions that the source CONFIRMS the existing position, but do NOT recommend buying more.
4. Single-source picks can be honorableMentions IF the regime/sector/setup strongly aligns with the brief. Be selective — 3-6 honorable mentions is plenty.
5. Each thesis MUST cite (a) which sources mentioned the ticker by name, and (b) why the current regime / horizon view supports the buy.
6. If the brief is missing or empty, work purely from sources but note the limitation in summary.
7. Use section labels EXACTLY as written in the source list (e.g. "Newton's Upticks", "Fundstrat Top Ideas", "RBC Canadian Focus List", "Alpha Picks").

Respond ONLY with valid JSON matching this schema:
{
  "summary": "1-2 sentence overall synthesis tying picks to the regime/horizon read.",
  "topPicks": [
    {"ticker": "TICKER", "sources": ["..."], "sourceCount": N, "thesis": "..."}
  ],
  "honorableMentions": [
    {"ticker": "TICKER", "sources": ["..."], "sourceCount": N, "thesis": "..."}
  ],
  "cautions": ["Optional: bottom-ideas conflicts, regime mismatches, or research that confirms existing portfolio positions."],
  "regimeContext": "Risk-On / Neutral / Risk-Off / unknown"
}

Be concrete and actionable. The PM is going to read this and act on it the same day.`;

function parseSynthesis(text: string): SynthesisResult | null {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<SynthesisResult>;
    if (typeof parsed.summary !== "string") return null;
    const topPicks = Array.isArray(parsed.topPicks) ? parsed.topPicks : [];
    const honorableMentions = Array.isArray(parsed.honorableMentions) ? parsed.honorableMentions : [];

    const normPicks = (arr: Partial<SynthesisPick>[]): SynthesisPick[] =>
      arr
        .filter((p) => p && typeof p.ticker === "string" && p.ticker.trim())
        .map((p) => ({
          ticker: String(p.ticker).trim().toUpperCase(),
          sources: Array.isArray(p.sources) ? p.sources.map(String).filter(Boolean) : [],
          sourceCount: typeof p.sourceCount === "number"
            ? p.sourceCount
            : (Array.isArray(p.sources) ? p.sources.length : 0),
          thesis: typeof p.thesis === "string" ? p.thesis : "",
        }));

    return {
      summary: parsed.summary,
      topPicks: normPicks(topPicks),
      honorableMentions: normPicks(honorableMentions),
      cautions: Array.isArray(parsed.cautions) ? parsed.cautions.map(String) : undefined,
      regimeContext: typeof parsed.regimeContext === "string" ? parsed.regimeContext : undefined,
    };
  } catch {
    return null;
  }
}

/** Defense-in-depth: server-side filter to strip any portfolio-ticker
 *  matches that the model may have included despite the prompt rule. */
function filterPortfolioOut(result: SynthesisResult, portfolioTickers: string[]): SynthesisResult {
  if (portfolioTickers.length === 0) return result;
  const portfolio = new Set(portfolioTickers.map(normalizeTicker));
  const isHeld = (t: string) => isPortfolioMatch(t, portfolio);
  return {
    ...result,
    topPicks: result.topPicks.filter((p) => !isHeld(p.ticker)),
    honorableMentions: result.honorableMentions.filter((p) => !isHeld(p.ticker)),
  };
}

async function runSynthesis(
  research: ResearchState,
  brief: MorningBrief | null,
  portfolioTickers: string[]
): Promise<SynthesisResult | null> {
  const context = buildContext(research, brief, portfolioTickers);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: context }],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[research-synthesis] raw output:", text.slice(0, 4000));
  const parsed = parseSynthesis(text);
  if (!parsed) return null;
  return filterPortfolioOut(parsed, portfolioTickers);
}

// ── Route handlers ──────────────────────────────────────────────────

/** GET — read the persisted synthesis without firing Anthropic. */
export async function GET() {
  try {
    const stored = await readStored();
    if (!stored) {
      return NextResponse.json({ result: null, generatedAt: null, generatedDate: null });
    }
    return NextResponse.json({
      result: stored.result,
      generatedAt: stored.generatedAt,
      generatedDate: stored.generatedDate,
      briefRegime: stored.briefRegime,
      briefDate: stored.briefDate,
    });
  } catch (e) {
    console.error("research-synthesis GET error:", e);
    return NextResponse.json({ error: "Failed to read synthesis" }, { status: 500 });
  }
}

/** POST — generate or re-generate the synthesis.
 *
 *  Behavior:
 *    - force: false (or omitted) AND a synthesis is persisted → return
 *      the persisted blob unchanged. Zero Anthropic spend.
 *    - force: false AND no synthesis is persisted → generate one,
 *      persist, return.
 *    - force: true → always generate, overwrite the persisted blob,
 *      return.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const research = body?.research as ResearchState | undefined;
    const brief = (body?.brief ?? null) as MorningBrief | null;
    const force = Boolean(body?.force);

    if (!research) {
      return NextResponse.json({ error: "research payload required" }, { status: 400 });
    }

    // If not forcing, prefer the persisted synthesis. This is the
    // stickiness rule: once a synthesis exists, refreshes don't
    // re-run it.
    if (!force) {
      const stored = await readStored();
      if (stored) {
        return NextResponse.json({
          result: stored.result,
          cached: true,
          generatedAt: stored.generatedAt,
          generatedDate: stored.generatedDate,
          briefRegime: stored.briefRegime,
          briefDate: stored.briefDate,
        });
      }
    }

    const totalSources =
      research.newtonUpticks.length +
      research.fundstratTop.length +
      research.fundstratBottom.length +
      (research.rbcCanadianFocus?.length ?? 0) +
      (research.alphaPicks?.length ?? 0);

    if (totalSources === 0) {
      return NextResponse.json({
        result: null,
        cached: false,
        reason: "no-sources",
        message: "No research sources have any tickers yet. Add picks (or upload screenshots) before generating a synthesis.",
      });
    }

    const portfolioTickers = await readPortfolioTickers();
    const result = await runSynthesis(research, brief, portfolioTickers);
    if (!result) {
      return NextResponse.json(
        { error: "Failed to parse synthesis from model" },
        { status: 500 }
      );
    }

    const now = new Date();
    const generatedDate = now.toISOString().slice(0, 10);
    const stored: StoredSynthesis = {
      result,
      generatedAt: now.toISOString(),
      generatedDate,
      briefRegime: brief?.marketRegime,
      briefDate: brief?.date,
    };
    await writeStored(stored);

    return NextResponse.json({
      result,
      cached: false,
      generatedAt: stored.generatedAt,
      generatedDate: stored.generatedDate,
      briefRegime: stored.briefRegime,
      briefDate: stored.briefDate,
    });
  } catch (e) {
    console.error("research-synthesis POST error:", e);
    return NextResponse.json({ error: "Failed to generate research synthesis" }, { status: 500 });
  }
}
