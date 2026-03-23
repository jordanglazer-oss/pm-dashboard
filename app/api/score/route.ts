import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";

const client = new Anthropic();

// Build the list of auto + semi categories for Claude to score
const AI_CATEGORIES = SCORE_GROUPS.flatMap((g) =>
  g.categories
    .filter((c) => c.inputType === "auto" || c.inputType === "semi")
    .map((c) => ({ ...c, group: g.name }))
);

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. Given a ticker symbol, provide scores for each category listed below.

Each category has its own max score (shown as /N). Score from 0 to that max:
- 0 = Poor / negative signal
- Max = Strong / positive signal

Score ONLY the following categories (AUTO and SEMI categories — the PM handles MANUAL ones):

LONG-TERM GROUP:
- secular (max 2, AUTO): Secular growth trend — long-term industry tailwinds favoring the company

RESEARCH GROUP:
- researchCoverage (max 4, SEMI): Research coverage — depth/breadth of sell-side coverage, estimate dispersion, quality of analyst pool

TECHNICALS GROUP:
- charting (max 3, SEMI): Charting — technical chart setup, trend, support/resistance, moving averages, volume patterns

FUNDAMENTAL GROUP:
- growth (max 3, AUTO): Growth (rev / earnings / FCF) — revenue, earnings, and free cash flow growth trajectory
- relativeValuation (max 3, AUTO): Relative valuation — P/E, EV/EBITDA, FCF yield vs. sector peers
- historicalValuation (max 2, AUTO): Historical valuation — current multiples vs. own 5-year history
- leverageCoverage (max 2, AUTO): Leverage & coverage — net debt/EBITDA, interest coverage, debt maturity profile
- cashFlowQuality (max 1, AUTO): Cash flow quality — FCF conversion, accruals, working capital trends

COMPANY SPECIFIC GROUP:
- competitiveMoat (max 2, SEMI): Competitive moat — durable competitive advantages, switching costs, network effects
- catalysts (max 3, SEMI): Potential catalysts — upcoming events, product launches, strategic shifts, M&A potential

MANAGEMENT GROUP:
- trackRecord (max 1, SEMI): Track record — management execution history, capital allocation quality
- ownershipTrends (max 2, SEMI): Ownership trends — institutional ownership quality, insider buying/selling patterns

For EACH scored category, also provide 2-3 brief bullet points explaining the data/reasoning behind the score. Be specific — cite actual metrics, trends, or data points (e.g. "Revenue growing 22% YoY", "Fwd P/E at 18x vs peers at 24x", "Net debt/EBITDA 1.2x").

Also provide:
- name: Full company name
- sector: GICS sector (Technology, Communication Services, Consumer Discretionary, Consumer Staples, Energy, Financials, Health Care, Industrials, Materials, Real Estate, Utilities)
- beta: Approximate beta to S&P 500
- notes: 1-2 sentence PM-oriented note on positioning and key risk/opportunity

Respond ONLY with valid JSON:
{
  "name": "Company Name",
  "sector": "GICS Sector",
  "beta": 1.0,
  "scores": {
    "secular": 0, "researchCoverage": 0, "charting": 0,
    "growth": 0, "relativeValuation": 0, "historicalValuation": 0,
    "leverageCoverage": 0, "cashFlowQuality": 0,
    "competitiveMoat": 0, "catalysts": 0,
    "trackRecord": 0, "ownershipTrends": 0
  },
  "explanations": {
    "secular": ["bullet1", "bullet2"],
    "researchCoverage": ["bullet1", "bullet2"],
    "charting": ["bullet1", "bullet2"],
    "growth": ["bullet1", "bullet2"],
    "relativeValuation": ["bullet1", "bullet2"],
    "historicalValuation": ["bullet1", "bullet2"],
    "leverageCoverage": ["bullet1", "bullet2"],
    "cashFlowQuality": ["bullet1", "bullet2"],
    "competitiveMoat": ["bullet1", "bullet2"],
    "catalysts": ["bullet1", "bullet2"],
    "trackRecord": ["bullet1", "bullet2"],
    "ownershipTrends": ["bullet1", "bullet2"]
  },
  "notes": "PM note here."
}`;

// Build a lookup of key → max for clamping
const maxLookup: Record<string, number> = {};
for (const g of SCORE_GROUPS) {
  for (const c of g.categories) {
    maxLookup[c.key] = c.max;
  }
}

const AI_KEYS = AI_CATEGORIES.map((c) => c.key);

export async function POST(request: NextRequest) {
  try {
    const { ticker } = await request.json();

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json(
        { error: "Ticker is required" },
        { status: 400 }
      );
    }

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `Score the following stock: ${ticker.toUpperCase()}`,
        },
      ],
      system: SCORING_PROMPT,
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Failed to parse scoring response" },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Clamp each AI-scored category to its max
    const scores: Partial<Record<ScoreKey, number>> = {};
    for (const key of AI_KEYS) {
      const raw = parsed.scores?.[key];
      const max = maxLookup[key] || 3;
      scores[key as ScoreKey] = clamp(raw, max);
    }

    // Parse explanations
    const explanations: ScoreExplanations = {};
    if (parsed.explanations) {
      for (const key of AI_KEYS) {
        const val = parsed.explanations[key];
        if (Array.isArray(val)) {
          explanations[key as ScoreKey] = val.map((b: unknown) =>
            typeof b === "string" ? b : String(b)
          );
        }
      }
    }

    return NextResponse.json({
      ticker: ticker.toUpperCase(),
      name: parsed.name || "Unknown",
      sector: parsed.sector || "Technology",
      beta: typeof parsed.beta === "number" ? parsed.beta : 1.0,
      scores,
      explanations,
      notes: parsed.notes || "",
    });
  } catch (error) {
    console.error("Score API error:", error);
    return NextResponse.json(
      { error: "Failed to score stock" },
      { status: 500 }
    );
  }
}

function clamp(value: unknown, max: number): number {
  const num = typeof value === "number" ? value : 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}
