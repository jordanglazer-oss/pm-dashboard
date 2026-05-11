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

/**
 * RegimeFit captures the model's OPINION on whether the current
 * environment favors the name. Kept strictly separate from `thesis`
 * (which is grounded in what the source analysts say) so the user can
 * tell at a glance which part is research overlap and which is the
 * model's opinionated read.
 *
 *   high     — regime tilts strongly favor this name; conviction add.
 *   medium   — regime is neutral or mixed but doesn't argue against it.
 *   low      — regime is unsupportive but the source signal is strong
 *              enough to keep on the radar.
 *   contrary — regime actively argues AGAINST this name; surface the
 *              conflict in the rating so the PM sees the disagreement.
 */
export type RegimeFitRating = "high" | "medium" | "low" | "contrary";

export type SynthesisPick = {
  ticker: string;
  sources: string[];
  sourceCount: number;
  /** What the SOURCES say — research overlap, technical setups,
   *  analyst ratings, target weights. Sticks to the data; not opinion. */
  thesis: string;
  /** OPINIONATED regime-fit rating + 1-line justification grounded in
   *  the brief's tilts. Separate from `thesis` so the line between
   *  research and model opinion is always visible. */
  regimeFit?: RegimeFitRating;
  regimeFitRationale?: string;
};

export type SynthesisResult = {
  summary: string;
  /** Distilled tilts the model derived from the brief — 2-4 short
   *  bullets the PM can use as a lens for the picks below. Surfaced
   *  prominently so the user sees WHY certain names get promoted. */
  regimeTilts?: string[];
  /** Cross-source picks (ticker in 2+ sources). Primary recommendation
   *  set, sorted by sourceCount desc. Each pick still gets a regimeFit
   *  rating so the user can spot multi-source names that the regime
   *  doesn't actually favor. */
  topPicks: SynthesisPick[];
  /** Single-source picks where regimeFit is "high" — names the model
   *  thinks are well-positioned for the current environment even
   *  though only one analyst flagged them. Replaces the looser
   *  "honorableMentions" leftovers bucket. */
  regimeAlignedHighlights: SynthesisPick[];
  /** Remaining single-source mentions worth tracking but not strongly
   *  regime-favored. Lower priority than regimeAlignedHighlights. */
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
    lines.push(`Source 2: Fundstrat Large-Cap Top Ideas (buy-side recommendations from Fundstrat on large-cap names)`);
    for (const i of research.fundstratTop) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  if (research.fundstratBottom.length > 0) {
    lines.push(`Source 3: Fundstrat Large-Cap Bottom Ideas (NAMES TO AVOID OR SHORT — do NOT recommend these as buys)`);
    for (const i of research.fundstratBottom) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  const smidTop = research.fundstratSmidTop || [];
  if (smidTop.length > 0) {
    lines.push(`Source 4: Fundstrat Top SMID-Cap Core Ideas (buy-side recommendations from Fundstrat on small/mid-cap names — same posture as Large-Cap Top: positive)`);
    for (const i of smidTop) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  const smidBottom = research.fundstratSmidBottom || [];
  if (smidBottom.length > 0) {
    lines.push(`Source 5: Fundstrat Bottom SMID-Cap Core Ideas (NAMES TO AVOID OR SHORT on small/mid-cap names — same posture as Large-Cap Bottom: negative; do NOT recommend these as buys)`);
    for (const i of smidBottom) {
      const price = i.priceWhenAdded ? ` · entry ${i.priceWhenAdded}` : "";
      lines.push(`  - ${i.ticker}${price}`);
    }
    lines.push(``);
  }

  const rbc = research.rbcCanadianFocus || [];
  if (rbc.length > 0) {
    lines.push(`Source 6: RBC Canadian Focus List (RBC Capital Markets Canadian equity buy recommendations, target portfolio weights)`);
    for (const r of rbc) {
      const wt = r.weight ? ` · target ${r.weight}%` : "";
      const sector = r.sector ? ` · ${r.sector}` : "";
      lines.push(`  - ${r.ticker}${sector}${wt}`);
    }
    lines.push(``);
  }

  const rbcUs = research.rbcUsFocus || [];
  if (rbcUs.length > 0) {
    lines.push(`Source 7: RBC US Focus List (RBC Capital Markets US equity buy recommendations, target portfolio weights)`);
    for (const r of rbcUs) {
      const wt = r.weight ? ` · target ${r.weight}%` : "";
      const sector = r.sector ? ` · ${r.sector}` : "";
      lines.push(`  - ${r.ticker}${sector}${wt}`);
    }
    lines.push(``);
  }

  const ap = research.alphaPicks || [];
  if (ap.length > 0) {
    lines.push(`Source 8: Seeking Alpha — Alpha Picks (institutional buy recommendations)`);
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

  // generalNotes intentionally omitted — section removed from the UI;
  // any legacy notes in older blobs are not surfaced to the synthesis.

  // Brief context — passed in detail because the synthesis is supposed
  // to be opinionated about regime fit, not just a research overlap
  // tabulation. The wider the brief context, the better the model can
  // distill specific tilts (sector / market-cap / factor / defensive vs
  // cyclical) and rank candidates against them.
  lines.push(``);
  lines.push(`=== MORNING BRIEF CONTEXT ===`);
  if (brief) {
    if (brief.marketRegime) lines.push(`Regime: ${brief.marketRegime}`);
    if (brief.bottomLine) lines.push(`\nBottom line: ${brief.bottomLine}`);
    if (brief.tacticalView) lines.push(`\nTactical view (1-3M, 50% weight): ${brief.tacticalView}`);
    if (brief.cyclicalView) lines.push(`\nCyclical view (3-6M, 30% weight): ${brief.cyclicalView}`);
    if (brief.structuralView) lines.push(`\nStructural view (6-12M, 20% weight): ${brief.structuralView}`);
    if (brief.compositeAnalysis) lines.push(`\nComposite read: ${brief.compositeAnalysis}`);
    if (brief.creditAnalysis) lines.push(`\nCredit: ${brief.creditAnalysis}`);
    if (brief.volatilityAnalysis) lines.push(`\nVolatility: ${brief.volatilityAnalysis}`);
    if (brief.breadthAnalysis) lines.push(`\nBreadth: ${brief.breadthAnalysis}`);
    if (brief.contrarianAnalysis) lines.push(`\nContrarian read: ${brief.contrarianAnalysis}`);
    if (brief.hedgingAnalysis) lines.push(`\nHedging stance: ${brief.hedgingAnalysis}`);
    if (brief.sectorRotation?.summary) lines.push(`\nSector rotation: ${brief.sectorRotation.summary}`);
    if (brief.sectorRotation?.leading?.length) {
      lines.push(`Leading sectors: ${brief.sectorRotation.leading.join(" | ")}`);
    }
    if (brief.sectorRotation?.lagging?.length) {
      lines.push(`Lagging sectors: ${brief.sectorRotation.lagging.join(" | ")}`);
    }
    if (brief.sectorRotation?.pmImplication) {
      lines.push(`PM implication: ${brief.sectorRotation.pmImplication}`);
    }
  } else {
    lines.push(`No brief available — synthesize purely from research sources, applying neutral regime assumptions.`);
  }

  // Portfolio exclusion
  lines.push(``);
  lines.push(`=== PORTFOLIO HOLDINGS (DO NOT RECOMMEND AS BUYS) ===`);
  if (portfolioTickers.length > 0) {
    lines.push(`The PM already owns these positions in the live portfolio. They are NOT eligible for topPicks or honorableMentions — the user is asking for NEW buy ideas, not re-validation of existing positions. SILENTLY EXCLUDE portfolio holdings from your output. Do not call them out in cautions, summary, or anywhere else — the PM does not need to be reminded of what they hold.`);
    lines.push(``);
    lines.push(`Portfolio tickers (already held): ${portfolioTickers.join(", ")}`);
  } else {
    lines.push(`The portfolio is currently empty — every ticker in the research sources is a candidate.`);
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an institutional portfolio manager synthesizing equity research from multiple analyst sources for a PM running a balanced/growth book at a wealth management firm. Your job has TWO parts:
  (A) RESEARCH: identify which names show up across multiple sources — cross-source overlap is the strongest conviction signal and these are always the primary picks.
  (B) FORWARD-LOOKING OPINION: form an opinionated view on which names will PERFORM WELL OVER THE NEXT 1-12 MONTHS, using the brief's forward-looking horizon reads (tactical 1-3M, cyclical 3-6M, structural 6-12M) plus breadth / credit / volatility / contrarian / hedging / sector rotation context. This is NOT a recap of what's already happened — it's a forward thesis about what positioning benefits over the brief's horizon windows. Apply this opinion to BOTH multi-source and single-source candidates.

The PM relies on the synthesis as their main funnel of new buy ideas. Make the line between (A) what the SOURCES say and (B) what YOU think will work going forward visibly distinct in the output.

STEP 1 — DISTILL FORWARD-LOOKING REGIME TILTS FROM THE BRIEF (output as regimeTilts):
  - Read the brief's tactical (1-3M, 50% weight), cyclical (3-6M, 30% weight), and structural (6-12M, 20% weight) horizon views, plus breadth, credit, volatility, contrarian, hedging stance, and sector rotation.
  - Distill 2-4 specific FORWARD-LOOKING tilts — what positioning will benefit over the brief's horizon windows, NOT a description of what already happened or what's currently leading. The brief itself is forward-looking; inherit that lens.
  - Tilts should be predictive ("favor X over the next N months because Y") not descriptive ("X has been outperforming"). Examples:
      "Tactical 1-3M: lean into large-cap momentum / AI infra as breadth narrows; cautious on small-caps until A/D confirms."
      "Cyclical 3-6M: ISM crossover signals capex acceleration → favor industrials and semicap names that benefit from the recovery."
      "Structural 6-12M: SPX 10-MA still constructive → quality compounders with durable cash flow remain the long-term core; avoid leverage."
  - Tilts should mention specifics: sectors, market-cap bias, factor/style (growth vs value, momentum vs defensive, quality vs junk), geography (US vs Canadian), and which horizon drove the tilt.
  - These tilts become the lens for ranking every candidate. They're a thesis about the FORWARD environment, not the trailing one.

STEP 2 — RANK CANDIDATES (overlap × regime-fit):
  - sourceCount is the PRIMARY sort. Names in 2+ sources are always topPicks regardless of regime fit.
  - regimeFit is a SECONDARY lens used to:
      (a) break ties among multi-source picks (high regime-fit ranks above medium/low)
      (b) promote single-source picks to "regimeAlignedHighlights" when fit is "high"
      (c) flag multi-source picks that the regime doesn't actually support — keep them as topPicks but mark regimeFit "low" or "contrary" so the PM sees the disagreement
  - regimeFit values (read FORWARD over the brief's horizons, not trailing):
      high     — tilts strongly suggest the name will benefit going forward; conviction add.
      medium   — forward outlook is neutral or mixed; doesn't argue against it.
      low      — forward outlook is unsupportive; source signal carries the call alone.
      contrary — forward outlook actively argues AGAINST it; flag the conflict.
  - regimeFitRationale is ONE short sentence (≤25 words) tying the rating to a specific FORWARD tilt. The rationale MUST conclude with a forward claim — what will benefit this name over the relevant horizon — but trailing context is fair to cite as supporting evidence (e.g., "leadership continuation thesis: name has led on breadth and earnings revisions, both consistent with tactical tilt"). What's NOT allowed: pure description that stops at the trailing observation without a forward claim ("XLK has outperformed YTD" — no forward conclusion → reject). The test: does the rationale say something about WHY the name benefits GOING FORWARD?

STEP 3 — SEPARATE RESEARCH FROM OPINION IN THE OUTPUT:
  - thesis = WHAT THE SOURCES SAY: list which sources mentioned the ticker, what they say (ratings, target weights, technical levels, entry prices), any setup specifics. Do not editorialize regime fit here.
  - regimeFit + regimeFitRationale = THE MODEL'S OPINION on regime alignment. This is where your view goes.

CRITICAL RULES:
1. topPicks = every ticker in 2+ sources, sorted by sourceCount desc, ties broken by regimeFit (high → medium → low → contrary), then alphabetically. Multi-source picks ALWAYS appear here — never demote a multi-source pick to a lower tier just because regime fit is poor; instead mark regimeFit accordingly.
2. regimeAlignedHighlights = single-source picks where regimeFit is "high". Cap at 4-6 entries; only the strongest regime alignment makes it. Each one needs a regimeFitRationale that's specific (cites a tilt and ties to the name's profile).
3. honorableMentions = remaining single-source mentions worth tracking but not strongly regime-favored. Cap at 3-5 entries; skip noise.
4. NEVER include a ticker in topPicks, regimeAlignedHighlights, or honorableMentions if it appears in Source 3 (Fundstrat Large-Cap Bottom Ideas) OR Source 5 (Fundstrat Bottom SMID-Cap Core Ideas). Both bottom lists carry NEGATIVE posture — names to avoid or short. Treat them identically as exclusions. Note any conflict in cautions instead.
5. NEVER include a ticker in any pick tier if it appears in the "PORTFOLIO HOLDINGS (DO NOT RECOMMEND AS BUYS)" list. SILENTLY EXCLUDE — do NOT add "PORTFOLIO CONFIRMATION" / "source confirms the existing position" notes anywhere. The PM already knows what they hold.
6. cautions array is for genuinely actionable warnings ONLY (bottom-ideas conflicts, regime mismatches that aren't already captured by regimeFit:contrary on a pick, single-source quality concerns). Never use it for portfolio confirmations.
7. Use section labels EXACTLY as written in the source list (e.g. "Newton's Upticks", "Fundstrat Top Ideas", "RBC Canadian Focus List", "Alpha Picks").
8. If the brief is missing or empty: regimeTilts should be a single bullet "No brief context — regime fit unknown"; every regimeFit defaults to "medium" with rationale "no brief context"; regimeAlignedHighlights stays empty; surface the limitation in summary.

Respond ONLY with valid JSON matching this schema:
{
  "summary": "1-2 sentence overall synthesis tying picks to the regime/horizon read.",
  "regimeTilts": ["Tilt 1 (specific: sector, market-cap, factor)", "Tilt 2", "..."],
  "topPicks": [
    {"ticker": "TICKER", "sources": ["..."], "sourceCount": N, "thesis": "what the sources say", "regimeFit": "high|medium|low|contrary", "regimeFitRationale": "≤25 words tying rating to a specific tilt"}
  ],
  "regimeAlignedHighlights": [
    {"ticker": "TICKER", "sources": ["..."], "sourceCount": 1, "thesis": "what the single source says", "regimeFit": "high", "regimeFitRationale": "≤25 words tying rating to a specific tilt"}
  ],
  "honorableMentions": [
    {"ticker": "TICKER", "sources": ["..."], "sourceCount": 1, "thesis": "what the single source says", "regimeFit": "medium|low", "regimeFitRationale": "≤25 words"}
  ],
  "cautions": ["Optional: bottom-ideas conflicts, single-source quality concerns. NOT for portfolio confirmations."],
  "regimeContext": "Risk-On / Neutral / Risk-Off / unknown"
}

Be concrete and actionable. The PM reads this and acts on it the same day.`;

function parseSynthesis(text: string): SynthesisResult | null {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<SynthesisResult>;
    if (typeof parsed.summary !== "string") return null;

    const validRatings: ReadonlySet<string> = new Set(["high", "medium", "low", "contrary"]);
    const normPicks = (arr: Partial<SynthesisPick>[]): SynthesisPick[] =>
      arr
        .filter((p) => p && typeof p.ticker === "string" && p.ticker.trim())
        .map((p) => {
          const rawFit = typeof p.regimeFit === "string" ? p.regimeFit.toLowerCase() : "";
          const regimeFit: RegimeFitRating | undefined = validRatings.has(rawFit)
            ? (rawFit as RegimeFitRating)
            : undefined;
          return {
            ticker: String(p.ticker).trim().toUpperCase(),
            sources: Array.isArray(p.sources) ? p.sources.map(String).filter(Boolean) : [],
            sourceCount: typeof p.sourceCount === "number"
              ? p.sourceCount
              : (Array.isArray(p.sources) ? p.sources.length : 0),
            thesis: typeof p.thesis === "string" ? p.thesis : "",
            regimeFit,
            regimeFitRationale: typeof p.regimeFitRationale === "string"
              ? p.regimeFitRationale
              : undefined,
          };
        });

    const topPicks = normPicks(Array.isArray(parsed.topPicks) ? parsed.topPicks : []);
    const honorableMentions = normPicks(
      Array.isArray(parsed.honorableMentions) ? parsed.honorableMentions : []
    );
    const regimeAlignedHighlights = normPicks(
      Array.isArray(parsed.regimeAlignedHighlights) ? parsed.regimeAlignedHighlights : []
    );

    return {
      summary: parsed.summary,
      regimeTilts: Array.isArray(parsed.regimeTilts)
        ? parsed.regimeTilts.map(String).filter((s) => s.trim().length > 0)
        : undefined,
      topPicks,
      regimeAlignedHighlights,
      honorableMentions,
      cautions: Array.isArray(parsed.cautions) ? parsed.cautions.map(String) : undefined,
      regimeContext: typeof parsed.regimeContext === "string" ? parsed.regimeContext : undefined,
    };
  } catch {
    return null;
  }
}

/** Defense-in-depth: strip portfolio-ticker matches from picks AND
 *  remove any "PORTFOLIO CONFIRMATION" / "already holds" / "existing
 *  position" notes from cautions if the model adds them anyway. The
 *  user has explicitly asked not to be reminded of their own holdings.
 */
function filterPortfolioOut(result: SynthesisResult, portfolioTickers: string[]): SynthesisResult {
  if (portfolioTickers.length === 0) return result;
  const portfolio = new Set(portfolioTickers.map(normalizeTicker));
  const isHeld = (t: string) => isPortfolioMatch(t, portfolio);

  // Strip caution lines that look like portfolio-confirmation noise.
  // Keeps cautions that are genuinely actionable (bottom-ideas
  // conflicts, regime mismatches, etc.).
  const portfolioConfirmationPatterns = [
    /^\s*PORTFOLIO\s+CONFIRMATION/i,
    /\balready\s+(?:holds?|owns?|in\s+(?:the\s+)?portfolio)\b/i,
    /\bsource\s+confirms?\s+(?:the\s+)?existing\b/i,
    /\bexisting\s+position\s+is\s+well[-\s]supported\b/i,
    /\bconfirms?\s+the\s+existing\b/i,
  ];
  const filteredCautions = result.cautions
    ? result.cautions.filter((c) => !portfolioConfirmationPatterns.some((re) => re.test(c)))
    : undefined;

  return {
    ...result,
    topPicks: result.topPicks.filter((p) => !isHeld(p.ticker)),
    regimeAlignedHighlights: result.regimeAlignedHighlights.filter((p) => !isHeld(p.ticker)),
    honorableMentions: result.honorableMentions.filter((p) => !isHeld(p.ticker)),
    cautions: filteredCautions && filteredCautions.length > 0 ? filteredCautions : undefined,
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
      (research.fundstratSmidTop?.length ?? 0) +
      (research.fundstratSmidBottom?.length ?? 0) +
      (research.rbcCanadianFocus?.length ?? 0) +
      (research.rbcUsFocus?.length ?? 0) +
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
