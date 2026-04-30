import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import type { ResearchState } from "@/app/lib/defaults";
import type { MorningBrief } from "@/app/lib/types";

/**
 * Cross-source research synthesis.
 *
 * Reads the five research sources on the Research page (Newton's
 * Upticks, Fundstrat Top Ideas, Fundstrat Bottom Ideas, RBC Canadian
 * Focus List, Seeking Alpha — Alpha Picks) plus the cached morning
 * brief, and asks Claude to identify the best buy targets — with
 * particular weight on tickers that show up in MULTIPLE sources
 * (cross-source overlap = stronger conviction).
 *
 * Cache pattern (mirrors upticks-scrape):
 *   1. Hash inputs: sorted ticker lists per source + key brief
 *      fields (regime, horizons, bottomLine, hedging stance).
 *   2. If hash matches the cached one → return cached synthesis.
 *      Refresh of unchanged inputs = $0.
 *   3. If hash differs (or force=true) → run Anthropic, parse,
 *      cache, return.
 *
 * Cache key: pm:research-synthesis-cache.
 *
 * The route also doubles as page-load: the frontend POSTs on mount
 * with the current research+brief; if the hash matches, the cached
 * result is returned with cached:true and zero token cost.
 */

const CACHE_KEY = "pm:research-synthesis-cache";
const client = new Anthropic();

// ── Output schema ───────────────────────────────────────────────────

export type SynthesisPick = {
  ticker: string;
  /** Human-readable source labels where this ticker was mentioned. */
  sources: string[];
  /** Number of sources mentioning the ticker (sources.length). Convenience for sorting. */
  sourceCount: number;
  /**
   * 2-4 sentences explaining why this ticker is a good buy now,
   * referencing the current regime + horizon views from the brief
   * and citing what each mentioning source highlighted.
   */
  thesis: string;
};

export type SynthesisResult = {
  /** 1-2 sentence overall view tying the synthesis to the regime/horizon read. */
  summary: string;
  /** Stocks mentioned in 2+ sources, ordered by sourceCount desc then by alphabetical ticker. */
  topPicks: SynthesisPick[];
  /**
   * Compelling single-source picks worth flagging — typically a strong
   * buy from one source where the regime/sector/setup aligns. Honor
   * roll, not the headline list.
   */
  honorableMentions: SynthesisPick[];
  /**
   * Names appearing in Fundstrat Bottom Ideas that also appear in the
   * portfolio's Watchlist or PIM models — a "consider exiting"
   * cross-reference. Optional; omitted if no overlap.
   */
  cautions?: string[];
  /** Brief regime label at time of generation (Risk-On / Neutral / Risk-Off). */
  regimeContext?: string;
};

type CachedSynthesis = {
  hash: string;
  result: SynthesisResult;
  generatedAt: string;
};

// ── Hashing ─────────────────────────────────────────────────────────

function hashInputs(research: ResearchState, brief: MorningBrief | null): string {
  // Build a canonical, order-independent projection so trivial
  // reorderings don't bust the cache.
  const projection = {
    upticks: [...research.newtonUpticks].map((u) => u.ticker.toUpperCase()).sort(),
    fundstratTop: [...research.fundstratTop].map((i) => i.ticker.toUpperCase()).sort(),
    fundstratBottom: [...research.fundstratBottom].map((i) => i.ticker.toUpperCase()).sort(),
    rbcFocus: [...(research.rbcCanadianFocus || [])].map((r) => r.ticker.toUpperCase()).sort(),
    alphaPicks: [...(research.alphaPicks || [])].map((i) => i.ticker.toUpperCase()).sort(),
    // Brief context — only the fields that drive the synthesis. Full
    // bottomLine + horizon views are included so any meaningful brief
    // change re-runs the synthesis.
    brief: brief
      ? {
          regime: brief.marketRegime ?? "",
          tactical: brief.tacticalView ?? "",
          cyclical: brief.cyclicalView ?? "",
          structural: brief.structuralView ?? "",
          bottomLine: brief.bottomLine ?? "",
          hedging: brief.hedgingAnalysis ?? "",
        }
      : null,
  };
  return createHash("md5").update(JSON.stringify(projection)).digest("hex");
}

async function getCached(hash: string): Promise<{ result: SynthesisResult; generatedAt: string } | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedSynthesis;
    return cached.hash === hash
      ? { result: cached.result, generatedAt: cached.generatedAt }
      : null;
  } catch {
    return null;
  }
}

