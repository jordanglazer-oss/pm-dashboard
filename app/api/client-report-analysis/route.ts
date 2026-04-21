import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";

/**
 * Client-report AI analysis.
 *
 * Generates three bullet-form sections for the Client Portfolio
 * Comparison page of the Client Report PDF:
 *   1. "Where you are now"  — pros / cons of the client's current holdings
 *   2. "Our recommendations" — action items from the PIM model
 *   3. "Why this works better" — summary grounded in returns, allocation,
 *      and (optionally) long-term brief context
 *
 * Caching pattern (mirrors /api/upticks-scrape and the JPM flows cache):
 *   - POST body is hashed (MD5 over a canonical JSON projection of the
 *     inputs) to produce a fingerprint.
 *   - If the fingerprint matches `pm:client-report-analysis-cache`, we
 *     return cached output WITHOUT calling Anthropic. Regenerating the
 *     same report is free.
 *   - `force: true` bypasses the cache when the user hits "Regenerate".
 *   - This route never writes to `pm:client-portfolio` or any user data
 *     blob directly; the client chooses to persist results there.
 *
 * Blended MER is computed here from the optional per-ticker
 * `expenseRatio` map the client passes in. Unknown MERs are skipped
 * (not guessed) so the figure is always a lower bound. The prompt is
 * instructed to reason qualitatively when MER data is missing.
 */

const CACHE_KEY = "pm:client-report-analysis-cache";
const client = new Anthropic();

/**
 * Bumped whenever the Anthropic prompt instructions change in a way
 * that should invalidate previously-cached outputs. Folded into the
 * hash so old cached JSON doesn't leak stock-level commentary after
 * the prompt has been refocused on allocation-level reasoning.
 */
const PROMPT_VERSION = "v2-allocation-focus";

// ───────── Request / response shapes ─────────

type HoldingInput = {
  /** Ticker as displayed (whatever the caller uses — not normalized). */
  symbol: string;
  /** Company/fund display name. */
  name: string;
  /** Portfolio weight as a percentage (0–100). */
  weight: number;
};

type AllocationSlice = {
  label: string;
  weight: number;
};

type PerformanceInput = {
  annualizedReturnPct?: number | null;
  volatility?: number | null;
  upsideCapture?: number | null;
  downsideCapture?: number | null;
  yearsOfHistory?: number | null;
};

type RequestBody = {
  clientName?: string;
  clientHoldings: HoldingInput[];
  clientAllocation: AllocationSlice[];
  clientCashWeight?: number;
  modelProfileLabel: string;
  modelHoldings: HoldingInput[];
  modelAllocation: AllocationSlice[];
  /** Optional {TICKER: expenseRatioPercent} map; percent units (e.g. 0.22 for 22bps). */
  expenseRatios?: Record<string, number>;
  /** Symbols the caller knows are individual common stocks (zero MER). */
  stockSymbols?: string[];
  modelPerformance?: PerformanceInput;
  /** Optional long-term market context pulled from the Brief tab. */
  briefContext?: string;
  force?: boolean;
};

export type ClientReportAnalysis = {
  currentPosition: {
    pros: string[];
    cons: string[];
  };
  recommendations: string[];
  summary: string[];
  blendedMer: {
    /** Client portfolio blended MER (%, lower bound when some holdings have unknown MER). */
    client?: number;
    /** Model portfolio blended MER (%, lower bound when some holdings have unknown MER). */
    model?: number;
    /** Share of client holdings (by weight) with known MER — helps interpret the lower bound. */
    clientCoveragePct?: number;
    /** Share of model holdings (by weight) with known MER. */
    modelCoveragePct?: number;
  };
  generatedAt: string;
};

type CachedAnalysis = {
  hash: string;
  result: ClientReportAnalysis;
};

// ───────── Helpers ─────────

