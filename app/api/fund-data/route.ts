import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
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

// ── Morningstar helpers ──

type MorningstarLookup = {
  secId: string;
  performanceId: string; // Yahoo ticker base (append .TO)
  name: string;
};

type MorningstarETFLookup = {
  secId: string;
  exchange: string;
  name: string;
};

// Map Morningstar search exchange codes to screener universe IDs
const EXCHANGE_TO_UNIVERSE: Record<string, string> = {
  ARCA: "ETEXG$ARCX",
  NAS: "ETEXG$XNAS",
  NASDAQ: "ETEXG$XNAS",
  NYSE: "ETEXG$XNYS",
  BATS: "ETEXG$BATS",
  TSX: "ETEXG$XTSE",
};

/**
 * Look up any ETF ticker on Morningstar to get SecId and exchange.
 */
async function lookupMorningstarETF(ticker: string): Promise<MorningstarETFLookup | null> {
  try {
    const cleanTicker = ticker.replace(/\.TO$/i, "");
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(cleanTicker)}&limit=10`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const tickerUpper = cleanTicker.toUpperCase();

    for (const line of text.trim().split("\n")) {
      const parts = line.split("|");
      if (parts.length < 4) continue;
      // Only match ETFs (type indicator after the pipe-delimited fields)
      if (!line.includes("|ETF|")) continue;
      const jsonPart = parts.find((p) => p.startsWith("{"));
      if (!jsonPart) continue;
      try {
        const meta = JSON.parse(jsonPart);
        // Exact ticker match
        if (meta.s?.toUpperCase() === tickerUpper) {
          return {
            secId: meta.i || "",
            exchange: meta.e || "",
            name: meta.n || parts[0] || "",
          };
        }
      } catch { continue; }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Scrape top holdings from Morningstar.com quote page.
 * Works for US ETFs — page contains server-rendered top 10 holdings with weights and sectors.
 * URL: https://www.morningstar.com/etfs/{exchange}/{ticker}/quote
 */
async function fetchMorningstarHoldings(
  ticker: string,
  exchange: string
): Promise<{ topHoldings?: FundHolding[]; sectorWeightings?: FundSectorWeight[] }> {
  const result: { topHoldings?: FundHolding[]; sectorWeightings?: FundSectorWeight[] } = {};

  // Map search exchange to Morningstar URL exchange code
  const exchangeMap: Record<string, string> = {
    ARCA: "arcx", NAS: "xnas", NASDAQ: "xnas", NYSE: "xnys", BATS: "bats",
  };
  const msExchange = exchangeMap[exchange];
  if (!msExchange) return result;

  try {
    const cleanTicker = ticker.replace(/\.TO$/i, "").toLowerCase();
    const url = `https://www.morningstar.com/etfs/${msExchange}/${cleanTicker}/quote`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return result;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse top holdings from table rows with class "mdc-table-row"
    // Each row has cells: Name, Weight, MarketValue, Sector
    const holdings: FundHolding[] = [];
    const sectorCounts: Record<string, number> = {};

    // Find the section containing "Top 10 Holdings" and get its table rows
    const holdingsSection = $("*:contains('Top 10 Holdings')").last().closest("div");
    const rows = holdingsSection.find("tr[class*='mdc-table-row']");

    rows.each((_, row) => {
      if (holdings.length >= 10) return;
      const cells = $(row).find("td");
      if (cells.length < 2) return;

      const cellTexts: string[] = [];
      cells.each((__, cell) => {
        const text = $(cell).text().trim().replace(/\s+/g, " ");
        if (text) cellTexts.push(text);
      });

      // Expect: [Name, Weight, MarketValue, Sector]
      if (cellTexts.length >= 2) {
        const name = cellTexts[0];
        const weight = parseFloat(cellTexts[1]);
        if (!isFinite(weight)) return;
        const sector = cellTexts.length >= 4 ? cellTexts[3] : "";

        holdings.push({ symbol: "", name, weight });
        if (sector) {
          sectorCounts[sector] = (sectorCounts[sector] || 0) + weight;
        }
      }
    });

    if (holdings.length > 0) result.topHoldings = holdings;

    // Build sector weightings from holdings
    if (Object.keys(sectorCounts).length > 0) {
      result.sectorWeightings = Object.entries(sectorCounts)
        .map(([sector, weight]) => ({ sector, weight: parseFloat(weight.toFixed(2)) }))
        .sort((a, b) => b.weight - a.weight);
    }
  } catch {
    /* best effort */
  }

  return result;
}

