import { NextRequest, NextResponse } from "next/server";
import type { FundData, FundHolding, FundSectorWeight, FundPerformance, FundRiskStats } from "@/app/lib/types";

const YAHOO_BASE = "https://query2.finance.yahoo.com";

// ── Yahoo Finance helpers ──

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
function rawVal(obj: any, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k]?.raw ?? obj?.[k];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

const FUND_MODULES = [
  "defaultKeyStatistics",
  "fundProfile",
  "topHoldings",
  "fundPerformance",
  "summaryDetail",
];

const SECTOR_NAME_MAP: Record<string, string> = {
  realestate: "Real Estate",
  consumer_cyclical: "Consumer Discretionary",
  basic_materials: "Materials",
  consumer_defensive: "Consumer Staples",
  technology: "Technology",
  communication_services: "Communication Services",
  financial_services: "Financials",
  utilities: "Utilities",
  industrials: "Industrials",
  energy: "Energy",
  healthcare: "Health Care",
};

// ── Morningstar Canada helpers ──

type MorningstarLookup = {
  secId: string;
  performanceId: string; // Yahoo ticker base (append .TO)
  name: string;
};

/**
 * Resolve a FUNDSERV code (e.g. TDB900, RBF556) to Morningstar SecId and Yahoo PerformanceId.
 */
async function lookupFundservCode(code: string): Promise<MorningstarLookup | null> {
  try {
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(code)}&limit=10`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();

    // Response is pipe-delimited: name|ticker|secId|...|json
    // Parse each line looking for a match
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      // The JSON blob is typically the last part
      const jsonPart = parts.find((p) => p.startsWith("{"));
      if (!jsonPart) continue;

      try {
        const meta = JSON.parse(jsonPart);
        // Match: check if the line contains the FUNDSERV code
        const lineUpper = line.toUpperCase();
        if (lineUpper.includes(code.toUpperCase()) || meta.i) {
          return {
            secId: meta.i || parts[2] || "",
            performanceId: meta.pi || "",
            name: parts[0] || "",
          };
        }
      } catch { continue; }
    }

    // Fallback: try first result
    if (lines.length > 0 && lines[0].includes("|")) {
      const parts = lines[0].split("|");
      const jsonPart = parts.find((p) => p.startsWith("{"));
      if (jsonPart) {
        try {
          const meta = JSON.parse(jsonPart);
          return {
            secId: meta.i || parts[2] || "",
            performanceId: meta.pi || "",
            name: parts[0] || "",
          };
        } catch { /* ignore */ }
      }
    }

    return null;
  } catch {
    return null;
  }
}

type MorningstarScreenerData = {
  mer?: number;
  totalAssets?: number;
  category?: string;
  starRating?: number;
  yield12m?: number;
  price?: number;
  currency?: string;
  performance?: FundPerformance;
  name?: string;
};

/**
 * Fetch MER, AUM, category, star rating, and returns from Morningstar Canada screener API.
 */
async function fetchMorningstarData(secId: string): Promise<MorningstarScreenerData> {
  const result: MorningstarScreenerData = {};

  try {
    const dataPoints = [
      "SecId", "Name", "ManagementFee", "FundTNAV", "StarRatingM255",
      "CategoryName", "GBRReturnM1", "GBRReturnM3", "GBRReturnM6",
      "GBRReturnM12", "GBRReturnM36", "GBRReturnM60", "GBRReturnM120",
      "Yield_M12", "ClosePrice", "PriceCurrency",
    ].join(",");

    const url = `https://lt.morningstar.com/api/rest.svc/9vehuxllxs/security/screener?outputType=json&page=1&pageSize=1&securityDataPoints=${dataPoints}&universeIds=FOCAN$$ALL&filters=SecId:IN:${encodeURIComponent(secId)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return result;

    const data = await res.json();
    const row = data?.rows?.[0];
    if (!row) return result;

    result.name = row.Name || undefined;
    result.mer = typeof row.ManagementFee === "number" ? row.ManagementFee : undefined;
    result.totalAssets = typeof row.FundTNAV === "number" ? row.FundTNAV : undefined;
    result.category = row.CategoryName || undefined;
    result.starRating = typeof row.StarRatingM255 === "number" ? row.StarRatingM255 : undefined;
    result.yield12m = typeof row.Yield_M12 === "number" ? row.Yield_M12 : undefined;
    result.price = typeof row.ClosePrice === "number" ? row.ClosePrice : undefined;
    result.currency = row.PriceCurrency || undefined;

    // Build performance from Morningstar returns
    const perf: FundPerformance = {};
    if (typeof row.GBRReturnM1 === "number") perf.oneMonth = row.GBRReturnM1;
    if (typeof row.GBRReturnM3 === "number") perf.threeMonth = row.GBRReturnM3;
    if (typeof row.GBRReturnM12 === "number") perf.oneYear = row.GBRReturnM12;
    if (typeof row.GBRReturnM36 === "number") perf.threeYear = row.GBRReturnM36;
    if (typeof row.GBRReturnM60 === "number") perf.fiveYear = row.GBRReturnM60;
    if (typeof row.GBRReturnM120 === "number") perf.tenYear = row.GBRReturnM120;
    if (Object.keys(perf).length > 0) result.performance = perf;
  } catch {
    /* best effort */
  }

  return result;
}