function canonicalize(body: RequestBody): string {
  // Project to a stable shape that's independent of key-ordering. The
  // hash should flip whenever any input that actually affects the model
  // changes — holdings, allocation, performance, MERs, names.
  const norm = {
    name: body.clientName?.trim() || "",
    profile: body.modelProfileLabel,
    ch: [...body.clientHoldings]
      .map((h) => [h.symbol.toUpperCase(), +h.weight.toFixed(3)])
      .sort(),
    ca: [...body.clientAllocation]
      .map((a) => [a.label, +a.weight.toFixed(3)])
      .sort(),
    cc: +(body.clientCashWeight ?? 0).toFixed(3),
    mh: [...body.modelHoldings]
      .map((h) => [h.symbol.toUpperCase(), +h.weight.toFixed(3)])
      .sort(),
    ma: [...body.modelAllocation]
      .map((a) => [a.label, +a.weight.toFixed(3)])
      .sort(),
    er: Object.keys(body.expenseRatios ?? {})
      .sort()
      .map((k) => [k.toUpperCase(), +(body.expenseRatios![k] ?? 0).toFixed(4)]),
    perf: {
      r: body.modelPerformance?.annualizedReturnPct ?? null,
      v: body.modelPerformance?.volatility ?? null,
      u: body.modelPerformance?.upsideCapture ?? null,
      d: body.modelPerformance?.downsideCapture ?? null,
    },
    brief: (body.briefContext ?? "").trim().slice(0, 500),
    // Include the prompt version so changes to the instructions bust
    // any cached output that was produced under older framing.
    pv: PROMPT_VERSION,
  };
  return JSON.stringify(norm);
}

function hashBody(body: RequestBody): string {
  return createHash("md5").update(canonicalize(body)).digest("hex");
}

async function getCached(hash: string): Promise<ClientReportAnalysis | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedAnalysis;
    return cached.hash === hash ? cached.result : null;
  } catch {
    return null;
  }
}

async function saveCached(hash: string, result: ClientReportAnalysis) {
  try {
    const redis = await getRedis();
    await redis.set(CACHE_KEY, JSON.stringify({ hash, result } satisfies CachedAnalysis));
  } catch (e) {
    console.error("Failed to cache client-report-analysis:", e);
  }
}

/** Weighted blended MER over a holdings list given a {ticker: MER%} lookup.
 *  Returns the lower-bound blended value and the coverage (share of weight
 *  with a known MER). Stocks default to 0 MER (direct equity has none). */
function blendedMer(
  holdings: HoldingInput[],
  lookup: Record<string, number>,
  stockSymbols: Set<string>,
): { value: number; coveragePct: number } {
  if (!holdings.length) return { value: 0, coveragePct: 0 };
  let weightedSum = 0;
  let coveredWeight = 0;
  let totalWeight = 0;
  for (const h of holdings) {
    if (h.weight <= 0) continue;
    totalWeight += h.weight;
    const sym = h.symbol.toUpperCase();
    if (stockSymbols.has(sym)) {
      // Direct stock holding — zero management fee. Counts as covered.
      coveredWeight += h.weight;
      continue;
    }
    const mer = lookup[sym];
    if (typeof mer === "number" && Number.isFinite(mer)) {
      weightedSum += h.weight * mer;
      coveredWeight += h.weight;
    }
  }
  if (totalWeight === 0) return { value: 0, coveragePct: 0 };
  // Normalize to the covered weight — gives a true weighted average
  // across known holdings rather than diluting with unknowns.
  const value = coveredWeight > 0 ? weightedSum / coveredWeight : 0;
  return { value, coveragePct: (coveredWeight / totalWeight) * 100 };
}

// ───────── Anthropic call ─────────

