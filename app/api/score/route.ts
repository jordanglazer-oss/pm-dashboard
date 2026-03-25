import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";

const client = new Anthropic();

const AI_CATEGORIES = SCORE_GROUPS.flatMap((g) =>
  g.categories
    .filter((c) => c.inputType === "auto" || c.inputType === "semi")
    .map((c) => ({ ...c, group: g.name }))
);

const maxLookup: Record<string, number> = {};
for (const g of SCORE_GROUPS) {
  for (const c of g.categories) {
    maxLookup[c.key] = c.max;
  }
}

const AI_KEYS = AI_CATEGORIES.map((c) => c.key);

// ── Financial Modeling Prep API ──
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

async function fmpFetch(url: string, label: string): Promise<{ label: string; data: unknown } | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.log(`[FMP] ${label}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.log(`[FMP] ${label}: empty response`);
      return null;
    }
    // FMP returns error messages as objects
    if (data["Error Message"] || data["error"]) {
      console.log(`[FMP] ${label}: API error - ${data["Error Message"] || data["error"]}`);
      return null;
    }
    console.log(`[FMP] ${label}: OK`);
    return { label, data };
  } catch (err) {
    console.log(`[FMP] ${label}: fetch error - ${err}`);
    return null;
  }
}

async function fetchFinancialData(ticker: string): Promise<string> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return "No financial data API key configured. Use your best knowledge but clearly note that figures should be verified.";
  }

  const k = `apikey=${apiKey}`;

  // Fetch quarterly + annual data for maximum freshness
  const results = await Promise.all([
    // REAL-TIME: Current quote with live price, PE, market cap
    fmpFetch(`${FMP_BASE}/quote/${ticker}?${k}`, "REAL-TIME QUOTE (current price, PE, market cap)"),
    // QUARTERLY income statements (last 4 quarters = most recent data)
    fmpFetch(`${FMP_BASE}/income-statement/${ticker}?period=quarter&limit=4&${k}`, "INCOME STATEMENTS (Quarterly, last 4 quarters)"),
    // ANNUAL income statements (3 years for trend)
    fmpFetch(`${FMP_BASE}/income-statement/${ticker}?period=annual&limit=3&${k}`, "INCOME STATEMENTS (Annual, 3 years)"),
    // Balance sheet (latest quarter)
    fmpFetch(`${FMP_BASE}/balance-sheet-statement/${ticker}?period=quarter&limit=1&${k}`, "BALANCE SHEET (Latest quarter)"),
    // QUARTERLY cash flow (last 4 quarters)
    fmpFetch(`${FMP_BASE}/cash-flow-statement/${ticker}?period=quarter&limit=4&${k}`, "CASH FLOW (Quarterly, last 4 quarters)"),
    // ANNUAL cash flow (3 years)
    fmpFetch(`${FMP_BASE}/cash-flow-statement/${ticker}?period=annual&limit=3&${k}`, "CASH FLOW (Annual, 3 years)"),
    // Key metrics (annual, 5 years for historical valuation comps)
    fmpFetch(`${FMP_BASE}/key-metrics/${ticker}?period=annual&limit=5&${k}`, "KEY METRICS (Annual, 5 years)"),
    // Key metrics TTM for current valuation
    fmpFetch(`${FMP_BASE}/key-metrics-ttm/${ticker}?${k}`, "KEY METRICS TTM (Trailing 12 months)"),
    // Ratios TTM
    fmpFetch(`${FMP_BASE}/ratios-ttm/${ticker}?${k}`, "FINANCIAL RATIOS TTM"),
    // Ratios (annual, 5 years for historical comparison)
    fmpFetch(`${FMP_BASE}/ratios/${ticker}?period=annual&limit=5&${k}`, "FINANCIAL RATIOS (Annual, 5 years)"),
    // Company profile (sector, industry, beta, description, current price)
    fmpFetch(`${FMP_BASE}/profile/${ticker}?${k}`, "COMPANY PROFILE"),
    // Analyst estimates (forward)
    fmpFetch(`${FMP_BASE}/analyst-estimates/${ticker}?limit=3&${k}`, "ANALYST ESTIMATES (Forward)"),
    // Enterprise value
    fmpFetch(`${FMP_BASE}/enterprise-values/${ticker}?period=annual&limit=3&${k}`, "ENTERPRISE VALUE (Annual, 3 years)"),
  ]);

  const sections = results
    .filter((r): r is { label: string; data: unknown } => r !== null)
    .map((r) => `${r.label}:\n${JSON.stringify(r.data, null, 2)}`);

  const successCount = sections.length;
  const totalEndpoints = results.length;
  console.log(`[FMP] ${ticker}: ${successCount}/${totalEndpoints} endpoints returned data`);

  if (sections.length === 0) {
    return "IMPORTANT: No financial data was returned from the API. All endpoints failed. Use your best knowledge but CLEARLY STATE in every explanation that the data could not be verified with live sources and should be independently confirmed.";
  }

  // Now fetch peer companies for relative valuation
  let peerSection = "";
  try {
    const FMP_V4 = "https://financialmodelingprep.com/api/v4";
    const peersRes = await fmpFetch(`${FMP_V4}/stock_peers?symbol=${ticker}&${k}`, "PEER COMPANIES");
    if (peersRes && Array.isArray(peersRes.data) && peersRes.data.length > 0) {
      const peerList: string[] = peersRes.data[0]?.peersList || [];
      // Take top 4 peers to keep API calls reasonable
      const topPeers = peerList.slice(0, 4);
      console.log(`[FMP] Peers for ${ticker}: ${topPeers.join(", ")}`);

      if (topPeers.length > 0) {
        // Fetch key metrics TTM and profile for each peer in parallel
        const peerResults = await Promise.all(
          topPeers.flatMap((peer) => [
            fmpFetch(`${FMP_BASE}/key-metrics-ttm/${peer}?${k}`, `PEER ${peer} KEY METRICS TTM`),
            fmpFetch(`${FMP_BASE}/quote/${peer}?${k}`, `PEER ${peer} QUOTE`),
            fmpFetch(`${FMP_BASE}/profile/${peer}?${k}`, `PEER ${peer} PROFILE`),
          ])
        );

        const peerData = peerResults
          .filter((r): r is { label: string; data: unknown } => r !== null)
          .map((r) => `${r.label}:\n${JSON.stringify(r.data, null, 2)}`);

        if (peerData.length > 0) {
          peerSection = `\n\n---\n\nPEER COMPANY DATA (use for relative valuation and competitive moat comparisons):\nPeers identified: ${topPeers.join(", ")}\n\n${peerData.join("\n\n")}`;
        }
      }
    }
  } catch (err) {
    console.log(`[FMP] Peer fetch error: ${err}`);
  }

  return `DATA FRESHNESS: ${successCount}/${totalEndpoints} API endpoints returned live data. Today's date is ${new Date().toISOString().split("T")[0]}. Use the MOST RECENT data available — prefer quarterly over annual where both exist.\n\n${sections.join("\n\n---\n\n")}${peerSection}`;
}

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. You will be provided with REAL FINANCIAL DATA — you MUST use this data to produce accurate, specific explanations. Do not guess or fabricate numbers.

