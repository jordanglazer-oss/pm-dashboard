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

/**
 * Calculate real-time YTD price return from Yahoo chart data.
 * Uses close prices (Dec 31 → current regularMarketPrice).
 *
 * This is price return only (excludes distributions), but for YTD the error is
 * typically small (<1% for most ETFs) and the real-time freshness is valuable —
 * API sources (Globe and Mail, Morningstar, Yahoo trailingReturns) report
 * month-end YTD which can be stale.
 *
 * For 1Y/3Y/5Y/10Y we rely on Yahoo trailingReturns (total return, month-end)
 * rather than chart calculations, because Yahoo's adjclose data is unreliable
 * for some securities (e.g., Canadian ETFs with large capital gains distributions
 * produce inflated adjclose-based returns).
 */
async function calculateRealtimeYTD(
  ticker: string,
  auth: { cookie: string; crumb: string }
): Promise<number | undefined> {
  try {
    const currentYear = new Date().getFullYear();
    // Fetch prices around Dec 31 of previous year and recent days
    const dec29 = Math.floor(new Date(`${currentYear - 1}-12-29`).getTime() / 1000);
    const jan3 = Math.floor(new Date(`${currentYear}-01-03`).getTime() / 1000);

    const [histRes, currentRes] = await Promise.all([
      fetch(
        `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${dec29}&period2=${jan3}&interval=1d&crumb=${encodeURIComponent(auth.crumb)}`,
        { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie } }
      ),
      fetch(
        `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&crumb=${encodeURIComponent(auth.crumb)}`,
        { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie } }
      ),
    ]);

    if (!histRes.ok || !currentRes.ok) return undefined;
    const [histData, currentData] = await Promise.all([histRes.json(), currentRes.json()]);

    // Find Dec 31 (or last trading day before it) close price
    const closes = histData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close as number[] | undefined;
    const timestamps = histData?.chart?.result?.[0]?.timestamp as number[] | undefined;
    let dec31Close: number | undefined;
    if (closes && timestamps) {
      for (let i = timestamps.length - 1; i >= 0; i--) {
        const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
        if (date <= `${currentYear - 1}-12-31` && closes[i] != null && isFinite(closes[i])) {
          dec31Close = closes[i];
          break;
        }
      }
    }

    // Get current market price
    const currentPrice = currentData?.chart?.result?.[0]?.meta?.regularMarketPrice as number | undefined;

    if (dec31Close && currentPrice && dec31Close > 0) {
      return parseFloat(((currentPrice - dec31Close) / dec31Close * 100).toFixed(2));
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

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
  // Yahoo returns performance values as decimals (0.22 = 22%).
  // Convert to percentages for consistency with Globe and Mail / Morningstar.
  // Prefer trailingReturns over performanceOverview — trailingReturns matches
  // Yahoo's website (monthly total returns) while performanceOverview can
  // differ and uses different calculation periods.
  let performance: FundPerformance | undefined;
  let categoryPerformance: FundPerformance | undefined;
  const perfOverview = fundPerf?.performanceOverview;
  const trailingReturns = fundPerf?.trailingReturns;

  /** Convert Yahoo decimal return to percentage (0.22 → 22.0), rounded to 2dp */
  const toPct = (v: number | undefined): number | undefined =>
    v != null ? parseFloat((v * 100).toFixed(2)) : undefined;

  if (perfOverview || trailingReturns) {
    const fund: FundPerformance = {};
    // trailingReturns is primary — matches Yahoo's website display
    if (trailingReturns) {
      fund.ytd = toPct(rawVal(trailingReturns, "ytd"));
      fund.oneMonth = toPct(rawVal(trailingReturns, "oneMonth"));
      fund.threeMonth = toPct(rawVal(trailingReturns, "threeMonth"));
      fund.oneYear = toPct(rawVal(trailingReturns, "oneYear"));
      fund.threeYear = toPct(rawVal(trailingReturns, "threeYear"));
      fund.fiveYear = toPct(rawVal(trailingReturns, "fiveYear"));
      fund.tenYear = toPct(rawVal(trailingReturns, "tenYear"));

      categoryPerformance = { ...fund };
    }
    // performanceOverview fills gaps only
    if (perfOverview) {
      if (fund.ytd == null) fund.ytd = toPct(rawVal(perfOverview, "ytdReturnPct"));
      if (fund.oneYear == null) fund.oneYear = toPct(rawVal(perfOverview, "oneYearTotalReturn"));
      if (fund.threeYear == null) fund.threeYear = toPct(rawVal(perfOverview, "threeYearTotalReturn"));
      if (fund.fiveYear == null) fund.fiveYear = toPct(rawVal(perfOverview, "fiveYrAvgReturnPct"));
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

  // Real-time YTD from chart prices — overrides stale month-end API values
  const ytdTicker = yahooTicker || fundservCode;
  if (auth && mergedPerformance) {
    const realtimeYTD = await calculateRealtimeYTD(ytdTicker, auth);
    if (realtimeYTD != null) {
      mergedPerformance.ytd = realtimeYTD;
    }
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

// ── ETF Provider-Direct Holdings ──

type ProviderHoldingsResult = {
  topHoldings?: FundHolding[];
  sectorWeightings?: FundSectorWeight[];
};

/**
 * Fetch holdings from BMO ETF JSON API.
 * Works for BMO-managed Canadian ETFs (ZSP, ZAG, ZEB, etc.)
 */
async function fetchBMOHoldings(ticker: string): Promise<ProviderHoldingsResult> {
  const result: ProviderHoldingsResult = {};
  try {
    const cleanTicker = ticker.replace(/\.TO$/i, "");
    const url = `https://tools.bmogam.com/api/etfs/holdings?symbol=XTSE:${encodeURIComponent(cleanTicker)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return result;

    const data = await res.json();
    if (data.requestStatus !== "success" || !Array.isArray(data.holdings)) return result;

    const holdings: FundHolding[] = data.holdings
      .filter((h: { securityName?: string; marketPercent?: number }) => h.securityName && typeof h.marketPercent === "number")
      .slice(0, 10)
      .map((h: { ticker?: string; securityName: string; marketPercent: number }) => ({
        symbol: h.ticker || "",
        name: h.securityName.replace(/ - Common$/, ""),
        weight: parseFloat(h.marketPercent.toFixed(2)),
      }));

    if (holdings.length > 0) result.topHoldings = holdings;

    // BMO API doesn't include sector data, so no sector weightings
  } catch {
    /* best effort */
  }
  return result;
}

/**
 * Fetch holdings from iShares CSV endpoint.
 * Works for both US and Canadian iShares ETFs.
 * US AJAX ID: 1467271812596, Canada AJAX ID: 1464253357814
 */
async function fetchISharesHoldings(ticker: string, country: "us" | "ca"): Promise<ProviderHoldingsResult> {
  const result: ProviderHoldingsResult = {};
  try {
    const cleanTicker = ticker.replace(/\.TO$/i, "").toUpperCase();

    // Step 1: Find the product page URL from the iShares/BlackRock product listing page
    // The listing page contains links like: <a href="/us/products/239726/ishares-core-sp-500-etf">IVV</a>
    const listingUrl = country === "us"
      ? `https://www.ishares.com/us/products/etf-investments`
      : `https://www.blackrock.com/ca/investors/en/products/product-list`;

    const listingRes = await fetch(listingUrl, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!listingRes.ok) return result;

    const listingHtml = await listingRes.text();

    // Use regex to find the product link — the listing has <a href="/us/products/XXXX/slug">TICKER</a>
    // Match the exact ticker as the link text (not a substring)
    const pathPrefix = country === "us" ? "/us/products/" : "/ca/investors/en/products/";
    const escapedPrefix = pathPrefix.replace(/\//g, "\\/");
    const linkRegex = new RegExp(
      `href="(${escapedPrefix}\\d+/[a-z0-9-]+)"[^>]*>${cleanTicker}<`,
      "i"
    );
    const linkMatch = linkRegex.exec(listingHtml);
    if (!linkMatch) return result;

    const productPath = linkMatch[1];

    // Step 2: Fetch the CSV using the product path and the known AJAX ID
    const ajaxId = country === "us" ? "1467271812596" : "1464253357814";
    const baseUrl = country === "us" ? "https://www.ishares.com" : "https://www.blackrock.com";
    const csvUrl = `${baseUrl}${productPath}/${ajaxId}.ajax?fileType=csv&fileName=${cleanTicker}_holdings&dataType=fund`;

    const csvRes = await fetch(csvUrl, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!csvRes.ok) return result;

    const csvText = await csvRes.text();
    const holdings = parseISharesCSV(csvText);
    if (holdings.topHoldings?.length) result.topHoldings = holdings.topHoldings;
    if (holdings.sectorWeightings?.length) result.sectorWeightings = holdings.sectorWeightings;
  } catch {
    /* best effort */
  }
  return result;
}

/**
 * Parse iShares CSV holdings data.
 * CSV has header: Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,...
 * Multiple sections may exist (separated by blank lines + new headers).
 */
function parseISharesCSV(csv: string): ProviderHoldingsResult {
  const result: ProviderHoldingsResult = {};
  const lines = csv.split("\n");

  // Find the first data header line
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("Ticker,Name,Sector")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return result;

  const holdings: FundHolding[] = [];
  const sectorWeights: Record<string, number> = {};

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Stop at the second section header (fund-of-funds underlying holdings)
    if (line.startsWith("Ticker,Name,Sector")) break;
    if (line.startsWith("Fund Holdings")) break;

    // Parse CSV line (fields may be quoted)
    const fields = parseCSVLine(line);
    if (fields.length < 6) continue;

    const ticker = fields[0].replace(/"/g, "").trim();
    const name = fields[1].replace(/"/g, "").trim();
    const sector = fields[2].replace(/"/g, "").trim();
    const assetClass = fields[3].replace(/"/g, "").trim();
    const weight = parseFloat(fields[5].replace(/"/g, "").replace(/,/g, "").trim());

    // Only include equity holdings (skip cash, derivatives, etc.)
    if (!ticker || !name || !isFinite(weight) || weight <= 0) continue;
    if (assetClass && !assetClass.includes("Equity")) continue;

    // Keep top 10 for display
    if (holdings.length < 10) {
      holdings.push({ symbol: ticker, name: titleCase(name), weight: parseFloat(weight.toFixed(2)) });
    }
    // Accumulate ALL equity sectors for complete sector weightings
    if (sector) {
      sectorWeights[sector] = (sectorWeights[sector] || 0) + weight;
    }
  }

  if (holdings.length > 0) {
    result.topHoldings = holdings;
    if (Object.keys(sectorWeights).length > 0) {
      result.sectorWeightings = Object.entries(sectorWeights)
        .map(([sector, weight]) => ({ sector, weight: parseFloat(weight.toFixed(2)) }))
        .sort((a, b) => b.weight - a.weight);
    }
  }

  return result;
}

/** Convert ALL CAPS name to Title Case (e.g. "NVIDIA CORP" → "Nvidia Corp") */
function titleCase(s: string): string {
  // Keep common abbreviations uppercase
  const keepUpper = new Set(["INC", "ETF", "LP", "LLC", "LTD", "PLC", "SA", "AG", "NV", "SE", "AB", "ASA", "ADR", "II", "III", "IV", "CORP"]);
  return s.split(" ").map(w => {
    const upper = w.replace(/[^A-Z0-9]/g, "");
    if (keepUpper.has(upper)) return w;
    if (w.length <= 1) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
}

/** Simple CSV line parser that handles quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Detect ETF provider from Yahoo's fundFamily field (or Morningstar name as fallback)
 * and fetch holdings directly from the provider's website/API.
 * Returns empty if provider is unknown or fetching fails.
 */
async function fetchProviderHoldings(
  ticker: string,
  fundFamily?: string,
  etfName?: string,
): Promise<ProviderHoldingsResult> {
  const family = (fundFamily || "").toLowerCase();
  const name = (etfName || "").toLowerCase();
  const isCanadian = ticker.endsWith(".TO");

  // BMO ETFs
  if (family.includes("bmo") || name.includes("bmo")) {
    return fetchBMOHoldings(ticker);
  }

  // iShares / BlackRock ETFs
  if (family.includes("ishares") || family.includes("blackrock") ||
      name.includes("ishares") || name.includes("blackrock")) {
    return fetchISharesHoldings(ticker, isCanadian ? "ca" : "us");
  }

  // Vanguard ETFs
  if (family.includes("vanguard") || name.includes("vanguard")) {
    return fetchVanguardHoldings(ticker, isCanadian);
  }

  // SPDR / State Street ETFs (use iShares-style approach — they also use the same BlackRock CSV pattern for some)
  // For now fall through to empty

  return {};
}

/**
 * Fetch holdings from Vanguard's JSON API.
 */
async function fetchVanguardHoldings(ticker: string, isCanadian: boolean): Promise<ProviderHoldingsResult> {
  const result: ProviderHoldingsResult = {};
  try {
    const cleanTicker = ticker.replace(/\.TO$/i, "").toUpperCase();

    if (isCanadian) {
      // Vanguard Canada uses a different site structure
      // Try scraping the product page
      const url = `https://www.vanguard.ca/en/advisor/products/products-group/etfs/${cleanTicker}`;
      const res = await fetch(url, {
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) return result;
      // Vanguard Canada pages are heavily client-rendered; best-effort scraping
      return result;
    }

    // Vanguard US — try the overview API
    // First find the portfolio ID from the product page
    const pageUrl = `https://investor.vanguard.com/investment-products/etfs/profile/${cleanTicker.toLowerCase()}`;
    const pageRes = await fetch(pageUrl, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!pageRes.ok) return result;

    const html = await pageRes.text();
    // Look for portId in the page
    const portIdMatch = html.match(/"portId"\s*:\s*"?(\d+)"?/);
    if (!portIdMatch) return result;

    const portId = portIdMatch[1];
    const apiUrl = `https://investor.vanguard.com/investment-products/etfs/profile/api/${portId}/portfolio-holding/stock`;
    const apiRes = await fetch(apiUrl, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
    });
    if (!apiRes.ok) return result;

    const apiData = await apiRes.json();
    const holdingsArray = apiData?.fund?.entity;
    if (!Array.isArray(holdingsArray)) return result;

    const holdings: FundHolding[] = holdingsArray
      .filter((h: { ticker?: string; shortName?: string; percentWeight?: number }) =>
        h.ticker && h.shortName && typeof h.percentWeight === "number"
      )
      .slice(0, 10)
      .map((h: { ticker: string; shortName: string; percentWeight: number; sectorName?: string }) => ({
        symbol: h.ticker,
        name: h.shortName,
        weight: parseFloat(h.percentWeight.toFixed(2)),
      }));

    if (holdings.length > 0) result.topHoldings = holdings;

    // Build sector weightings from holdings
    const sectorCounts: Record<string, number> = {};
    for (const h of holdingsArray) {
      if (h.sectorName && typeof h.percentWeight === "number") {
        sectorCounts[h.sectorName] = (sectorCounts[h.sectorName] || 0) + h.percentWeight;
      }
    }
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
    // Merge performance: Yahoo trailingReturns is primary (total return, matches
    // Yahoo website). Globe and Mail / Morningstar fill gaps only.
    // Yahoo values are already converted to percentages by extractYahooFundData.
    if (isCanadianETF) {
      // Canadian ETFs: Yahoo primary, Globe and Mail fills gaps
      const gm = gmData.performance || {};
      fundData.performance = {
        ytd: yp.ytd ?? gm.ytd,
        oneMonth: yp.oneMonth,
        threeMonth: yp.threeMonth,
        oneYear: yp.oneYear ?? gm.oneYear,
        threeYear: yp.threeYear ?? gm.threeYear,
        fiveYear: yp.fiveYear ?? gm.fiveYear,
        tenYear: yp.tenYear ?? gm.tenYear,
      };
      if (gmData.mer != null) fundData.expenseRatio = gmData.mer;
    } else if (msData.performance) {
      // US/other ETFs: Yahoo primary, Morningstar fills gaps
      const ms = msData.performance;
      fundData.performance = {
        ytd: yp.ytd ?? ms.ytd,
        oneMonth: yp.oneMonth ?? ms.oneMonth,
        threeMonth: yp.threeMonth ?? ms.threeMonth,
        oneYear: yp.oneYear ?? ms.oneYear,
        threeYear: yp.threeYear ?? ms.threeYear,
        fiveYear: yp.fiveYear ?? ms.fiveYear,
        tenYear: yp.tenYear ?? ms.tenYear,
      };
    }
    // Morningstar is authoritative for these non-performance fields
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

    // Real-time YTD from chart prices — overrides stale month-end API values
    const realtimeYTD = await calculateRealtimeYTD(ticker, auth);
    if (realtimeYTD != null) {
      fundData.performance = { ...fundData.performance, ytd: realtimeYTD };
    }

    // Provider-direct holdings: highest priority — override Morningstar/Yahoo
    // Use fundFamily from Yahoo (+ Morningstar name as fallback) to detect provider
    const providerHoldings = await fetchProviderHoldings(
      ticker,
      fundData.fundFamily,
      msETFLookup?.name,
    );
    if (providerHoldings.topHoldings?.length) fundData.topHoldings = providerHoldings.topHoldings;
    if (providerHoldings.sectorWeightings?.length) fundData.sectorWeightings = providerHoldings.sectorWeightings;

    return NextResponse.json({ ticker, fundData });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch fund data: ${message}` },
      { status: 500 }
    );
  }
}

// ── POST handler: scrape holdings from a user-provided URL ──

/**
 * Scrape holdings from a generic HTML page.
 * Looks for table-like structures containing: Ticker/Symbol, Name, Weight/%, Sector
 */
function scrapeGenericHoldings(html: string): ProviderHoldingsResult {
  const result: ProviderHoldingsResult = {};
  const $ = cheerio.load(html);

  // Strategy 1: Look for a table with a header containing "Ticker"/"Symbol" and "Weight"/%
  const tables = $("table");
  for (let t = 0; t < tables.length; t++) {
    const table = $(tables[t]);
    const headers = table.find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();

    // Find relevant column indices
    const tickerIdx = headers.findIndex(h => /^(ticker|symbol)$/i.test(h));
    const nameIdx = headers.findIndex(h => /^(name|security|holding|company)$/i.test(h));
    const weightIdx = headers.findIndex(h => /weight|%|allocation|pct/i.test(h));
    const sectorIdx = headers.findIndex(h => /sector|industry/i.test(h));

    if (weightIdx < 0) continue; // Must have a weight column

    const allHoldings: FundHolding[] = [];
    const sectorWeights: Record<string, number> = {};

    table.find("tbody tr, tr").each((i, row) => {
      if (i === 0 && $(row).find("th").length > 0) return; // Skip header row
      const cells = $(row).find("td");
      if (cells.length < 2) return;

      const getCellText = (idx: number) => idx >= 0 && idx < cells.length ? $(cells[idx]).text().trim() : "";
      const ticker = getCellText(tickerIdx);
      const name = getCellText(nameIdx) || ticker;
      const weightText = getCellText(weightIdx);
      const sector = getCellText(sectorIdx);

      const weight = parseFloat(weightText.replace(/[%,]/g, ""));
      if (!isFinite(weight) || weight <= 0) return;
      // Skip cash/derivatives entries
      if (/^(cash|usd|cad|forward|swap|future|derivative)/i.test(name) || /^(cash|usd|cad)/i.test(ticker)) return;

      allHoldings.push({
        symbol: ticker.replace(/[^A-Z0-9.]/gi, "").substring(0, 10),
        name: name.length > 60 ? name.substring(0, 57) + "..." : name,
        weight: parseFloat(weight.toFixed(2)),
      });
      if (sector) {
        sectorWeights[sector] = (sectorWeights[sector] || 0) + weight;
      }
    });

    if (allHoldings.length >= 3) {
      // Sort by weight descending so top 10 are the largest holdings
      allHoldings.sort((a, b) => b.weight - a.weight);
      result.topHoldings = allHoldings.slice(0, 10);
      if (Object.keys(sectorWeights).length > 0) {
        result.sectorWeightings = Object.entries(sectorWeights)
          .map(([sector, weight]) => ({ sector, weight: parseFloat(weight.toFixed(2)) }))
          .sort((a, b) => b.weight - a.weight);
      }
      break; // Use first matching table
    }
  }

  return result;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, ticker } = body;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }
    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }

    // Validate the URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
    }

    // Only allow HTTP/HTTPS
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return NextResponse.json({ error: "Only HTTP/HTTPS URLs are supported" }, { status: 400 });
    }

    // Fetch the page
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch URL: ${res.status} ${res.statusText}` },
        { status: 502 }
      );
    }

    const contentType = res.headers.get("content-type") || "";

    // Handle CSV responses
    if (contentType.includes("text/csv") || url.endsWith(".csv")) {
      const csvText = await res.text();
      const holdings = parseISharesCSV(csvText);
      if (!holdings.topHoldings?.length) {
        return NextResponse.json(
          { error: "Could not parse holdings from CSV. Ensure it has Ticker, Name, Sector, Weight columns." },
          { status: 422 }
        );
      }
      return NextResponse.json({
        ticker: ticker.toUpperCase(),
        topHoldings: holdings.topHoldings,
        sectorWeightings: holdings.sectorWeightings || [],
      });
    }

    // Handle HTML responses
    const html = await res.text();
    const holdings = scrapeGenericHoldings(html);

    if (!holdings.topHoldings?.length) {
      return NextResponse.json(
        { error: "Could not find holdings data on this page. The page should contain a table with Ticker/Symbol, Name, and Weight/% columns." },
        { status: 422 }
      );
    }

    return NextResponse.json({
      ticker: ticker.toUpperCase(),
      topHoldings: holdings.topHoldings,
      sectorWeightings: holdings.sectorWeightings || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to scrape holdings: ${message}` },
      { status: 500 }
    );
  }
}