function buildPrompt(body: RequestBody, mer: ClientReportAnalysis["blendedMer"]): string {
  const clientName = body.clientName?.trim() || "the client";
  const fmtPct = (v: number | null | undefined, d = 2) =>
    typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(d)}%` : "n/a";

  const clientHoldingsBlock = body.clientHoldings
    .map((h) => {
      const er = body.expenseRatios?.[h.symbol.toUpperCase()];
      const merStr = typeof er === "number" ? ` (MER ${er.toFixed(2)}%)` : "";
      return `  - ${h.symbol} — ${h.name} — ${h.weight.toFixed(2)}%${merStr}`;
    })
    .join("\n");

  const clientAllocBlock = body.clientAllocation
    .map((a) => `  - ${a.label}: ${a.weight.toFixed(1)}%`)
    .join("\n");

  const modelHoldingsBlock = body.modelHoldings
    .slice(0, 20)
    .map((h) => {
      const er = body.expenseRatios?.[h.symbol.toUpperCase()];
      const merStr = typeof er === "number" ? ` (MER ${er.toFixed(2)}%)` : "";
      return `  - ${h.symbol} — ${h.name} — ${h.weight.toFixed(2)}%${merStr}`;
    })
    .join("\n");

  const modelAllocBlock = body.modelAllocation
    .map((a) => `  - ${a.label}: ${a.weight.toFixed(1)}%`)
    .join("\n");

  const perf = body.modelPerformance;
  const perfBlock = perf
    ? [
        `  - Annualized return (since inception): ${fmtPct(perf.annualizedReturnPct)}`,
        `  - Volatility (5Y, annualized): ${fmtPct(perf.volatility)}`,
        `  - Upside capture vs S&P 500 (5Y): ${fmtPct(perf.upsideCapture, 1)}`,
        `  - Downside capture vs S&P 500 (5Y): ${fmtPct(perf.downsideCapture, 1)}`,
        perf.yearsOfHistory != null
          ? `  - Years of live history: ${perf.yearsOfHistory.toFixed(1)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "  (no performance data provided)";

  const merBlock = [
    typeof mer.client === "number"
      ? `  - Client blended MER: ${mer.client.toFixed(2)}% (coverage ${(mer.clientCoveragePct ?? 0).toFixed(0)}%)`
      : "  - Client blended MER: unknown",
    typeof mer.model === "number"
      ? `  - ${body.modelProfileLabel} blended MER: ${mer.model.toFixed(2)}% (coverage ${(mer.modelCoveragePct ?? 0).toFixed(0)}%)`
      : `  - ${body.modelProfileLabel} blended MER: unknown`,
  ].join("\n");

  const briefBlock = body.briefContext?.trim()
    ? `\nLONG-TERM MARKET CONTEXT (from portfolio manager's notes):\n${body.briefContext.trim().slice(0, 1500)}\n`
    : "";

  return `You are writing the "where you are now vs where you could be" section of a client-facing investment report for a portfolio manager at RBC Dominion Securities. The reader is ${clientName}, a retail client deciding whether to move their portfolio into the manager's ${body.modelProfileLabel} PIM model.

Write in plain, concise English. Every output is a bullet. No filler, no hedging words like "somewhat" or "generally speaking". Each bullet is 1 short sentence (max ~18 words). Do not repeat the client's name. Do not use markdown bold/italic — the UI styles bullets itself.

FOCUS: Frame every bullet around ASSET ALLOCATION and the LIKELIHOOD OF LONG-TERM RETURNS. Think like an asset allocator, not a stock picker. Do NOT critique or praise individual single-stock positions by name (e.g. avoid "overweight NVDA" or "good position in Tesla"). Holdings are listed below as context for assessing diversification, fees, and asset-class mix — not for stock-level commentary. Acceptable references to specific tickers are limited to: (a) Core ETF wrappers when discussing the equity sleeve, and (b) mutual funds / active ETFs when discussing fees or structural decisions. Everything else should roll up to the asset-class, sector-concentration, geography, or factor level.

CLIENT'S CURRENT HOLDINGS:
${clientHoldingsBlock || "  (none provided)"}

CLIENT'S CURRENT ALLOCATION:
${clientAllocBlock || "  (none provided)"}

${body.modelProfileLabel} MODEL TOP HOLDINGS:
${modelHoldingsBlock || "  (none provided)"}

${body.modelProfileLabel} MODEL ALLOCATION:
${modelAllocBlock || "  (none provided)"}

MODEL PERFORMANCE:
${perfBlock}

BLENDED FEES (management expense ratio):
${merBlock}
${briefBlock}
Produce JSON with this exact shape (no prose before or after, no markdown fences):

{
  "currentPosition": {
    "pros": [string, ...],
    "cons": [string, ...]
  },
  "recommendations": [string, ...],
  "summary": [string, ...]
}

Requirements for each array (all at the ASSET-ALLOCATION level, not stock-by-stock):
  - "currentPosition.pros": 2 to 4 bullets on allocation-level strengths — e.g. reasonable equity/fixed-income split for the risk profile, low blended fee, meaningful geographic diversification, appropriate cash buffer, sensible use of passive core exposure. If there's truly nothing positive to say, return a single bullet acknowledging the portfolio needs substantial repositioning.
  - "currentPosition.cons": 3 to 5 bullets on allocation-level risks — cash drag, asset-class gaps (e.g. no fixed income sleeve, no global equity exposure), sector or geography concentration, high blended MER, mismatch between the current mix and a long-horizon equity return target. Reference MER numerically only if a number is provided; otherwise describe qualitatively.
  - "recommendations": 3 to 5 bullets. Each begins with a strong action verb. Recommendations must be ALLOCATION-level, not stock-level. Examples of acceptable phrasings: "Reduce cash from X% to Y% to capture long-term equity returns", "Add a fixed-income sleeve of ~Z% to dampen drawdowns", "Rotate single-stock risk into diversified ${body.modelProfileLabel} core ETFs", "Rebalance geography toward the model's US/Canada/Global split", "Lower blended MER by consolidating mutual funds into passive ETFs". Do NOT name individual common stocks as replacement candidates.
  - "summary": 2 to 4 bullets on LIKELIHOOD OF LONG-TERM RETURNS. Each bullet should tie the reallocation to an expected multi-year outcome — e.g. "Higher equity allocation raises the probability of beating inflation over 10+ years", "Diversified exposure reduces the chance of a single-sector drawdown derailing the plan", "Lower fee drag compounds to meaningful extra return over a 20-year horizon", "Historical 5-year metrics (upside/downside capture, volatility) suggest the model delivers a better risk-adjusted return profile." Use the performance stats quantitatively when provided.

If a data point is missing, omit the bullet rather than inventing numbers. Always return valid JSON.`;
}

