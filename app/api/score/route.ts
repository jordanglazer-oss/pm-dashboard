import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations, HealthData } from "@/app/lib/types";
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

// ── Yahoo Finance API (free, no key required, US + Canadian stocks) ──
const YAHOO_BASE = "https://query2.finance.yahoo.com";

async function getYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    // Step 1: Get cookie
    const cookieRes = await fetch("https://fc.yahoo.com", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const setCookie = cookieRes.headers.get("set-cookie") || "";

    // Step 2: Get crumb using cookie
    const crumbRes = await fetch(`${YAHOO_BASE}/v1/test/getcrumb`, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Cookie: setCookie,
      },
    });
    const crumb = await crumbRes.text();

    if (!crumb || crumb.includes("error")) {
      console.log("[Yahoo] Failed to get crumb");
      return null;
    }

    console.log("[Yahoo] Crumb obtained");
    return { cookie: setCookie, crumb };
  } catch (err) {
    console.log(`[Yahoo] Auth error: ${err}`);
    return null;
  }
}

type YahooResult = Record<string, unknown>;

async function fetchYahooModules(
  ticker: string,
  modules: string[],
  cookie: string,
  crumb: string
): Promise<YahooResult | null> {
  try {
    const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules.join(",")}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Cookie: cookie,
      },
    });
    if (!res.ok) {
      console.log(`[Yahoo] ${ticker}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      console.log(`[Yahoo] ${ticker}: no result`);
      return null;
    }
    console.log(`[Yahoo] ${ticker}: OK (${Object.keys(result).length} modules)`);
    return result;
  } catch (err) {
    console.log(`[Yahoo] ${ticker}: fetch error - ${err}`);
    return null;
  }
}

async function fetchFinancialData(ticker: string): Promise<{ context: string; price?: number; rawModules?: YahooResult }> {
  const auth = await getYahooCrumb();
  if (!auth) {
    return { context: "Financial data API authentication failed. Use your best knowledge but clearly note that figures should be verified." };
  }

  // Yahoo Finance ticker format: Canadian stocks use .TO suffix
  // Our app already stores them as CNR.TO etc, so they should work directly

  // Fetch all modules for the target company
  const companyModules = [
    "financialData",
    "defaultKeyStatistics",
    "incomeStatementHistory",
    "incomeStatementHistoryQuarterly",
    "balanceSheetHistory",
    "cashflowStatementHistory",
    "cashflowStatementHistoryQuarterly",
    "earnings",
    "earningsTrend",
    "price",
    "summaryDetail",
    "summaryProfile",
    "calendarEvents",
  ];

  const companyData = await fetchYahooModules(ticker, companyModules, auth.cookie, auth.crumb);

  if (!companyData) {
    return { context: "IMPORTANT: No financial data was returned from Yahoo Finance. Use your best knowledge but CLEARLY STATE in every explanation that the data could not be verified." };
  }

  // Extract current price
  let price: number | undefined;
  const priceData = companyData.price as Record<string, Record<string, unknown>> | undefined;
  if (priceData?.regularMarketPrice?.raw) {
    price = priceData.regularMarketPrice.raw as number;
  }
  const financialData = companyData.financialData as Record<string, Record<string, unknown>> | undefined;
  if (!price && financialData?.currentPrice?.raw) {
    price = financialData.currentPrice.raw as number;
  }

  // Format the data for Claude - include all modules
  const sections: string[] = [];

  // Summary/Profile
  if (companyData.summaryProfile || companyData.price) {
    sections.push(`COMPANY PROFILE:\n${JSON.stringify({ profile: companyData.summaryProfile, price: companyData.price }, null, 2)}`);
  }

  // Key Statistics (PE, EV, beta, short interest, etc.)
  if (companyData.defaultKeyStatistics) {
    sections.push(`KEY STATISTICS (current valuation metrics, enterprise value, shares, short interest):\n${JSON.stringify(companyData.defaultKeyStatistics, null, 2)}`);
  }

  // Financial Data (current ratios, margins, returns)
  if (companyData.financialData) {
    sections.push(`FINANCIAL DATA (current margins, returns, recommendations):\n${JSON.stringify(companyData.financialData, null, 2)}`);
  }

  // Summary Detail (PE, dividend, market cap, 52w range)
  if (companyData.summaryDetail) {
    sections.push(`SUMMARY DETAIL (PE, dividend yield, market cap, 52-week range):\n${JSON.stringify(companyData.summaryDetail, null, 2)}`);
  }

  // Income Statements (annual)
  if (companyData.incomeStatementHistory) {
    sections.push(`INCOME STATEMENTS (Annual, up to 4 years):\n${JSON.stringify(companyData.incomeStatementHistory, null, 2)}`);
  }

  // Income Statements (quarterly)
  if (companyData.incomeStatementHistoryQuarterly) {
    sections.push(`INCOME STATEMENTS (Quarterly, last 4 quarters):\n${JSON.stringify(companyData.incomeStatementHistoryQuarterly, null, 2)}`);
  }

  // Balance Sheet
  if (companyData.balanceSheetHistory) {
    sections.push(`BALANCE SHEET (Annual):\n${JSON.stringify(companyData.balanceSheetHistory, null, 2)}`);
  }

  // Cash Flow
  if (companyData.cashflowStatementHistory) {
    sections.push(`CASH FLOW STATEMENTS (Annual):\n${JSON.stringify(companyData.cashflowStatementHistory, null, 2)}`);
  }

  // Cash Flow (quarterly)
  if (companyData.cashflowStatementHistoryQuarterly) {
    sections.push(`CASH FLOW STATEMENTS (Quarterly, last 4 quarters):\n${JSON.stringify(companyData.cashflowStatementHistoryQuarterly, null, 2)}`);
  }

  // Earnings
  if (companyData.earnings) {
    sections.push(`EARNINGS (quarterly EPS history + estimates):\n${JSON.stringify(companyData.earnings, null, 2)}`);
  }

  // Earnings Trend (forward estimates)
  if (companyData.earningsTrend) {
    sections.push(`EARNINGS TREND (analyst estimates, revisions):\n${JSON.stringify(companyData.earningsTrend, null, 2)}`);
  }

  console.log(`[Yahoo] ${ticker}: ${sections.length} data sections compiled`);

  // Now fetch peer companies for relative valuation
  // Use the industry from summaryProfile to find peers
  let peerSection = "";
  const profile = companyData.summaryProfile as Record<string, string> | undefined;
  const industry = profile?.industry;

  if (industry) {
    // Fetch key financial data for 3 well-known peers
    // We'll ask Claude to identify peers since Yahoo doesn't have a peers endpoint
    // But we can try fetching a few common competitors based on sector
    try {
      // Use FMP for peer list if available (it works for this endpoint on free tier)
      const fmpKey = process.env.FMP_API_KEY;
      if (fmpKey) {
        const peersRes = await fetch(
          `https://financialmodelingprep.com/stable/stock-peers?symbol=${encodeURIComponent(ticker)}&apikey=${fmpKey}`,
          { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } }
        );
        if (peersRes.ok) {
          const peersData = await peersRes.json();
          if (Array.isArray(peersData) && peersData.length > 0) {
            const peerTickers: string[] = peersData
              .slice(0, 3)
              .map((p: Record<string, unknown>) => p.symbol as string)
              .filter(Boolean);

            if (peerTickers.length > 0) {
              console.log(`[Yahoo] Fetching peers: ${peerTickers.join(", ")}`);

              // Fetch key data for each peer via Yahoo
              const peerResults = await Promise.all(
                peerTickers.map((peer) =>
                  fetchYahooModules(
                    peer,
                    ["financialData", "defaultKeyStatistics", "summaryDetail", "price"],
                    auth.cookie,
                    auth.crumb
                  )
                )
              );

              const peerSections = peerTickers
                .map((peer, i) => {
                  if (!peerResults[i]) return null;
                  return `PEER: ${peer}\n${JSON.stringify(peerResults[i], null, 2)}`;
                })
                .filter(Boolean);

              if (peerSections.length > 0) {
                peerSection = `\n\n---\n\nPEER COMPANY DATA (use for relative valuation and competitive moat comparisons):\nPeers identified: ${peerTickers.join(", ")}\n\n${peerSections.join("\n\n---\n\n")}`;
              }
            }
          }
        }
      }
    } catch (err) {
      console.log(`[Yahoo] Peer fetch error: ${err}`);
    }
  }

  return {
    context: `DATA SOURCE: Yahoo Finance (live data). Today's date is ${new Date().toISOString().split("T")[0]}. All financial data below is from the company's actual SEC/SEDAR filings and current market data. Use the MOST RECENT data available — prefer quarterly over annual where both exist.\n\n${sections.join("\n\n---\n\n")}${peerSection}`,
    price,
    rawModules: companyData,
  };
}

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. You will be provided with REAL FINANCIAL DATA from Yahoo Finance — you MUST use this data to produce accurate, specific explanations. Do not guess or fabricate numbers.