Each category has its own max score (shown as /N). Score from 0 to that max:
- 0 = Poor / negative signal
- Max = Strong / positive signal

Score ONLY the following categories (AUTO and SEMI categories — the PM handles MANUAL ones like charting, relative strength, AI rating, brand, external sources, and turnaround):

LONG-TERM GROUP:
- secular (max 2, AUTO): Secular growth trend — long-term industry tailwinds favoring the company

RESEARCH GROUP:
- researchCoverage (max 4, SEMI): Research coverage — depth/breadth of sell-side coverage, estimate dispersion, quality of analyst pool

FUNDAMENTAL GROUP:
- growth (max 3, AUTO): Growth (rev / earnings / FCF) — USE THE PROVIDED DATA. Cite actual revenue figures, YoY growth rates, EPS, net income changes, FCF trends. Compare sequential quarters and year-over-year. Include guidance if available from analyst estimates.
- relativeValuation (max 3, AUTO): Relative valuation — You are provided with REAL PEER COMPANY DATA. Use it to make direct comparisons. USE INDUSTRY-SPECIFIC METRICS FIRST:
  * Banks/Financials: P/B, P/TBV, ROE, ROA, efficiency ratio vs peers
  * REITs: P/FFO, P/AFFO, cap rate, dividend yield vs peers
  * Insurance: P/B, combined ratio, ROE vs peers
  * Tech/Software: EV/Revenue, EV/EBITDA, Rule of 40, gross margin vs peers
  * Industrials: EV/EBITDA, P/E, FCF yield vs peers
  * Healthcare: EV/EBITDA, P/E, pipeline value vs peers
  * Energy: EV/EBITDA, P/CF, dividend yield, reserve replacement vs peers
  * Utilities: P/E, dividend yield, rate base growth vs peers
  * Consumer: P/E, EV/EBITDA, same-store sales growth vs peers
  IMPORTANT: Name specific peer companies and cite their actual multiples from the peer data provided. Example: "META trades at 15.3x EV/EBITDA vs GOOGL at 23.5x and SNAP at 18.2x." Do not use vague "sector average" — name the peers.