function tryParseJson(text: string): ClientReportAnalysis | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.currentPosition ||
      !Array.isArray(parsed.currentPosition.pros) ||
      !Array.isArray(parsed.currentPosition.cons) ||
      !Array.isArray(parsed.recommendations) ||
      !Array.isArray(parsed.summary)
    ) {
      return null;
    }
    // Strip any accidental markdown in bullets. The UI renders plain text.
    const clean = (s: unknown) =>
      typeof s === "string" ? s.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").trim() : "";
    return {
      currentPosition: {
        pros: parsed.currentPosition.pros.map(clean).filter(Boolean),
        cons: parsed.currentPosition.cons.map(clean).filter(Boolean),
      },
      recommendations: parsed.recommendations.map(clean).filter(Boolean),
      summary: parsed.summary.map(clean).filter(Boolean),
      blendedMer: { client: undefined, model: undefined },
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function runAnalysis(
  body: RequestBody,
  mer: ClientReportAnalysis["blendedMer"],
): Promise<ClientReportAnalysis | null> {
  const prompt = buildPrompt(body, mer);
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  const parsed = tryParseJson(text);
  if (!parsed) {
    console.error("[client-report-analysis] failed to parse Anthropic output:", text.slice(0, 500));
    return null;
  }
  parsed.blendedMer = mer;
  return parsed;
}

// ───────── Route handler ─────────

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.clientHoldings) || !Array.isArray(body.modelHoldings)) {
    return NextResponse.json(
      { error: "clientHoldings and modelHoldings are required arrays" },
      { status: 400 },
    );
  }

  // Compute blended MERs. `stockSymbols` is the set of directly-held
  // common stocks (no management fee) — we treat these as zero-MER with
  // full coverage. Anything else falls through to the expenseRatios map.
  const stockSymbols = new Set<string>(
    (body.stockSymbols ?? []).map((s) => s.toUpperCase()),
  );
  const lookup: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.expenseRatios ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) lookup[k.toUpperCase()] = v;
  }
  const cMer = blendedMer(body.clientHoldings, lookup, stockSymbols);
  const mMer = blendedMer(body.modelHoldings, lookup, stockSymbols);
  const mer: ClientReportAnalysis["blendedMer"] = {
    client: cMer.coveragePct > 0 ? +cMer.value.toFixed(3) : undefined,
    model: mMer.coveragePct > 0 ? +mMer.value.toFixed(3) : undefined,
    clientCoveragePct: +cMer.coveragePct.toFixed(1),
    modelCoveragePct: +mMer.coveragePct.toFixed(1),
  };

  const hash = hashBody(body);
  if (!body.force) {
    const cached = await getCached(hash);
    if (cached) {
      return NextResponse.json({ result: cached, cached: true, hash });
    }
  }

  const result = await runAnalysis(body, mer);
  if (!result) {
    return NextResponse.json(
      { error: "Failed to generate analysis. Try again in a moment." },
      { status: 502 },
    );
  }

  await saveCached(hash, result);
  return NextResponse.json({ result, cached: false, hash });
}
