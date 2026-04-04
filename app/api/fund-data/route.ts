import { NextRequest, NextResponse } from "next/server";
import type { FundData, FundHolding, FundSectorWeight, FundPerformance, FundRiskStats } from "@/app/lib/types";

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

// Sector name mapping from Yahoo's camelCase keys
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

function extractFundData(modules: Record<string, unknown>): FundData {
  const keyStats = modules.defaultKeyStatistics as any;
  const fundProfile = modules.fundProfile as any;
  const topHoldings = modules.topHoldings as any;
  const fundPerf = modules.fundPerformance as any;
  const summary = modules.summaryDetail as any;

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
    if (expenseRatio != null && expenseRatio < 1) expenseRatio = expenseRatio * 100; // Convert to percentage if needed
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
    const extractReturns = (source: any, catSource?: any): { fund: FundPerformance; cat?: FundPerformance } => {
      const fund: FundPerformance = {};
      let cat: FundPerformance | undefined;

      if (source) {
        fund.ytd = rawVal(source, "ytdReturnPct");
        fund.oneYear = rawVal(source, "oneYearTotalReturn");
        fund.threeYear = rawVal(source, "threeYearTotalReturn");
        fund.fiveYear = rawVal(source, "fiveYrAvgReturnPct");
      }

      // Trailing returns have more granularity
      if (trailingReturns) {
        const tr = trailingReturns;
        if (fund.ytd == null) fund.ytd = rawVal(tr, "ytd");
        fund.oneMonth = rawVal(tr, "oneMonth");
        fund.threeMonth = rawVal(tr, "threeMonth");
        if (fund.oneYear == null) fund.oneYear = rawVal(tr, "oneYear");
        if (fund.threeYear == null) fund.threeYear = rawVal(tr, "threeYear");
        if (fund.fiveYear == null) fund.fiveYear = rawVal(tr, "fiveYear");
        fund.tenYear = rawVal(tr, "tenYear");
      }

      // Category comparison
      if (catSource) {
        cat = {
          ytd: rawVal(catSource, "ytd"),
          oneMonth: rawVal(catSource, "oneMonth"),
          threeMonth: rawVal(catSource, "threeMonth"),
          oneYear: rawVal(catSource, "oneYear"),
          threeYear: rawVal(catSource, "threeYear"),
          fiveYear: rawVal(catSource, "fiveYear"),
          tenYear: rawVal(catSource, "tenYear"),
        };
      }

      return { fund, cat };
    };

    const result = extractReturns(perfOverview, trailingReturns);
    performance = result.fund;
    categoryPerformance = result.cat;
  }

  // Risk stats
  let riskStats: FundRiskStats | undefined;
  const riskOverview = fundPerf?.riskOverviewStatistics;
  if (riskOverview) {
    // Take 3-year stats (usually the most commonly referenced)
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
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();

  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const auth = await getYahooCrumb();
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

    const fundData = extractFundData(result);
    return NextResponse.json({ ticker, fundData });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch fund data: ${message}` },
      { status: 500 }
    );
  }
}