/**
 * Fetch performance data for an ETF from Morningstar screener API.
 */
async function fetchMorningstarETFData(secId: string, exchange: string): Promise<MorningstarScreenerData> {
  const result: MorningstarScreenerData = {};
  const universeId = EXCHANGE_TO_UNIVERSE[exchange];
  if (!universeId) return result;

  try {
    const dataPoints = [
      // Identifiers & metadata
      "SecId", "Name", "ProspectusNetExpenseRatio", "FundTNAV", "StarRatingM255",
      "CategoryName", "Yield_M12",
      // Performance returns
      "GBRReturnM0", "GBRReturnM1", "GBRReturnM3", "GBRReturnM6",
      "GBRReturnM12", "GBRReturnM36", "GBRReturnM60", "GBRReturnM120",
      // Risk statistics (3-year)
      "AlphaM36", "BetaM36", "SharpeM36", "StandardDeviationM36",
      "R2M36", "SortinoM36", "MaxDrawdownM36",
      // Equity portfolio metrics
      "PERatio", "PBRatio", "PSRatio", "PCFRatio",
    ].join(",");

    const url = `https://lt.morningstar.com/api/rest.svc/9vehuxllxs/security/screener?outputType=json&page=1&pageSize=1&securityDataPoints=${dataPoints}&universeIds=${encodeURIComponent(universeId)}&filters=SecId:IN:${encodeURIComponent(secId)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return result;

    const data = await res.json();
    const row = data?.rows?.[0];
    if (!row) return result;

    result.name = row.Name || undefined;
    result.mer = typeof row.ProspectusNetExpenseRatio === "number" ? row.ProspectusNetExpenseRatio : undefined;
    result.totalAssets = typeof row.FundTNAV === "number" ? row.FundTNAV : undefined;
    result.category = row.CategoryName || undefined;
    result.starRating = typeof row.StarRatingM255 === "number" ? row.StarRatingM255 : undefined;
    result.yield12m = typeof row.Yield_M12 === "number" ? row.Yield_M12 : undefined;

    // Performance
    const perf: FundPerformance = {};
    if (typeof row.GBRReturnM0 === "number") perf.ytd = row.GBRReturnM0;
    if (typeof row.GBRReturnM1 === "number") perf.oneMonth = row.GBRReturnM1;
    if (typeof row.GBRReturnM3 === "number") perf.threeMonth = row.GBRReturnM3;
    if (typeof row.GBRReturnM12 === "number") perf.oneYear = row.GBRReturnM12;
    if (typeof row.GBRReturnM36 === "number") perf.threeYear = row.GBRReturnM36;
    if (typeof row.GBRReturnM60 === "number") perf.fiveYear = row.GBRReturnM60;
    if (typeof row.GBRReturnM120 === "number") perf.tenYear = row.GBRReturnM120;
    if (Object.keys(perf).length > 0) result.performance = perf;

    // Risk stats (3-year)
    const rs: FundRiskStats = {};
    if (typeof row.AlphaM36 === "number") rs.alpha = row.AlphaM36;
    if (typeof row.BetaM36 === "number") rs.beta = row.BetaM36;
    if (typeof row.SharpeM36 === "number") rs.sharpeRatio = row.SharpeM36;
    if (typeof row.StandardDeviationM36 === "number") rs.stdDev = row.StandardDeviationM36;
    if (typeof row.R2M36 === "number") rs.rSquared = row.R2M36;
    if (Object.keys(rs).length > 0) result.riskStats = rs;

    // Equity metrics
    const em: NonNullable<MorningstarScreenerData["equityMetrics"]> = {};
    if (typeof row.PERatio === "number") em.priceToEarnings = row.PERatio;
    if (typeof row.PBRatio === "number") em.priceToBook = row.PBRatio;
    if (typeof row.PSRatio === "number") em.priceToSales = row.PSRatio;
    if (typeof row.PCFRatio === "number") em.priceToCashflow = row.PCFRatio;
    if (Object.keys(em).length > 0) result.equityMetrics = em;
  } catch {
    /* best effort */
  }

  return result;
}

/**
 * Resolve a FUNDSERV code (e.g. TDB900, RBF556) to Morningstar SecId and Yahoo PerformanceId.
 */
async function lookupFundservCode(code: string): Promise<MorningstarLookup | null> {
  try {
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(code)}&limit=25`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();

    // Response is pipe-delimited: name|ticker|secId|...|json
    // The JSON blob contains an `e1` field with comma-separated FUNDSERV codes
    // e.g. e1: "RBF556@7,RBF756@7" — each entry is CODE@exchangeId
    const codeUpper = code.toUpperCase();
    const lines = text.trim().split("\n");

    // First pass: exact FUNDSERV code match via the e1 JSON field
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      const jsonPart = parts.find((p) => p.startsWith("{"));
      if (!jsonPart) continue;

      try {
        const meta = JSON.parse(jsonPart);
        // e1 contains comma-separated "CODE@exchange" entries
        if (meta.e1) {
          const fundservCodes = (meta.e1 as string)
            .split(",")
            .map((entry: string) => entry.split("@")[0].trim().toUpperCase());
          if (fundservCodes.includes(codeUpper)) {
            return {
              secId: meta.i || parts[2] || "",
              performanceId: meta.pi || "",
              name: parts[0] || "",
            };
          }
        }
      } catch { continue; }
    }

    // Second pass: check if the ticker field (parts[1]) matches exactly
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      if (parts[1]?.trim().toUpperCase() === codeUpper) {
        const jsonPart = parts.find((p) => p.startsWith("{"));
        if (jsonPart) {
          try {
            const meta = JSON.parse(jsonPart);
            return {
              secId: meta.i || parts[2] || "",
              performanceId: meta.pi || "",
              name: parts[0] || "",
            };
          } catch { continue; }
        }
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
  riskStats?: FundRiskStats;
  equityMetrics?: {
    priceToEarnings?: number;
    priceToBook?: number;
    priceToSales?: number;
    priceToCashflow?: number;
  };
};

/**
 * Fetch MER, AUM, category, star rating, and returns from Morningstar Canada screener API.
 */
async function fetchMorningstarData(secId: string): Promise<MorningstarScreenerData> {
  const result: MorningstarScreenerData = {};

  try {
    const dataPoints = [
      "SecId", "Name", "ManagementExpenseRatio", "FundTNAV", "StarRatingM255",
      "CategoryName", "GBRReturnM0", "GBRReturnM1", "GBRReturnM3", "GBRReturnM6",
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
    result.mer = typeof row.ManagementExpenseRatio === "number" ? row.ManagementExpenseRatio : undefined;
    result.totalAssets = typeof row.FundTNAV === "number" ? row.FundTNAV : undefined;
    result.category = row.CategoryName || undefined;
    result.starRating = typeof row.StarRatingM255 === "number" ? row.StarRatingM255 : undefined;
    result.yield12m = typeof row.Yield_M12 === "number" ? row.Yield_M12 : undefined;
    result.price = typeof row.ClosePrice === "number" ? row.ClosePrice : undefined;
    result.currency = row.PriceCurrency || undefined;

    // Build performance from Morningstar returns
    const perf: FundPerformance = {};
    if (typeof row.GBRReturnM0 === "number") perf.ytd = row.GBRReturnM0;
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

// ── Globe and Mail scraper (performance + MER for Canadian securities) ──

type GlobeAndMailData = {
  mer?: number;
  performance?: FundPerformance;
};

/**
 * Build the Globe and Mail URL suffix for a given ticker/code.
 * - FUNDSERV codes (e.g. TDB900) → TDB900.CF
 * - TSX ETFs (e.g. XEQT or XEQT.TO) → XEQT-T
 */
function globeAndMailSymbol(ticker: string): string {
  if (isFundservCode(ticker)) return `${ticker}.CF`;
  // Strip .TO suffix if present and use -T for TSX
  return `${ticker.replace(/\.TO$/i, "")}-T`;
}

/**
 * Scrape performance data and MER from Globe and Mail fund page.
 * Works for Canadian mutual funds (.CF) and TSX-listed ETFs (-T).
 */
async function fetchGlobeAndMailData(ticker: string): Promise<GlobeAndMailData> {
  const result: GlobeAndMailData = {};

  try {
    const symbol = globeAndMailSymbol(ticker);
    const url = `https://www.theglobeandmail.com/investing/markets/funds/${encodeURIComponent(symbol)}/performance/`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return result;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract MER from barchart-field with name="expenseRatio" value="0.22%"
    $("[name='expenseRatio']").each((_, el) => {
      const value = $(el).attr("value");
      if (!value) return;
      const parsed = parseFloat(value.replace("%", ""));
      if (isFinite(parsed) && result.mer == null) result.mer = parsed;
    });

    // Extract performance from data-barchart-field-type attributes
    // e.g. <... data-barchart-field-type="returnYtd"> 8.66% <...>
    const perf: FundPerformance = {};
    const fieldMap: Record<string, keyof FundPerformance> = {
      returnYtd: "ytd",
      annualReturn1y: "oneYear",
      annualReturn3y: "threeYear",
      annualReturn5y: "fiveYear",
      annualReturn10y: "tenYear",
    };

    for (const [attr, key] of Object.entries(fieldMap)) {
      // Only match fund returns, not benchmark returns
      const el = $(`[data-barchart-field-type="${attr}"]`).first();
      if (el.length) {
        const text = el.text().trim();
        const val = parseFloat(text.replace("%", ""));
        if (isFinite(val)) perf[key] = val;
      }
    }
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
  // Step 1: Resolve FUNDSERV code via Morningstar (may fail for some funds)
  const lookup = await lookupFundservCode(fundservCode);

  // Step 2: Fetch all data sources in parallel
  // Globe and Mail = primary for performance + MER (always available for FUNDSERV codes)
  // Morningstar = category, star rating, AUM, yield (requires successful lookup)
  // Yahoo = holdings, sectors, risk stats, asset allocation (requires lookup.performanceId)
  const yahooTicker = lookup?.performanceId ? `${lookup.performanceId}.TO` : undefined;

  const [gmData, msData, yahooData] = await Promise.all([
    fetchGlobeAndMailData(fundservCode),
    lookup?.secId ? fetchMorningstarData(lookup.secId) : Promise.resolve({} as MorningstarScreenerData),
    (async (): Promise<FundData> => {
      if (!yahooTicker || !auth) return {};
      try {
        const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${FUND_MODULES.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
        const res = await fetch(url, {
          cache: "no-store",
          headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
        });
        if (res.ok) {
          const data = await res.json();
          const result = data?.quoteSummary?.result?.[0];
          if (result) return extractYahooFundData(result);
        }
      } catch { /* Yahoo data is supplementary */ }
      return {};
    })(),
  ]);

  // If no data source returned anything useful, give up
  if (!gmData.performance && !gmData.mer && !msData.performance && !msData.mer && !yahooData.performance) {
    return null;
  }

  // Step 3: Merge — Globe and Mail is primary for performance + MER,
  // Morningstar fills gaps, Yahoo is supplementary
  let mergedPerformance: FundPerformance | undefined;
  if (gmData.performance || msData.performance || yahooData.performance) {
    mergedPerformance = {
      ytd: gmData.performance?.ytd ?? msData.performance?.ytd ?? yahooData.performance?.ytd,
      oneMonth: gmData.performance?.oneMonth ?? msData.performance?.oneMonth ?? yahooData.performance?.oneMonth,
      threeMonth: gmData.performance?.threeMonth ?? msData.performance?.threeMonth ?? yahooData.performance?.threeMonth,
      oneYear: gmData.performance?.oneYear ?? msData.performance?.oneYear ?? yahooData.performance?.oneYear,
      threeYear: gmData.performance?.threeYear ?? msData.performance?.threeYear ?? yahooData.performance?.threeYear,
      fiveYear: gmData.performance?.fiveYear ?? msData.performance?.fiveYear ?? yahooData.performance?.fiveYear,
      tenYear: gmData.performance?.tenYear ?? msData.performance?.tenYear ?? yahooData.performance?.tenYear,
    };
  }

  const fundData: FundData = {
    // Globe and Mail is primary for MER, Morningstar fallback
    expenseRatio: gmData.mer ?? msData.mer ?? yahooData.expenseRatio,
    // Morningstar is authoritative for these
    totalAssets: msData.totalAssets ?? yahooData.totalAssets,
    category: msData.category ?? yahooData.category,
    yield: msData.yield12m ?? yahooData.yield,
    starRating: msData.starRating,
    // Performance: Globe and Mail primary, Morningstar + Yahoo fill gaps
    performance: mergedPerformance,
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
    name: msData.name || lookup?.name,
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

  // Regular ETF — Yahoo for holdings/risk, Morningstar or Globe and Mail for performance
  if (!auth) {
    return NextResponse.json(
      { error: "Failed to authenticate with Yahoo Finance" },
      { status: 502 }
    );
  }

  try {
    const isCanadianETF = ticker.endsWith(".TO");

    // Fetch Yahoo + performance source in parallel
    // Canadian ETFs: Globe and Mail for performance
    // US/other ETFs: Morningstar for performance (via SecuritySearch → screener)
    const [yahooRes, gmData, msETFLookup] = await Promise.all([
      fetch(
        `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${FUND_MODULES.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`,
        {
          cache: "no-store",
          headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
        }
      ),
      isCanadianETF ? fetchGlobeAndMailData(ticker) : Promise.resolve({} as GlobeAndMailData),
      !isCanadianETF ? lookupMorningstarETF(ticker) : Promise.resolve(null),
    ]);

    // For US ETFs, fetch Morningstar screener data + holdings in parallel
    const [msData, msHoldings] = msETFLookup
      ? await Promise.all([
          fetchMorningstarETFData(msETFLookup.secId, msETFLookup.exchange),
          fetchMorningstarHoldings(ticker, msETFLookup.exchange),
        ])
      : [{} as MorningstarScreenerData, {} as Awaited<ReturnType<typeof fetchMorningstarHoldings>>];

    if (!yahooRes.ok) {
      return NextResponse.json(
        { error: `Yahoo Finance returned ${yahooRes.status}` },
        { status: 502 }
      );
    }

    const data = await yahooRes.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      return NextResponse.json(
        { error: "No data returned for ticker" },
        { status: 404 }
      );
    }

    const fundData = extractYahooFundData(result);

    // Merge performance: primary source wins, Yahoo fills gaps
    const yp = fundData.performance || {};
    if (isCanadianETF && (gmData.performance || gmData.mer != null)) {
      // Canadian ETFs: Globe and Mail is primary
      const gm = gmData.performance || {};
      fundData.performance = {
        ytd: gm.ytd ?? yp.ytd,
        oneMonth: yp.oneMonth,
        threeMonth: yp.threeMonth,
        oneYear: gm.oneYear ?? yp.oneYear,
        threeYear: gm.threeYear ?? yp.threeYear,
        fiveYear: gm.fiveYear ?? yp.fiveYear,
        tenYear: gm.tenYear ?? yp.tenYear,
      };
      if (gmData.mer != null) fundData.expenseRatio = gmData.mer;
    } else if (msData.performance) {
      // US/other ETFs: Morningstar is primary
      const ms = msData.performance;
      fundData.performance = {
        ytd: ms.ytd ?? yp.ytd,
        oneMonth: ms.oneMonth ?? yp.oneMonth,
        threeMonth: ms.threeMonth ?? yp.threeMonth,
        oneYear: ms.oneYear ?? yp.oneYear,
        threeYear: ms.threeYear ?? yp.threeYear,
        fiveYear: ms.fiveYear ?? yp.fiveYear,
        tenYear: ms.tenYear ?? yp.tenYear,
      };
    }
    // Morningstar is authoritative for these fields (overrides Yahoo)
    if (msData.category) fundData.category = msData.category;
    if (msData.starRating != null) fundData.starRating = msData.starRating;
    if (msData.mer != null) fundData.expenseRatio = msData.mer;
    if (msData.totalAssets != null) fundData.totalAssets = msData.totalAssets;
    if (msData.yield12m != null) fundData.yield = msData.yield12m;
    if (msData.riskStats) fundData.riskStats = msData.riskStats;
    if (msData.equityMetrics) fundData.equityMetrics = msData.equityMetrics;
    // Morningstar holdings override Yahoo (when available)
    if (msHoldings.topHoldings?.length) fundData.topHoldings = msHoldings.topHoldings;
    if (msHoldings.sectorWeightings?.length) fundData.sectorWeightings = msHoldings.sectorWeightings;

    return NextResponse.json({ ticker, fundData });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch fund data: ${message}` },
      { status: 500 }
    );
  }
}
