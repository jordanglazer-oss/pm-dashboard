import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations, ScoreDataPointSource, HealthData } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";
import type { OHLCVBar, TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { computeTechnicals, computeRiskAlert, formatTechnicalsForPrompt } from "@/app/lib/technicals";
import { formatEdgarSnapshotForPrompt } from "@/app/lib/edgar-prompt";

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

async function fetchPriceHistory(ticker: string): Promise<OHLCVBar[]> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) {
      console.log(`[Yahoo] ${ticker} chart: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      console.log(`[Yahoo] ${ticker} chart: no result`);
      return [];
    }

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) return [];

    const bars: OHLCVBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];
      const volume = quote.volume?.[i];
      // Skip bars with null data
      if (open == null || high == null || low == null || close == null || volume == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
        open,
        high,
        low,
        close,
        volume,
      });
    }

    console.log(`[Yahoo] ${ticker} chart: ${bars.length} bars`);
    return bars;
  } catch (err) {
    console.log(`[Yahoo] ${ticker} chart error: ${err}`);
    return [];
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

  // Pre-extract key metrics instead of dumping raw JSON (saves ~70% tokens)
  const r = (obj: any, ...keys: string[]): string => {
    for (const k of keys) {
      const v = obj?.[k]?.fmt ?? obj?.[k]?.raw ?? obj?.[k];
      if (v != null && v !== "" && typeof v !== "object") return String(v);
    }
    return "N/A";
  };
  const rn = (obj: any, ...keys: string[]): number | null => {
    for (const k of keys) {
      const v = obj?.[k]?.raw ?? obj?.[k];
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return null;
  };

  const ks = companyData.defaultKeyStatistics as any ?? {};
  const fd = companyData.financialData as any ?? {};
  const sd = companyData.summaryDetail as any ?? {};
  const sp = companyData.summaryProfile as any ?? {};
  const earn = companyData.earnings as any ?? {};
  const et = companyData.earningsTrend as any ?? {};
  const isH = (companyData.incomeStatementHistory as any)?.incomeStatementHistory ?? [];
  const isQ = (companyData.incomeStatementHistoryQuarterly as any)?.incomeStatementHistory ?? [];
  const bsH = (companyData.balanceSheetHistory as any)?.balanceSheetStatements ?? [];
  const cfH = (companyData.cashflowStatementHistory as any)?.cashflowStatements ?? [];
  const cfQ = (companyData.cashflowStatementHistoryQuarterly as any)?.cashflowStatements ?? [];

  // Build compact profile
  const lines: string[] = [];
  lines.push(`COMPANY: ${r(companyData.price, "shortName", "longName")} (${ticker})`);
  lines.push(`Sector: ${r(sp, "sector")} | Industry: ${r(sp, "industry")} | Employees: ${r(sp, "fullTimeEmployees")}`);
  lines.push(`Price: $${r(companyData.price, "regularMarketPrice")} | Market Cap: ${r(sd, "marketCap")} | Enterprise Value: ${r(ks, "enterpriseValue")}`);
  lines.push(`Beta: ${r(sd, "beta")} | 52-Week: $${r(sd, "fiftyTwoWeekLow")} - $${r(sd, "fiftyTwoWeekHigh")}`);

  // Valuation
  lines.push(`\nVALUATION:`);
  lines.push(`Trailing P/E: ${r(sd, "trailingPE")} | Forward P/E: ${r(sd, "forwardPE")} | PEG: ${r(ks, "pegRatio")}`);
  lines.push(`EV/EBITDA: ${r(ks, "enterpriseToEbitda")} | EV/Revenue: ${r(ks, "enterpriseToRevenue")} | P/B: ${r(ks, "priceToBook")}`);
  lines.push(`P/S: ${r(sd, "priceToSalesTrailing12Months")} | Dividend Yield: ${r(sd, "dividendYield")}`);

  // Margins & Returns
  lines.push(`\nMARGINS & RETURNS:`);
  lines.push(`Gross Margin: ${r(fd, "grossMargins")} | EBITDA Margin: ${r(fd, "ebitdaMargins")} | Operating Margin: ${r(fd, "operatingMargins")} | Profit Margin: ${r(fd, "profitMargins")}`);
  lines.push(`ROE: ${r(fd, "returnOnEquity")} | ROA: ${r(fd, "returnOnAssets")}`);

  // Growth
  lines.push(`\nGROWTH:`);
  lines.push(`Revenue Growth: ${r(fd, "revenueGrowth")} | Earnings Growth: ${r(fd, "earningsGrowth")}`);
  lines.push(`Total Revenue: ${r(fd, "totalRevenue")} | EBITDA: ${r(fd, "ebitda")} | Free Cash Flow: ${r(fd, "freeCashflow")} | Operating CF: ${r(fd, "operatingCashflow")}`);

  // Balance Sheet (most recent)
  if (bsH.length > 0) {
    const bs = bsH[0];
    lines.push(`\nBALANCE SHEET (most recent):`);
    lines.push(`Total Assets: ${r(bs, "totalAssets")} | Total Liabilities: ${r(bs, "totalLiab")} | Total Debt: ${r(bs, "longTermDebt", "shortLongTermDebt")}`);
    lines.push(`Cash: ${r(bs, "cash")} | Net Debt: ${r(fd, "totalDebt")} minus ${r(bs, "cash")}`);
    lines.push(`Debt/Equity: ${r(fd, "debtToEquity")} | Current Ratio: ${r(fd, "currentRatio")}`);
  }

  // Income trend (last 3 years if available)
  if (isH.length > 0) {
    lines.push(`\nINCOME TREND (annual):`);
    for (const stmt of isH.slice(0, 3)) {
      const yr = stmt?.endDate?.fmt ?? "?";
      lines.push(`  ${yr}: Revenue ${r(stmt, "totalRevenue")} | Net Income ${r(stmt, "netIncome")} | EPS ${r(stmt, "dilutedEPS", "basicEPS")}`);
    }
  }

  // Quarterly income trend
  if (isQ.length > 0) {
    lines.push(`\nINCOME TREND (quarterly):`);
    for (const stmt of isQ.slice(0, 4)) {
      const qtr = stmt?.endDate?.fmt ?? "?";
      lines.push(`  ${qtr}: Revenue ${r(stmt, "totalRevenue")} | Net Income ${r(stmt, "netIncome")} | EPS ${r(stmt, "dilutedEPS", "basicEPS")}`);
    }
  }

  // Cash Flow trend
  if (cfH.length > 0) {
    lines.push(`\nCASH FLOW TREND (annual):`);
    for (const stmt of cfH.slice(0, 3)) {
      const yr = stmt?.endDate?.fmt ?? "?";
      const opCF = rn(stmt, "totalCashFromOperatingActivities");
      const capex = rn(stmt, "capitalExpenditures");
      const fcf = opCF != null ? (opCF + (capex ?? 0)) : null;
      lines.push(`  ${yr}: Operating CF ${r(stmt, "totalCashFromOperatingActivities")} | Capex ${r(stmt, "capitalExpenditures")} | FCF ${fcf != null ? `$${(fcf/1e9).toFixed(2)}B` : "N/A"}`);
    }
  }

  // Quarterly cash flow
  if (cfQ.length > 0) {
    lines.push(`\nCASH FLOW TREND (quarterly):`);
    for (const stmt of cfQ.slice(0, 4)) {
      const qtr = stmt?.endDate?.fmt ?? "?";
      const opCF = rn(stmt, "totalCashFromOperatingActivities");
      const capex = rn(stmt, "capitalExpenditures");
      const fcf = opCF != null ? (opCF + (capex ?? 0)) : null;
      lines.push(`  ${qtr}: Operating CF ${r(stmt, "totalCashFromOperatingActivities")} | FCF ${fcf != null ? `$${(fcf/1e9).toFixed(2)}B` : "N/A"}`);
    }
  }

  // Earnings estimates
  const trends = et?.trend;
  if (Array.isArray(trends) && trends.length > 0) {
    lines.push(`\nEARNINGS ESTIMATES:`);
    for (const t of trends.slice(0, 2)) {
      const period = t?.period ?? "?";
      lines.push(`  ${period}: EPS Est ${r(t?.earningsEstimate ?? {}, "avg")} | Revenue Est ${r(t?.revenueEstimate ?? {}, "avg")} | Growth ${r(t, "growth")}`);
      if (t?.epsTrend) {
        lines.push(`    Revisions: 7d ago ${r(t.epsTrend, "7daysAgo")} | 30d ago ${r(t.epsTrend, "30daysAgo")} | 90d ago ${r(t.epsTrend, "90daysAgo")}`);
      }
    }
  }

  // Quarterly EPS history
  const qEarnings = earn?.earningsChart?.quarterly;
  if (Array.isArray(qEarnings) && qEarnings.length > 0) {
    lines.push(`\nQUARTERLY EPS (recent):`);
    for (const q of qEarnings) {
      lines.push(`  ${q?.date ?? "?"}: Actual ${r(q, "actual")} vs Est ${r(q, "estimate")} (${rn(q, "actual") != null && rn(q, "estimate") != null && rn(q, "actual")! > rn(q, "estimate")! ? "BEAT" : "MISS"})`);
    }
  }

  // Short interest & ownership
  lines.push(`\nOWNERSHIP:`);
  lines.push(`Short % of Float: ${r(ks, "shortPercentOfFloat")} | Institutional: ${r(ks, "heldPercentInstitutions")} | Insider: ${r(ks, "heldPercentInsiders")}`);
  lines.push(`Shares Outstanding: ${r(ks, "sharesOutstanding")} | Float: ${r(ks, "floatShares")}`);

  // Analyst recommendations
  lines.push(`\nANALYST: Target Mean $${r(fd, "targetMeanPrice")} | Target High $${r(fd, "targetHighPrice")} | Target Low $${r(fd, "targetLowPrice")} | Recommendation: ${r(fd, "recommendationKey")}`);

  console.log(`[Yahoo] ${ticker}: compact data compiled (${lines.length} lines)`);

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
              .slice(0, 2)
              .map((p: Record<string, unknown>) => p.symbol as string)
              .filter(Boolean);

            if (peerTickers.length > 0) {
              console.log(`[Yahoo] Fetching peers: ${peerTickers.join(", ")}`);

              // Fetch key data for each peer via Yahoo (compact metrics only)
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

              const peerLines = peerTickers
                .map((peer, i) => {
                  const p = peerResults[i];
                  if (!p) return null;
                  const pks = p.defaultKeyStatistics as any ?? {};
                  const pfd = p.financialData as any ?? {};
                  const psd = p.summaryDetail as any ?? {};
                  return `PEER ${peer}: Price $${r(p.price, "regularMarketPrice")} | P/E ${r(psd, "trailingPE")} | Fwd P/E ${r(psd, "forwardPE")} | EV/EBITDA ${r(pks, "enterpriseToEbitda")} | P/B ${r(pks, "priceToBook")} | Rev Growth ${r(pfd, "revenueGrowth")} | Gross Margin ${r(pfd, "grossMargins")} | ROE ${r(pfd, "returnOnEquity")} | FCF ${r(pfd, "freeCashflow")} | Market Cap ${r(psd, "marketCap")}`;
                })
                .filter(Boolean);

              if (peerLines.length > 0) {
                peerSection = `\n\nPEER COMPARISONS (use for relative valuation):\n${peerLines.join("\n")}`;
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
    context: `DATA SOURCE: Yahoo Finance (live data, ${new Date().toISOString().split("T")[0]}). All figures from actual filings.\n\n${lines.join("\n")}${peerSection}`,
    price,
    rawModules: companyData,
  };
}

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. You will be provided with REAL FINANCIAL DATA from two sources — you MUST use this data to produce accurate, specific explanations. Do not guess or fabricate numbers.

DATA SOURCES (in order of preference for fundamentals):

1. SEC EDGAR XBRL DATA (when present) — this is the AUDITED AS-REPORTED source pulled directly from 10-K and 10-Q filings, normalized through an industry-aware concept registry. PREFER these numbers for any fundamental metric (revenue, net income, EPS, OCF, capex, debt, cash, equity, etc.). The block is clearly marked "=== SEC EDGAR XBRL FINANCIALS ===" and includes industry classification, multi-year annual history, and YoY/CAGR calculations. Each metric also names the exact XBRL concept used so you can be precise about what's measured. EDGAR is only available for US-listed issuers (Canadian -T/.TO and OTC names will not have this block — fall back to Yahoo for those).

2. YAHOO FINANCE DATA (always present) — use for: current price, market cap, beta, sentiment metrics (P/E ratios when EDGAR isn't present), peer comparison data, analyst recommendations, dividend yield, and anything else EDGAR doesn't carry. Yahoo Finance data uses "raw" for numeric values and "fmt" for formatted strings; always use the actual numbers.

If a metric appears in BOTH sources and the values differ slightly: trust EDGAR for as-reported figures. Yahoo sometimes restates silently and definitions can drift; EDGAR is point-in-time correct from the filing.

STALE DATA HANDLING: any EDGAR field marked [STALE — last filed YYYY-MM-DD] has not been reported in over 18 months. Do NOT use stale fields as a current snapshot. Either omit analysis for that metric or note that the issuer no longer reports it discretely. Common stale cases include companies that stopped breaking out a line item in their financial statements (e.g., interest expense lumped into "other income/(expense), net").

INSIDER ACTIVITY: when the EDGAR block includes a "=== INSIDER ACTIVITY (Form 4...) ===" sub-section, this is the PRIMARY data source for the ownershipTrends category. The data comes directly from SEC Form 4 filings (officers, directors, 10%+ owners) over the last 90 days, filtered to OPEN-MARKET trades only (P=Purchase, S=Sale). RSU grants/vests, option exercises, and tax-withholding sales are deliberately EXCLUDED because they're scheduled/mechanical, not discretionary signals. Cite specific insiders, transaction dates, dollar amounts, and the directional bias. A cluster of multi-officer BUYS is a strong bullish signal; sustained broad-based SELLING is a yellow flag (but contextualize: a single 10% owner trimming a position is different from the CFO + CEO + COO all selling). If no Form 4 transactions appear, say so explicitly — quiet insider behavior is itself a neutral data point, not a missing field.

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
1. Every claim in the summary MUST be backed by a corresponding entry in the dataPoints array — NEVER make up numbers
2. ALWAYS prefer the MOST RECENT data: use quarterly over annual where available
3. Growth explanations must include actual revenue/earnings figures with YoY% changes
4. Valuation explanations must use CURRENT multiples from the data and compare to NAMED peers
5. Historical valuation must compare current vs prior year multiples with specific numbers
6. Leverage must cite actual debt figures and coverage ratios from the balance sheet
7. Cash flow must cite actual FCF figures and conversion rates
8. Write in a dense, data-rich paragraph style — like an analyst note
9. Each summary should be 3-6 sentences with multiple data points
10. If any data is unavailable, explicitly say "data not available" rather than guessing

WEB SEARCH VERIFICATION (when web_search tool is available — see "Verified scoring" instructions in user message):
You have the web_search tool. Use it to VERIFY and AUGMENT the provided data — not to chase rumors. Specific allowed uses, in this exact priority order:
  1. Verify the MOST RECENT quarterly results are reflected in the data above (revenue, EPS, margins). If the company has reported AFTER the data above, use the press-release numbers and note the date.
  2. Check for pre-announcements / guidance revisions issued in the last 90 days (from the company's IR page or 8-K filings).
  3. Confirm latest analyst rating changes / price target revisions from NAMED firms (last 30 days only).
  4. For non-US-listed companies (any ticker without an EDGAR block above — e.g. .TO, .V, -T, ADRs that aren't primary listings), use web_search as the PRIMARY financial verification layer: find the latest reported quarterly figures from the company's IR page or filings on SEDAR+ (Canadian) / regulatory filings (other jurisdictions). Cite the source URL/publication for each number.
  5. Sanity-check structural items: stock splits, dividend changes, buybacks announced in last 90 days.

EXPLICITLY IGNORE these in scoring (do NOT weight, do NOT cite):
  - M&A rumors, "sources say" stories, unsourced speculation
  - Blog opinions, social media sentiment, Seeking Alpha author opinions
  - General industry / macro news not specific to this issuer
  - Analyst chatter or downstream takes on already-public news
  - Single-source claims with no corroborating filing or press release

Trust hierarchy: company filings (10-K/Q, 8-K, MD&A) > company press releases > named analyst firms (MS, GS, JPM, etc.) > established financial press (WSJ, FT, Reuters, Bloomberg primary reporting) > everything else. If a claim only appears in one rumor blog or social post, IGNORE it.

CANADIAN STOCKS (.TO / .V / -T tickers, no EDGAR block):
EDGAR XBRL data is NOT available for Canadian-only listings. Use web_search aggressively for these names to verify Yahoo's fundamentals against the company's most recent MD&A or quarterly press release. Treat the company's own IR page and SEDAR+ filings as authoritative. Cite source URLs in sourceDetail.

DATA POINT SOURCING (for the dataPoints array in each explanation):
For every data point you cite, label its source:
  - "edgar" — value came from the SEC EDGAR XBRL block in the data above
  - "edgar-form4" — insider transaction data from the Form 4 block
  - "yahoo" — value came from the Yahoo Finance block
  - "web" — value came from a web_search result (sourceDetail = source name + date, e.g. "Apple Q4 2025 press release, Oct 30 2025")
  - "model" — qualitative inference based on company description / industry (use sparingly, only for narrative claims)

Also provide:
- name: Full company name
- sector: GICS sector
- beta: Use the beta from the provided data
- companySummary: 1-2 sentences explaining what the company does in plain language that a portfolio manager can relay to clients. Focus on the core business, key products/services, and what drives revenue. Keep it simple and jargon-free.
- investmentThesis: 1-2 sentences on why to own this stock right now given current market conditions. Reference specific catalysts, valuation support, or thematic tailwinds. This should be a concise "elevator pitch" a PM could use with clients.

Respond ONLY with valid JSON (no markdown code fences, no commentary):
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
    "secular": {
      "summary": "3-6 sentence paragraph",
      "dataPoints": [
        { "label": "TAM growth (industry source)", "value": "+18% YoY through 2030", "source": "web", "sourceDetail": "Gartner 2026 forecast, Mar 2026" }
      ]
    },
    "growth": {
      "summary": "...",
      "dataPoints": [
        { "label": "Revenue (Q3 2026)", "value": "$5.62B (+12% YoY)", "source": "edgar", "sourceDetail": "10-Q filed 2026-10-30" },
        { "label": "EPS (Q3 2026)", "value": "$2.34 vs $2.10 est", "source": "web", "sourceDetail": "Company press release, Oct 30 2026" }
      ]
    },
    "relativeValuation": { "summary": "...", "dataPoints": [...] },
    "historicalValuation": { "summary": "...", "dataPoints": [...] },
    "leverageCoverage": { "summary": "...", "dataPoints": [...] },
    "cashFlowQuality": { "summary": "...", "dataPoints": [...] },
    "competitiveMoat": { "summary": "...", "dataPoints": [...] },
    "catalysts": { "summary": "...", "dataPoints": [...] },
    "trackRecord": { "summary": "...", "dataPoints": [...] },
    "ownershipTrends": { "summary": "...", "dataPoints": [...] },
    "researchCoverage": { "summary": "...", "dataPoints": [...] }
  },
  "companySummary": "Plain-language summary of what the company does.",
  "investmentThesis": "Why to own this stock now given market conditions."
}`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker } = body;
    // Optional flag: when true, the API call enables Anthropic's
    // web_search tool so the model can verify cached fundamentals against
    // the company's most recent press releases / filings / named analyst
    // notes. Defaults to false for backward compatibility — callers must
    // opt in explicitly via the UI "Verify" toggle. Canadian / non-EDGAR
    // tickers benefit most from this since they lack the XBRL fallback.
    const verifyWithWebSearch: boolean = body?.verifyWithWebSearch === true;

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json(
        { error: "Ticker is required" },
        { status: 400 }
      );
    }

    const upperTicker = ticker.toUpperCase();
    // Whether this ticker is a Canadian-only listing (no EDGAR coverage).
    // When verify mode is on, we instruct the model to lean harder on
    // web_search for these names since the structured-feed quality is
    // thinner.
    const isCanadianListing = /\.TO$|\.V$|-T$|\.U$/i.test(upperTicker);

    // Fetch real financial data and price history in parallel
    let financialContext = "";
    let stockPrice: number | undefined;
    let rawModules: YahooResult | undefined;
    let technicals: TechnicalIndicators | null = null;
    let riskAlert: RiskAlert | undefined;

    try {
      // Fetch Yahoo + price history + EDGAR XBRL in parallel.
      // EDGAR returns null cleanly for non-US tickers so the score
      // route still works for Canadian/.TO names — they just don't
      // get the audited as-reported supplement.
      const [financialResult, priceHistory, edgarBlock] = await Promise.all([
        fetchFinancialData(upperTicker),
        fetchPriceHistory(upperTicker),
        formatEdgarSnapshotForPrompt(upperTicker).catch((e) => {
          console.error("[EDGAR] non-fatal fetch error:", e);
          return null;
        }),
      ]);

      financialContext = financialResult.context;
      stockPrice = financialResult.price;
      rawModules = financialResult.rawModules ?? undefined;

      // Compute technical indicators from price history
      if (priceHistory.length > 0) {
        technicals = computeTechnicals(priceHistory);
        if (technicals) {
          // Append technical summary to financial context for Claude
          financialContext += `\n\n---\n\n${formatTechnicalsForPrompt(technicals)}`;
        }
      }

      // Append the EDGAR XBRL block for US issuers. It's clearly
      // labeled inside the block so Claude can prefer it over Yahoo
      // for fundamentals while still using Yahoo for price/beta/peers.
      if (edgarBlock) {
        financialContext += `\n\n---\n\n${edgarBlock}`;
      }
    } catch (e) {
      console.error("Failed to fetch financial data:", e);
      financialContext = "Financial data API unavailable. Use your best knowledge but note that data should be verified.";
    }

    // Verify-mode preamble: tells the model that web_search is active and
    // it should use the tool aggressively for the items listed in the
    // WEB SEARCH VERIFICATION section of the system prompt (and especially
    // hard for Canadian listings, which have no EDGAR fallback).
    const verifyPreamble = verifyWithWebSearch
      ? `\n\n=== Verified scoring ===\nWeb search verification is ENABLED for this rescore. You MUST use the web_search tool to:\n  1. Confirm the most recent reported quarterly numbers match what's in the data above (or supersede them if the company reported AFTER the data was cached).\n  2. Check for guidance revisions / pre-announcements / 8-K filings issued in the last 90 days.\n  3. Find any analyst rating or price-target changes from named firms in the last 30 days.\n  4. ${isCanadianListing
            ? `THIS IS A CANADIAN LISTING (${upperTicker}) — no EDGAR data is available. Use web_search as the PRIMARY financial verification: look up the company's most recent quarterly press release / MD&A / SEDAR+ filing and use those numbers in your dataPoints. Cite each source URL or publication name in sourceDetail.`
            : `Verify the latest dividend / buyback / split changes.`}\nRespect the noise filter in the system prompt: ignore rumors, opinion blogs, and unsourced speculation. Cite source name and date in dataPoints.sourceDetail for every web-sourced fact.\nMax 4 searches.\n=== End verified scoring ===\n`
      : "";

    // Build tool list. Anthropic's web_search_20250305 tool runs server-side
    // and returns its results inline; the SDK exposes them through
    // server_tool_use and web_search_tool_result content blocks. We cap
    // max_uses to keep cost/latency bounded.
    type WebSearchTool = { type: "web_search_20250305"; name: "web_search"; max_uses?: number };
    const tools: WebSearchTool[] = verifyWithWebSearch
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }]
      : [];

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `Score the following stock: ${upperTicker}\n\nHere is the real financial data for this company — USE THIS DATA for your scoring and explanations:\n\n${financialContext}${verifyPreamble}`,
        },
      ],
      system: SCORING_PROMPT,
      tools: tools as unknown as Anthropic.Messages.Tool[],
    });

    // Walk the response content blocks to (a) collect the final text body
    // for JSON parsing and (b) capture web_search metadata (queries issued,
    // citations returned) so we can persist the audit trail to score-history.
    let text = "";
    const searchQueries: string[] = [];
    const searchCitations: Array<{ url: string; title?: string }> = [];
    for (const block of message.content) {
      if (block.type === "text") {
        text += block.text;
      } else if ((block.type as string) === "server_tool_use") {
        const stu = block as unknown as { name?: string; input?: { query?: string } };
        if (stu.name === "web_search" && typeof stu.input?.query === "string") {
          searchQueries.push(stu.input.query);
        }
      } else if ((block.type as string) === "web_search_tool_result") {
        const wst = block as unknown as { content?: Array<{ type: string; url?: string; title?: string }> };
        const items = Array.isArray(wst.content) ? wst.content : [];
        for (const item of items) {
          if (item?.type === "web_search_result" && typeof item.url === "string") {
            searchCitations.push({ url: item.url, title: item.title ?? undefined });
          }
        }
      }
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Failed to parse scoring response — no JSON found" },
        { status: 500 }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Attempt to repair truncated JSON
      let repaired = jsonMatch[0];
      repaired = repaired.replace(/,\s*"[^"]*":\s*"[^"]*$/, "");
      repaired = repaired.replace(/,\s*"[^"]*$/, "");
      const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      repaired += "]".repeat(Math.max(0, openBrackets));
      repaired += "}".repeat(Math.max(0, openBraces));
      try {
        parsed = JSON.parse(repaired);
        console.log(`[Score] Repaired truncated JSON for ${upperTicker}`);
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return NextResponse.json(
          { error: `Failed to parse scoring response: ${msg}` },
          { status: 500 }
        );
      }
    }

    // Clamp each AI-scored category to its max
    const scores: Partial<Record<ScoreKey, number>> = {};
    for (const key of AI_KEYS) {
      const raw = parsed.scores?.[key];
      const max = maxLookup[key] || 3;
      scores[key as ScoreKey] = clamp(raw, max);
    }

    // Parse explanations — supports new { summary, dataPoints } shape AND
    // legacy string / string[] shapes (so old test fixtures and any model
    // regressions don't 500 the endpoint).
    const explanations: ScoreExplanations = {};
    if (parsed.explanations && typeof parsed.explanations === "object") {
      for (const key of AI_KEYS) {
        const val = parsed.explanations[key];
        if (!val) continue;
        if (typeof val === "object" && !Array.isArray(val) && typeof val.summary === "string") {
          // New shape: { summary, dataPoints }
          const dpsRaw = Array.isArray(val.dataPoints) ? val.dataPoints : [];
          const allowedSources = new Set(["edgar", "edgar-form4", "yahoo", "web", "model"]);
          const dataPoints = (dpsRaw as unknown[])
            .filter((d: unknown): d is Record<string, unknown> => d != null && typeof d === "object")
            .map((d: Record<string, unknown>) => {
              const source = typeof d.source === "string" && allowedSources.has(d.source) ? d.source : "model";
              return {
                label: typeof d.label === "string" ? d.label : "(unnamed)",
                value: typeof d.value === "string" ? d.value : String(d.value ?? ""),
                source: source as ScoreDataPointSource,
                sourceDetail: typeof d.sourceDetail === "string" ? d.sourceDetail : undefined,
              };
            });
          explanations[key as ScoreKey] = {
            summary: val.summary,
            dataPoints,
          };
        } else if (Array.isArray(val)) {
          // Legacy: array of strings → wrap as summary with no dataPoints.
          explanations[key as ScoreKey] = {
            summary: val.filter((s: unknown) => typeof s === "string").join(" "),
            dataPoints: [],
          };
        } else if (typeof val === "string") {
          explanations[key as ScoreKey] = { summary: val, dataPoints: [] };
        }
      }
    }

    // Extract health monitor data from raw Yahoo modules
    const healthData = extractHealthData(rawModules, stockPrice);

    // Compute risk alert combining technicals with health data
    if (technicals && healthData) {
      riskAlert = computeRiskAlert(technicals, healthData);
    } else if (technicals) {
      riskAlert = computeRiskAlert(technicals);
    }

    return NextResponse.json({
      ticker: upperTicker,
      name: parsed.name || "Unknown",
      sector: parsed.sector || "Technology",
      beta: typeof parsed.beta === "number" ? parsed.beta : 1.0,
      scores,
      explanations,
      notes: parsed.companySummary || parsed.notes || "",
      companySummary: parsed.companySummary || "",
      investmentThesis: parsed.investmentThesis || "",
      price: stockPrice,
      healthData,
      technicals,
      riskAlert,
      // Verification metadata — surfaced for the score-history entry and
      // the stock-page UI ("Verified · 3 searches").
      verifiedSearch: verifyWithWebSearch,
      searchQueries,
      searchCitations,
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

  // FCF margin — prefer financialData.freeCashflow / totalRevenue (most reliable)
  // Fall back to cashflow statement if financialData doesn't have it
  let fcfMargin: number | undefined;
  const totalRevenue = rawVal(financial, "totalRevenue");
  const directFCF = rawVal(financial, "freeCashflow");
  if (directFCF != null && totalRevenue && totalRevenue !== 0) {
    fcfMargin = (directFCF / totalRevenue) * 100;
  } else {
    const cfStatements = cashflow?.cashflowStatements;
    if (Array.isArray(cfStatements) && cfStatements.length > 0) {
      const latestCF = cfStatements[0];
      const opCashFlow = rawVal(latestCF, "totalCashFromOperatingActivities");
      const capex = rawVal(latestCF, "capitalExpenditures");
      if (opCashFlow != null && totalRevenue && totalRevenue !== 0) {
        const fcf = opCashFlow + (capex ?? 0);
        fcfMargin = (fcf / totalRevenue) * 100;
      }
    }
  }
  const incStatements = income?.incomeStatementHistory;

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
    pegRatio: rawVal(keyStats, "pegRatio") ?? (() => {
      // Fallback: compute PEG = forwardPE / earningsGrowth if Yahoo returns empty
      const fpe = rawVal(summary, "forwardPE") ?? rawVal(keyStats, "forwardPE");
      const growth = rawVal(financial, "earningsGrowth");
      if (fpe != null && growth != null && growth !== 0) {
        return parseFloat((fpe / (growth * 100)).toFixed(2));
      }
      return undefined;
    })(),
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