// ── Yahoo data extraction (shared for both ETFs and Canadian funds) ──

function extractYahooFundData(modules: Record<string, unknown>): FundData {
  const keyStats = modules.defaultKeyStatistics as any;
  const fundProfile = modules.fundProfile as any;
  const topHoldings = modules.topHoldings as any;
  const fundPerf = modules.fundPerformance as any;

  // Key stats
  const totalAssets = rawVal(keyStats, "totalAssets");
  const yieldVal = rawVal(keyStats, "yield") != null ? (rawVal(keyStats, "yield")! * 100) : undefined;
  const category = keyStats?.category || undefined;
  const fundFamily = keyStats?.fundFamily || fundProfile?.family || undefined;

  let inceptionDate: string | undefined;
  const inception = rawVal(keyStats, "fundInceptionDate");
  if (inception) {
    inceptionDate = new Date(inception * 1000).toISOString().split("T")[0];
  }

  // Expense ratio from fundProfile
  let expenseRatio: number | undefined;
  let turnover: number | undefined;
  const fees = fundProfile?.feesExpensesInvestment;
  if (fees) {
    expenseRatio = rawVal(fees, "annualReportExpenseRatio", "netExpRatio");
    if (expenseRatio != null && expenseRatio < 1) expenseRatio = expenseRatio * 100;
    turnover = rawVal(fees, "annualHoldingsTurnover");
    if (turnover != null && turnover < 1) turnover = turnover * 100;
  }

  // Top holdings
  let holdings: FundHolding[] | undefined;
  if (Array.isArray(topHoldings?.holdings)) {
    holdings = topHoldings.holdings
      .filter((h: any) => h.symbol || h.holdingName)
      .map((h: any) => ({
        symbol: h.symbol || "",
        name: h.holdingName || h.symbol || "",
        weight: rawVal(h, "holdingPercent") != null ? parseFloat((rawVal(h, "holdingPercent")! * 100).toFixed(2)) : 0,
      }));
  }

  // Sector weightings
  let sectorWeightings: FundSectorWeight[] | undefined;
  if (Array.isArray(topHoldings?.sectorWeightings)) {
    sectorWeightings = [];
    for (const sw of topHoldings.sectorWeightings) {
      for (const [key, val] of Object.entries(sw)) {
        const weight = rawVal(val as any, "raw") ?? rawVal({ v: val } as any, "v");
        const pct = weight != null ? parseFloat((weight * 100).toFixed(2)) : 0;
        if (pct > 0) {
          sectorWeightings.push({
            sector: SECTOR_NAME_MAP[key] || key,
            weight: pct,
          });
        }
      }
    }
    sectorWeightings.sort((a, b) => b.weight - a.weight);
  }

  // Asset allocation
  let assetAllocation: FundData["assetAllocation"];
  const stockPos = rawVal(topHoldings, "stockPosition");
  const bondPos = rawVal(topHoldings, "bondPosition");
  const cashPos = rawVal(topHoldings, "cashPosition");
  const otherPos = rawVal(topHoldings, "otherPosition");
  if (stockPos != null || bondPos != null || cashPos != null) {
    assetAllocation = {
      stock: stockPos != null ? parseFloat((stockPos * 100).toFixed(2)) : undefined,
      bond: bondPos != null ? parseFloat((bondPos * 100).toFixed(2)) : undefined,
      cash: cashPos != null ? parseFloat((cashPos * 100).toFixed(2)) : undefined,
      other: otherPos != null ? parseFloat((otherPos * 100).toFixed(2)) : undefined,
    };
  }

  // Equity metrics
  let equityMetrics: FundData["equityMetrics"];
  const eqH = topHoldings?.equityHoldings;
  if (eqH) {
    equityMetrics = {
      priceToEarnings: rawVal(eqH, "priceToEarnings"),
      priceToBook: rawVal(eqH, "priceToBook"),
      priceToSales: rawVal(eqH, "priceToSales"),
      priceToCashflow: rawVal(eqH, "priceToCashflow"),
    };
  }

  // Fund performance
  let performance: FundPerformance | undefined;
  let categoryPerformance: FundPerformance | undefined;
  const perfOverview = fundPerf?.performanceOverview;
  const trailingReturns = fundPerf?.trailingReturns;

  if (perfOverview || trailingReturns) {
    const fund: FundPerformance = {};
    if (perfOverview) {
      fund.ytd = rawVal(perfOverview, "ytdReturnPct");
      fund.oneYear = rawVal(perfOverview, "oneYearTotalReturn");
      fund.threeYear = rawVal(perfOverview, "threeYearTotalReturn");
      fund.fiveYear = rawVal(perfOverview, "fiveYrAvgReturnPct");
    }
    if (trailingReturns) {
      if (fund.ytd == null) fund.ytd = rawVal(trailingReturns, "ytd");
      fund.oneMonth = rawVal(trailingReturns, "oneMonth");
      fund.threeMonth = rawVal(trailingReturns, "threeMonth");
      if (fund.oneYear == null) fund.oneYear = rawVal(trailingReturns, "oneYear");
      if (fund.threeYear == null) fund.threeYear = rawVal(trailingReturns, "threeYear");
      if (fund.fiveYear == null) fund.fiveYear = rawVal(trailingReturns, "fiveYear");
      fund.tenYear = rawVal(trailingReturns, "tenYear");

      categoryPerformance = {
        ytd: rawVal(trailingReturns, "ytd"),
        oneMonth: rawVal(trailingReturns, "oneMonth"),
        threeMonth: rawVal(trailingReturns, "threeMonth"),
        oneYear: rawVal(trailingReturns, "oneYear"),
        threeYear: rawVal(trailingReturns, "threeYear"),
        fiveYear: rawVal(trailingReturns, "fiveYear"),
        tenYear: rawVal(trailingReturns, "tenYear"),
      };
    }
    performance = fund;
  }

  // Risk stats
  let riskStats: FundRiskStats | undefined;
  const riskOverview = fundPerf?.riskOverviewStatistics;
  if (riskOverview) {
    const threeYr = Array.isArray(riskOverview.riskStatistics)
      ? riskOverview.riskStatistics.find((r: any) => r.year === "3y")
      : undefined;
    if (threeYr) {
      riskStats = {
        alpha: rawVal(threeYr, "alpha"),
        beta: rawVal(threeYr, "beta"),
        sharpeRatio: rawVal(threeYr, "sharpeRatio"),
        treynorRatio: rawVal(threeYr, "treynorRatio"),
        rSquared: rawVal(threeYr, "rSquared"),
        stdDev: rawVal(threeYr, "stdDev"),
      };
    }
  }

  return {
    expenseRatio,
    totalAssets,
    yield: yieldVal,
    category,
    fundFamily,
    inceptionDate,
    turnover,
    topHoldings: holdings,
    sectorWeightings,
    assetAllocation,
    performance,
    categoryPerformance,
    riskStats,
    equityMetrics,
    lastUpdated: new Date().toISOString(),
  };
}