async function saveCached(hash: string, result: SynthesisResult) {
  try {
    const redis = await getRedis();
    const payload: CachedSynthesis = {
      hash,
      result,
      generatedAt: new Date().toISOString(),
    };
    await redis.set(CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("[research-synthesis] cache write failed:", e);
  }
}

// ── Build the prompt context ────────────────────────────────────────

function buildContext(research: ResearchState, brief: MorningBrief | null): string {
  const lines: string[] = [];

  // --- Sources enumerated with the ticker lists ---
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
      lines.push(`  - ${p.ticker}${price}`);
    }
    lines.push(``);
  }

  // --- Sector views (Newton + Lee) ---
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

  // --- Brief context ---
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

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an institutional portfolio manager synthesizing equity research from multiple analyst sources for a PM running a balanced/growth book at a wealth management firm. Your job: identify the BEST buy targets across the sources, with particular weight on names that appear in MULTIPLE sources (cross-source overlap = stronger conviction).

CRITICAL RULES:
1. A ticker mentioned in 2+ sources is a "Top Pick" candidate. Order topPicks by sourceCount desc, then alphabetically.
2. NEVER include a ticker in topPicks if it appears in Source 3 (Fundstrat Bottom Ideas / names to avoid). If a ticker is in Bottom Ideas, that's an automatic disqualification — note the conflict in summary or cautions instead.
3. Single-source picks can be honorableMentions IF the regime/sector/setup strongly aligns with the brief. Be selective — 3-6 honorable mentions is plenty; not every single-source idea deserves a callout.
4. Each thesis MUST cite (a) which sources mentioned the ticker by name, and (b) why the current regime / horizon view supports the buy. Reference specific brief content (e.g. "the cyclical view calls out tech rotation, and AAPL is on Fundstrat Top + Alpha Picks").
5. If the brief is missing or empty, work purely from sources but note the limitation in summary.
6. Prefer concrete reasoning over generic ("strong fundamentals") — name the catalyst, the price level, the sector tailwind.
7. Use section labels EXACTLY as written in the source list (e.g. "Newton's Upticks", "Fundstrat Top Ideas", "RBC Canadian Focus List", "Alpha Picks") so the user knows where each ticker came from.

Respond ONLY with valid JSON matching this schema:
{
  "summary": "1-2 sentence overall synthesis tying picks to the regime/horizon read.",
  "topPicks": [
    {
      "ticker": "TICKER",
      "sources": ["Newton's Upticks", "Fundstrat Top Ideas"],
      "sourceCount": 2,
      "thesis": "2-4 sentences citing each source + why the regime supports the buy."
    }
  ],
  "honorableMentions": [
    {
      "ticker": "TICKER",
      "sources": ["Single Source Name"],
      "sourceCount": 1,
      "thesis": "2-3 sentences."
    }
  ],
  "cautions": ["Optional: notable bottom-ideas tickers, conflicts between sources, or regime mismatches worth flagging."],
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

async function runSynthesis(research: ResearchState, brief: MorningBrief | null): Promise<SynthesisResult | null> {
  const context = buildContext(research, brief);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: context }],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  console.log("[research-synthesis] raw output:", text.slice(0, 4000));
  return parseSynthesis(text);
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const research = body?.research as ResearchState | undefined;
    const brief = (body?.brief ?? null) as MorningBrief | null;
    const force = Boolean(body?.force);

    if (!research) {
      return NextResponse.json({ error: "research payload required" }, { status: 400 });
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

    const hash = hashInputs(research, brief);

    // Cache hit → zero Anthropic tokens spent.
    if (!force) {
      const cached = await getCached(hash);
      if (cached) {
        return NextResponse.json({
          result: cached.result,
          cached: true,
          generatedAt: cached.generatedAt,
          hash,
        });
      }
    }

    const result = await runSynthesis(research, brief);
    if (!result) {
      return NextResponse.json(
        { error: "Failed to parse synthesis from model" },
        { status: 500 }
      );
    }

    await saveCached(hash, result);
    return NextResponse.json({
      result,
      cached: false,
      generatedAt: new Date().toISOString(),
      hash,
    });
  } catch (e) {
    console.error("research-synthesis error:", e);
    return NextResponse.json({ error: "Failed to generate research synthesis" }, { status: 500 });
  }
}