- historicalValuation (max 2, AUTO): Historical valuation — Compare CURRENT multiples to the company's OWN 3-5 year history. Use the historical metrics data provided. Cite specific numbers (e.g., "Current EV/EBITDA of 15.3x vs 5-year avg of 18.5x"). Note if trading above or below historical ranges and why.
- leverageCoverage (max 2, AUTO): Leverage & coverage — Net debt/EBITDA, interest coverage ratio, debt maturity profile. Use actual balance sheet and income statement data.
- cashFlowQuality (max 1, AUTO): Cash flow quality — FCF conversion rate (FCF/Net Income), operating cash flow trends, capex intensity, working capital changes. Use actual cash flow statement data.

COMPANY SPECIFIC GROUP:
- competitiveMoat (max 2, SEMI): Competitive moat — Use the peer data provided to assess competitive positioning. Compare margins, returns on capital, and growth rates vs named peers. Identify durable advantages: switching costs, network effects, brand, scale, IP. Back up qualitative claims with quantitative comparisons from the data.
- catalysts (max 3, SEMI): Potential catalysts — upcoming events, product launches, strategic shifts, M&A potential

MANAGEMENT GROUP:
- trackRecord (max 1, SEMI): Track record — management execution history, capital allocation quality
- ownershipTrends (max 2, SEMI): Ownership trends — institutional ownership quality, insider buying/selling patterns

CRITICAL RULES FOR EXPLANATIONS:
1. Every explanation MUST cite specific numbers from the provided financial data — NEVER make up numbers
2. ALWAYS prefer the MOST RECENT data: use quarterly data and TTM metrics over annual where available
3. Growth explanations must include actual revenue/earnings figures with YoY% changes — cite the most recent quarter AND full-year trends
4. Valuation explanations must use CURRENT multiples from the real-time quote or TTM metrics, and compare to sector averages
5. Historical valuation must compare current vs historical averages with specific numbers from the 5-year metrics data
6. Leverage must cite actual debt figures and coverage ratios from the most recent balance sheet
7. Cash flow must cite actual FCF figures and conversion rates from the most recent quarters
8. Write in a dense, data-rich paragraph style — like an analyst note
9. Each explanation should be 3-6 sentences with multiple data points
10. If any data is unavailable, explicitly say "data not available" rather than guessing

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
    "secular": 0, "researchCoverage": 0,
    "growth": 0, "relativeValuation": 0, "historicalValuation": 0,
    "leverageCoverage": 0, "cashFlowQuality": 0,
    "competitiveMoat": 0, "catalysts": 0,
    "trackRecord": 0, "ownershipTrends": 0
  },
  "explanations": {
    "secular": ["paragraph explanation"],
    "researchCoverage": ["paragraph explanation"],
    "growth": ["paragraph explanation with actual revenue/earnings data"],
    "relativeValuation": ["paragraph explanation citing specific peer names and their multiples from the peer data"],
    "historicalValuation": ["paragraph explanation comparing current vs historical multiples"],
    "leverageCoverage": ["paragraph explanation with actual debt metrics"],
    "cashFlowQuality": ["paragraph explanation with actual FCF data"],
    "competitiveMoat": ["paragraph explanation comparing vs named peers using provided peer data"],
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