// ── Detect if a ticker looks like a FUNDSERV code ──
// FUNDSERV codes are typically 3-letter prefix + 3-4 digit number (e.g., TDB900, RBF556, CIG686, FID300)
function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

// ── Fetch fund data for a Canadian mutual fund via FUNDSERV code ──
async function fetchCanadianFundData(
  fundservCode: string,
  auth: { cookie: string; crumb: string } | null
): Promise<{ fundData: FundData; yahooTicker?: string; name?: string } | null> {
  // Step 1: Resolve FUNDSERV code via Morningstar
  const lookup = await lookupFundservCode(fundservCode);
  if (!lookup || !lookup.secId) {
    console.warn(`[FundData] Could not resolve FUNDSERV code: ${fundservCode}`);
    return null;
  }

  // Step 2: Fetch Morningstar screener data (MER, AUM, category, returns)
  const msData = await fetchMorningstarData(lookup.secId);

  // Step 3: Fetch Yahoo data for holdings/sectors/risk if we have a performance ID
  let yahooData: FundData = {};
  const yahooTicker = lookup.performanceId ? `${lookup.performanceId}.TO` : undefined;

  if (yahooTicker && auth) {
    try {
      const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${FUND_MODULES.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
      });
      if (res.ok) {
        const data = await res.json();
        const result = data?.quoteSummary?.result?.[0];
        if (result) {
          yahooData = extractYahooFundData(result);
        }
      }
    } catch {
      /* Yahoo data is supplementary */
    }
  }

  // Step 4: Merge — Morningstar wins for MER/category (Yahoo returns 0 for Canadian MER)
  const fundData: FundData = {
    // Morningstar is authoritative for these
    expenseRatio: msData.mer ?? yahooData.expenseRatio,
    totalAssets: msData.totalAssets ?? yahooData.totalAssets,
    category: msData.category ?? yahooData.category,
    yield: msData.yield12m ?? yahooData.yield,
    starRating: msData.starRating,
    // Performance: prefer Morningstar (annualized), fall back to Yahoo
    performance: msData.performance ?? yahooData.performance,
    // Yahoo is authoritative for these
    fundFamily: yahooData.fundFamily,
    inceptionDate: yahooData.inceptionDate,
    turnover: yahooData.turnover,
    topHoldings: yahooData.topHoldings,
    sectorWeightings: yahooData.sectorWeightings,
    assetAllocation: yahooData.assetAllocation,
    categoryPerformance: yahooData.categoryPerformance,
    riskStats: yahooData.riskStats,
    equityMetrics: yahooData.equityMetrics,
    lastUpdated: new Date().toISOString(),
  };

  return {
    fundData,
    yahooTicker,
    name: msData.name || lookup.name,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── API handler ──

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();

  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const auth = await getYahooCrumb();

  // Check if this is a FUNDSERV code (Canadian mutual fund)
  if (isFundservCode(ticker)) {
    const result = await fetchCanadianFundData(ticker, auth);
    if (!result) {
      return NextResponse.json(
        { error: `Could not find Canadian fund data for FUNDSERV code: ${ticker}` },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ticker,
      fundData: result.fundData,
      yahooTicker: result.yahooTicker,
      name: result.name,
    });
  }

  // Regular ETF / US mutual fund — use Yahoo directly
  if (!auth) {
    return NextResponse.json(
      { error: "Failed to authenticate with Yahoo Finance" },
      { status: 502 }
    );
  }

  try {
    const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${FUND_MODULES.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Yahoo Finance returned ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      return NextResponse.json(
        { error: "No data returned for ticker" },
        { status: 404 }
      );
    }

    const fundData = extractYahooFundData(result);
    return NextResponse.json({ ticker, fundData });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch fund data: ${message}` },
      { status: 500 }
    );
  }
}