Note: Yahoo Finance data uses "raw" for numeric values and "fmt" for formatted strings. Always use the actual numbers.

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
- historicalValuation (max 2, AUTO): Historical valuation — Compare CURRENT multiples to the company's OWN history using the provided financial data across multiple years. Cite specific numbers.
- leverageCoverage (max 2, AUTO): Leverage & coverage — Net debt/EBITDA, interest coverage ratio, debt levels. Use actual balance sheet data.
- cashFlowQuality (max 1, AUTO): Cash flow quality — FCF conversion rate (FCF/Net Income), operating cash flow trends, capex intensity. Use actual cash flow statement data.

COMPANY SPECIFIC GROUP:
- competitiveMoat (max 2, SEMI): Competitive moat — Use the peer data provided to assess competitive positioning. Compare margins, returns on capital, and growth rates vs named peers. Identify durable advantages.
- catalysts (max 3, SEMI): Potential catalysts — upcoming events, product launches, strategic shifts, M&A potential

MANAGEMENT GROUP:
- trackRecord (max 1, SEMI): Track record — management execution history, capital allocation quality
- ownershipTrends (max 2, SEMI): Ownership trends — institutional ownership quality, insider buying/selling patterns

CRITICAL RULES FOR EXPLANATIONS:
1. Every explanation MUST cite specific numbers from the provided financial data — NEVER make up numbers
2. ALWAYS prefer the MOST RECENT data: use quarterly data over annual where available
3. Growth explanations must include actual revenue/earnings figures with YoY% changes
4. Valuation explanations must use CURRENT multiples from the data and compare to peers
5. Historical valuation must compare current vs prior year multiples with specific numbers
6. Leverage must cite actual debt figures and coverage ratios from the balance sheet
7. Cash flow must cite actual FCF figures and conversion rates
8. Write in a dense, data-rich paragraph style — like an analyst note
9. Each explanation should be 3-6 sentences with multiple data points
10. If any data is unavailable, explicitly say "data not available" rather than guessing

