import { NextRequest, NextResponse } from "next/server";
import type { HealthData } from "@/app/lib/types";
import type { OHLCVBar, TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { computeTechnicals, computeRiskAlert } from "@/app/lib/technicals";

// ── Yahoo Finance helpers (shared with score route) ──

const YAHOO_BASE = "https://query2.finance.yahoo.com";

async function getYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const setCookie = cookieRes.headers.get("set-cookie") || "";
    const crumbRes = await fetch(`${YAHOO_BASE}/v1/test/getcrumb`, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: setCookie },
    });
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("error")) return null;
    return { cookie: setCookie, crumb };
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
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
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.quoteSummary?.result?.[0] ?? null;
  } catch {
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
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

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
      if (open == null || high == null || low == null || close == null || volume == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
        open, high, low, close, volume,
      });
    }
    return bars;
  } catch {
    return [];
  }
}

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

  let earningsCurrentEst: number | undefined;
  let earnings30dAgo: number | undefined;
  let earnings90dAgo: number | undefined;

  const trends = earningsTrend?.trend;
  if (Array.isArray(trends)) {
    const currentQuarter = trends[0];
    if (currentQuarter?.earningsEstimate) {
      earningsCurrentEst = rawVal(currentQuarter.earningsEstimate, "avg");
    }
    if (currentQuarter?.epsTrend) {
      earnings30dAgo = rawVal(currentQuarter.epsTrend, "30daysAgo");
      earnings90dAgo = rawVal(currentQuarter.epsTrend, "90daysAgo");
    }
  }

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
  let roic: number | undefined;
  const balStatements = balance?.balanceSheetStatements;
  if (Array.isArray(incStatements) && incStatements.length > 0 && Array.isArray(balStatements) && balStatements.length > 0) {
    const netIncome = rawVal(incStatements[0], "netIncome");
    const totalAssets = rawVal(balStatements[0], "totalAssets");
    const currentLiabilities = rawVal(balStatements[0], "totalCurrentLiabilities");
    if (netIncome != null && totalAssets != null && currentLiabilities != null) {
      const investedCapital = totalAssets - currentLiabilities;
      if (investedCapital !== 0) roic = (netIncome / investedCapital) * 100;
    }
  }

  let earningsDate: string | undefined;
  const earningsDates = calendar?.earnings?.earningsDate;
  if (Array.isArray(earningsDates) && earningsDates.length > 0) {
    earningsDate = fmtVal(earningsDates[0], "") ?? earningsDates[0]?.fmt;
    if (!earningsDate && earningsDates[0]?.raw) {
      earningsDate = new Date(earningsDates[0].raw * 1000).toISOString().split("T")[0];
    }
  }

  let exDividendDate: string | undefined;
  const exDiv = summary?.exDividendDate;
  if (exDiv?.fmt) exDividendDate = exDiv.fmt;
  else if (exDiv?.raw) exDividendDate = new Date(exDiv.raw * 1000).toISOString().split("T")[0];

  const healthData: HealthData = {
    fiftyDayAvg: rawVal(summary, "fiftyDayAverage"),
    twoHundredDayAvg: rawVal(summary, "twoHundredDayAverage"),
    pegRatio: rawVal(keyStats, "pegRatio") ?? (() => {
      const fpe = rawVal(summary, "forwardPE") ?? rawVal(keyStats, "forwardPE");
      const growth = rawVal(financial, "earningsGrowth");
      if (fpe != null && growth != null && growth !== 0) return parseFloat((fpe / (growth * 100)).toFixed(2));
      return undefined;
    })(),
    shortPercentOfFloat: rawVal(keyStats, "shortPercentOfFloat") != null
      ? (rawVal(keyStats, "shortPercentOfFloat")! * 100) : undefined,
    heldPercentInstitutions: rawVal(keyStats, "heldPercentInstitutions") != null
      ? (rawVal(keyStats, "heldPercentInstitutions")! * 100) : undefined,
    heldPercentInsiders: rawVal(keyStats, "heldPercentInsiders") != null
      ? (rawVal(keyStats, "heldPercentInsiders")! * 100) : undefined,
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
      ? (rawVal(financial, "revenueGrowth")! * 100) : undefined,
    currentPrice: currentPrice ?? rawVal(financial, "currentPrice"),
  };

  const hasData = Object.values(healthData).some((v) => v != null);
  return hasData ? healthData : undefined;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Health data modules (subset of what score route fetches — no peers, no financial context) ──

