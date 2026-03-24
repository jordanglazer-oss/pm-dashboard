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

// Build a lookup of key → max for clamping
const maxLookup: Record<string, number> = {};
for (const g of SCORE_GROUPS) {
  for (const c of g.categories) {
    maxLookup[c.key] = c.max;
  }
}

const AI_KEYS = AI_CATEGORIES.map((c) => c.key);

// ── Financial data fetcher (financialdatasets.ai) ──
const FD_BASE = "https://api.financialdatasets.ai";

async function fetchFinancialData(ticker: string): Promise<string> {
  const apiKey = process.env.FINANCIAL_DATASETS_API_KEY;
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const fetchers = [
    // Income statement (annual, 3 years)
    fetch(`${FD_BASE}/financials/income-statements?ticker=${ticker}&period=annual&limit=3`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Balance sheet (TTM)
    fetch(`${FD_BASE}/financials/balance-sheets?ticker=${ticker}&period=ttm&limit=1`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Cash flow (annual, 3 years)
    fetch(`${FD_BASE}/financials/cash-flow-statements?ticker=${ticker}&period=annual&limit=3`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Financial metrics (annual, 5 years for historical valuation)
    fetch(`${FD_BASE}/financials/metrics?ticker=${ticker}&period=annual&limit=5`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Current metrics snapshot
    fetch(`${FD_BASE}/financials/metrics/snapshot?ticker=${ticker}`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Company facts (sector, industry)
    fetch(`${FD_BASE}/company/facts?ticker=${ticker}`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
    // Analyst estimates
    fetch(`${FD_BASE}/financials/analyst-estimates?ticker=${ticker}&period=annual&limit=3`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
  ];

  const [income, balance, cashflow, metrics, snapshot, facts, estimates] = await Promise.all(fetchers);

  const sections: string[] = [];

  if (facts) {
    sections.push(`COMPANY FACTS:\n${JSON.stringify(facts, null, 2)}`);
  }

  if (snapshot) {
    sections.push(`CURRENT FINANCIAL METRICS SNAPSHOT:\n${JSON.stringify(snapshot, null, 2)}`);
  }

  if (income) {
    sections.push(`INCOME STATEMENTS (Annual, last 3 years):\n${JSON.stringify(income, null, 2)}`);
  }

  if (balance) {
    sections.push(`BALANCE SHEET (TTM):\n${JSON.stringify(balance, null, 2)}`);
  }

  if (cashflow) {
    sections.push(`CASH FLOW STATEMENTS (Annual, last 3 years):\n${JSON.stringify(cashflow, null, 2)}`);
  }

  if (metrics) {
    sections.push(`HISTORICAL FINANCIAL METRICS (Annual, 5 years):\n${JSON.stringify(metrics, null, 2)}`);
  }

  if (estimates) {
    sections.push(`ANALYST ESTIMATES:\n${JSON.stringify(estimates, null, 2)}`);
  }

  if (sections.length === 0) {
    return "No financial data available from API. Use your best knowledge but clearly state that data should be verified.";
  }

  return sections.join("\n\n---\n\n");
}

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. You will be provided with REAL FINANCIAL DATA — you MUST use this data to produce accurate, specific explanations. Do not guess or fabricate numbers.

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
- growth (max 3, AUTO): Growth (rev / earnings / FCF) — USE THE PROVIDED DATA. Cite actual revenue figures, YoY growth rates, EPS, net income changes, FCF trends. Compare sequential quarters and year-over-year. Include guidance if available from analyst estimates.
- relativeValuation (max 3, AUTO): Relative valuation — USE INDUSTRY-SPECIFIC METRICS FIRST:
  * Banks/Financials: P/B, P/TBV, ROE, ROA, efficiency ratio vs peers
  * REITs: P/FFO, P/AFFO, cap rate, dividend yield vs peers
  * Insurance: P/B, combined ratio, ROE vs peers
  * Tech/Software: EV/Revenue, EV/EBITDA, Rule of 40, gross margin vs peers
  * Industrials: EV/EBITDA, P/E, FCF yield vs peers
  * Healthcare: EV/EBITDA, P/E, pipeline value vs peers
  * Energy: EV/EBITDA, P/CF, dividend yield, reserve replacement vs peers
  * Utilities: P/E, dividend yield, rate base growth vs peers
  * Consumer: P/E, EV/EBITDA, same-store sales growth vs peers
  Then also reference general metrics (P/E, EV/EBITDA, FCF yield). Cite actual multiples from the provided data and compare to sector averages.
- historicalValuation (max 2, AUTO): Historical valuation — Compare CURRENT multiples to the company's OWN 3-5 year history. Use the historical metrics data provided. Cite specific numbers (e.g., "Current EV/EBITDA of 15.3x vs 5-year avg of 18.5x"). Note if trading above or below historical ranges and why.
- leverageCoverage (max 2, AUTO): Leverage & coverage — Net debt/EBITDA, interest coverage ratio, debt maturity profile. Use actual balance sheet and income statement data.
- cashFlowQuality (max 1, AUTO): Cash flow quality — FCF conversion rate (FCF/Net Income), operating cash flow trends, capex intensity, working capital changes. Use actual cash flow statement data.

COMPANY SPECIFIC GROUP:
- competitiveMoat (max 2, SEMI): Competitive moat — durable competitive advantages, switching costs, network effects
- catalysts (max 3, SEMI): Potential catalysts — upcoming events, product launches, strategic shifts, M&A potential

MANAGEMENT GROUP:
- trackRecord (max 1, SEMI): Track record — management execution history, capital allocation quality
- ownershipTrends (max 2, SEMI): Ownership trends — institutional ownership quality, insider buying/selling patterns

CRITICAL RULES FOR EXPLANATIONS:
1. Every explanation MUST cite specific numbers from the provided financial data
2. Growth explanations must include actual revenue/earnings figures with YoY% changes
3. Valuation explanations must include actual multiples (P/E, EV/EBITDA, etc.) and peer comparisons
4. Historical valuation must compare current vs historical averages with specific numbers
5. Leverage must cite actual debt figures and coverage ratios
6. Cash flow must cite actual FCF figures and conversion rates
7. Write in a dense, data-rich paragraph style (not bullet points) — like an analyst note
8. Each explanation should be 3-6 sentences with multiple data points

Also provide:
- name: Full company name
- sector: GICS sector
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
    "secular": ["paragraph explanation"],
    "researchCoverage": ["paragraph explanation"],
    "charting": ["paragraph explanation"],
    "growth": ["paragraph explanation with actual revenue/earnings data"],
    "relativeValuation": ["paragraph explanation with actual multiples and peer comparisons"],
    "historicalValuation": ["paragraph explanation comparing current vs historical multiples"],
    "leverageCoverage": ["paragraph explanation with actual debt metrics"],
    "cashFlowQuality": ["paragraph explanation with actual FCF data"],
    "competitiveMoat": ["paragraph explanation"],
    "catalysts": ["paragraph explanation"],
    "trackRecord": ["paragraph explanation"],
    "ownershipTrends": ["paragraph explanation"]
  },
  "notes": "PM note here."
}`;

export async function POST(request: NextRequest) {
  try {
    const { ticker } = await request.json();

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json(
        { error: "Ticker is required" },
        { status: 400 }
      );
    }

    const upperTicker = ticker.toUpperCase();

    // Fetch real financial data first
    let financialContext = "";
    try {
      financialContext = await fetchFinancialData(upperTicker);
    } catch (e) {
      console.error("Failed to fetch financial data:", e);
      financialContext = "Financial data API unavailable. Use your best knowledge but note that data should be verified.";
    }

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `Score the following stock: ${upperTicker}\n\nHere is the real financial data for this company — USE THIS DATA for your scoring and explanations:\n\n${financialContext}`,
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
        } else if (typeof val === "string") {
          explanations[key as ScoreKey] = [val];
        }
      }
    }

    return NextResponse.json({
      ticker: upperTicker,
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