Also provide:
- name: Full company name
- sector: GICS sector
- beta: Use the beta from the provided data
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
    "relativeValuation": ["paragraph explanation citing specific peer names and their multiples"],
    "historicalValuation": ["paragraph explanation comparing current vs historical multiples"],
    "leverageCoverage": ["paragraph explanation with actual debt metrics"],
    "cashFlowQuality": ["paragraph explanation with actual FCF data"],
    "competitiveMoat": ["paragraph explanation comparing vs named peers"],
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
    let stockPrice: number | undefined;
    let rawModules: YahooResult | undefined;
    try {
      const result = await fetchFinancialData(upperTicker);
      financialContext = result.context;
      stockPrice = result.price;
      rawModules = result.rawModules ?? undefined;
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

    // Extract health monitor data from raw Yahoo modules
    const healthData = extractHealthData(rawModules, stockPrice);

    return NextResponse.json({
      ticker: upperTicker,
      name: parsed.name || "Unknown",
      sector: parsed.sector || "Technology",
      beta: typeof parsed.beta === "number" ? parsed.beta : 1.0,
      scores,
      explanations,
      notes: parsed.notes || "",
      price: stockPrice,
      healthData,
    });
  } catch (error) {
    console.error("Score API error:", error);
    return NextResponse.json(
      { error: "Failed to score stock" },
      { status: 500 }
    );
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rawVal(obj: any, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k]?.raw ?? obj?.[k];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

function fmtVal(obj: any, key: string): string | undefined {
  const v = obj?.[key]?.fmt ?? obj?.[key];
  return typeof v === "string" ? v : undefined;
}

function extractHealthData(modules: YahooResult | undefined, currentPrice?: number): HealthData | undefined {
  if (!modules) return undefined;

  const summary = modules.summaryDetail as any;
  const keyStats = modules.defaultKeyStatistics as any;
  const financial = modules.financialData as any;
  const calendar = modules.calendarEvents as any;
  const earningsTrend = modules.earningsTrend as any;
  const cashflow = modules.cashflowStatementHistory as any;
  const income = modules.incomeStatementHistory as any;
  const balance = modules.balanceSheetHistory as any;

  // Earnings trend: extract current estimate and historical estimates
  let earningsCurrentEst: number | undefined;
  let earnings30dAgo: number | undefined;
  let earnings90dAgo: number | undefined;

  const trends = earningsTrend?.trend;
  if (Array.isArray(trends)) {
    // Usually first trend entry is current quarter
    const currentQuarter = trends[0];
    if (currentQuarter?.earningsEstimate) {
      earningsCurrentEst = rawVal(currentQuarter.earningsEstimate, "avg");
    }
    // Revisions: 30 days ago and 90 days ago from epsTrend
    if (currentQuarter?.epsTrend) {
      earnings30dAgo = rawVal(currentQuarter.epsTrend, "30daysAgo");
      earnings90dAgo = rawVal(currentQuarter.epsTrend, "90daysAgo");
    }
  }

  // FCF margin from most recent annual cashflow + income
  let fcfMargin: number | undefined;
  const cfStatements = cashflow?.cashflowStatements;
  const incStatements = income?.incomeStatementHistory;
  if (Array.isArray(cfStatements) && cfStatements.length > 0) {
    const latestCF = cfStatements[0];
    const opCashFlow = rawVal(latestCF, "totalCashFromOperatingActivities");
    const capex = rawVal(latestCF, "capitalExpenditures");
    const totalRevenue = rawVal(financial, "totalRevenue");
    if (opCashFlow != null && totalRevenue && totalRevenue !== 0) {
      // capex is typically negative in Yahoo data
      const fcf = opCashFlow + (capex ?? 0);
      fcfMargin = (fcf / totalRevenue) * 100;
    }
  }

  // ROIC = net income / (total assets - current liabilities)
  let roic: number | undefined;
  const balStatements = balance?.balanceSheetStatements;
  if (Array.isArray(incStatements) && incStatements.length > 0 && Array.isArray(balStatements) && balStatements.length > 0) {
    const netIncome = rawVal(incStatements[0], "netIncome");
    const totalAssets = rawVal(balStatements[0], "totalAssets");
    const currentLiabilities = rawVal(balStatements[0], "totalCurrentLiabilities");
    if (netIncome != null && totalAssets != null && currentLiabilities != null) {
      const investedCapital = totalAssets - currentLiabilities;
      if (investedCapital !== 0) {
        roic = (netIncome / investedCapital) * 100;
      }
    }
  }

  // Earnings date from calendarEvents
  let earningsDate: string | undefined;
  const earningsDates = calendar?.earnings?.earningsDate;
  if (Array.isArray(earningsDates) && earningsDates.length > 0) {
    earningsDate = fmtVal(earningsDates[0], "") ?? earningsDates[0]?.fmt;
    if (!earningsDate && earningsDates[0]?.raw) {
      earningsDate = new Date(earningsDates[0].raw * 1000).toISOString().split("T")[0];
    }
  }

  // Ex-dividend date
  let exDividendDate: string | undefined;
  const exDiv = summary?.exDividendDate;
  if (exDiv?.fmt) {
    exDividendDate = exDiv.fmt;
  } else if (exDiv?.raw) {
    exDividendDate = new Date(exDiv.raw * 1000).toISOString().split("T")[0];
  }

  const healthData: HealthData = {
    fiftyDayAvg: rawVal(summary, "fiftyDayAverage"),
    twoHundredDayAvg: rawVal(summary, "twoHundredDayAverage"),
    pegRatio: rawVal(keyStats, "pegRatio"),
    shortPercentOfFloat: rawVal(keyStats, "shortPercentOfFloat") != null
      ? (rawVal(keyStats, "shortPercentOfFloat")! * 100)
      : undefined,
    heldPercentInstitutions: rawVal(keyStats, "heldPercentInstitutions") != null
      ? (rawVal(keyStats, "heldPercentInstitutions")! * 100)
      : undefined,
    heldPercentInsiders: rawVal(keyStats, "heldPercentInsiders") != null
      ? (rawVal(keyStats, "heldPercentInsiders")! * 100)
      : undefined,
    earningsDate,
    exDividendDate,
    forwardPE: rawVal(summary, "forwardPE") ?? rawVal(keyStats, "forwardPE"),
    trailingPE: rawVal(summary, "trailingPE") ?? rawVal(keyStats, "trailingPE"),
    enterpriseToEbitda: rawVal(keyStats, "enterpriseToEbitda"),
    earningsCurrentEst,
    earnings30dAgo,
    earnings90dAgo,
    fcfMargin,
    roic,
    revenueGrowth: rawVal(financial, "revenueGrowth") != null
      ? (rawVal(financial, "revenueGrowth")! * 100)
      : undefined,
    currentPrice: currentPrice ?? rawVal(financial, "currentPrice"),
  };

  // Only return if we have at least some data
  const hasData = Object.values(healthData).some((v) => v != null);
  return hasData ? healthData : undefined;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function clamp(value: unknown, max: number): number {
  const num = typeof value === "number" ? value : 0;
  return Math.max(0, Math.min(max, Math.round(num)));
}