const HEALTH_MODULES = [
  "price",
  "assetProfile",
  "financialData",
  "defaultKeyStatistics",
  "summaryDetail",
  "earningsTrend",
  "calendarEvents",
  "cashflowStatementHistory",
  "incomeStatementHistory",
  "balanceSheetHistory",
];

type RefreshResult = {
  ticker: string;
  name?: string;
  sector?: string;
  price?: number;
  technicals?: TechnicalIndicators;
  healthData?: HealthData;
  riskAlert?: RiskAlert;
  error?: string;
};

async function refreshSingleStock(
  ticker: string,
  auth: { cookie: string; crumb: string } | null
): Promise<RefreshResult> {
  try {
    // Fetch price history and Yahoo modules in parallel
    const [priceHistory, modules] = await Promise.all([
      fetchPriceHistory(ticker),
      auth ? fetchYahooModules(ticker, HEALTH_MODULES, auth.cookie, auth.crumb) : Promise.resolve(null),
    ]);

    // Current price from chart data
    let price: number | undefined;
    if (priceHistory.length > 0) {
      price = priceHistory[priceHistory.length - 1].close;
    }

    // Extract price from modules if chart didn't give it
    if (!price && modules) {
      const financial = modules.financialData as Record<string, Record<string, unknown>> | undefined;
      price = financial?.currentPrice?.raw as number | undefined;
    }

    // Extract company name and sector
    let name: string | undefined;
    let sector: string | undefined;
    if (modules) {
      const priceModule = modules.price as Record<string, Record<string, unknown>> | undefined;
      const profile = modules.assetProfile as Record<string, unknown> | undefined;
      name = (priceModule?.shortName as unknown as string) || (priceModule?.longName as unknown as string) || undefined;
      sector = (profile?.sector as string) || undefined;
    }

    // Compute technicals
    let technicals: TechnicalIndicators | null = null;
    if (priceHistory.length > 0) {
      technicals = computeTechnicals(priceHistory);
    }

    // Extract health data
    const healthData = extractHealthData(modules ?? undefined, price);

    // Compute risk alert
    let riskAlert: RiskAlert | undefined;
    if (technicals && healthData) {
      riskAlert = computeRiskAlert(technicals, healthData);
    } else if (technicals) {
      riskAlert = computeRiskAlert(technicals);
    }

    return {
      ticker,
      name,
      sector,
      price,
      technicals: technicals ?? undefined,
      healthData,
      riskAlert,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[RefreshData] ${ticker} error:`, msg);
    return { ticker, error: msg };
  }
}

export async function POST(request: NextRequest) {
  try {
    const { tickers } = await request.json();

    if (!Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json(
        { error: "tickers array is required" },
        { status: 400 }
      );
    }

    // Cap at 50 tickers per request
    const tickerList = tickers.slice(0, 50).map((t: string) => t.toUpperCase());

    // Get Yahoo auth once for all tickers
    const auth = await getYahooCrumb();
    if (!auth) {
      console.warn("[RefreshData] Yahoo auth failed — will only have chart data");
    }

    // Process tickers sequentially to avoid Yahoo rate limits
    // (Yahoo throttles parallel requests aggressively)
    const results: RefreshResult[] = [];
    for (const ticker of tickerList) {
      const result = await refreshSingleStock(ticker, auth);
      results.push(result);
    }

    return NextResponse.json({
      results,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Refresh data API error:", message);
    return NextResponse.json(
      { error: `Failed to refresh data: ${message}` },
      { status: 500 }
    );
  }
}
