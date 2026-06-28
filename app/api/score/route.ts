import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations, ScoreDataPointSource, HealthData } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";
import { callAnthropicWithRetry } from "@/app/lib/anthropic-retry";
import type { OHLCVBar, TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { computeTechnicals, computeRiskAlert, formatTechnicalsForPrompt } from "@/app/lib/technicals";
import { formatEdgarSnapshotForPrompt } from "@/app/lib/edgar-prompt";
import { tallyResearchMentions } from "@/app/lib/research-mentions";
import { computeAnalystConsensus, getSnapshotForTicker, buildConsensusExplanation } from "@/app/lib/analyst-snapshots";
import type { AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { mapBoostedAiToAiRating, mapSmaxToRelativeStrength, consensusLabel, type BoostedAiConsensus } from "@/app/lib/external-scoring";
import { getRedis } from "@/app/lib/redis";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { factsetConfigured } from "@/app/lib/factset";
import { companySnapshot, formatSnapshotForPrompt, namesMatch, type CompanySnapshot } from "@/app/lib/factset-fundamentals";

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

  // ── Pre-distilled trend tables ──────────────────────────────────────
  // LLMs are unreliable at arithmetic on raw financial values. We compute
  // YoY / QoQ growth rates here in JS and emit them as labeled rows in the
  // prompt so the model doesn't have to derive them from raw numbers. This
  // measurably improves the consistency of growth / valuation scoring,
  // since the model often misreads ratios when forced to chain-compute
  // them across multi-period dumps.
  const fmt$ = (n: number | null | undefined): string => {
    if (n == null || !isFinite(n)) return "N/A";
    const abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toFixed(0)}`;
  };
  const fmtPct = (n: number | null | undefined): string => {
    if (n == null || !isFinite(n)) return "N/A";
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(1)}%`;
  };
  const pctChange = (current: number | null | undefined, prior: number | null | undefined): number | null => {
    if (current == null || prior == null || prior === 0 || !isFinite(current) || !isFinite(prior)) return null;
    return ((current - prior) / Math.abs(prior)) * 100;
  };

  // Annual income trend with YoY% (newest first → reverse for chronological).
  if (isH.length > 0) {
    const annual = isH.slice(0, 3).map((stmt: Record<string, unknown>) => ({
      date: (stmt as { endDate?: { fmt?: string } })?.endDate?.fmt ?? "?",
      revenue: rn(stmt, "totalRevenue"),
      netIncome: rn(stmt, "netIncome"),
      eps: rn(stmt, "dilutedEPS", "basicEPS"),
    }));
    // Reverse to chronological so YoY math reads left→right naturally.
    annual.reverse();
    lines.push(`\nINCOME TREND (annual, chronological — derived growth rates included):`);
    for (let i = 0; i < annual.length; i++) {
      const a = annual[i];
      const prev = annual[i - 1];
      const revYoY = prev ? pctChange(a.revenue, prev.revenue) : null;
      const niYoY = prev ? pctChange(a.netIncome, prev.netIncome) : null;
      const epsYoY = prev ? pctChange(a.eps, prev.eps) : null;
      lines.push(
        `  ${a.date}: Revenue ${fmt$(a.revenue)}${prev ? ` (YoY ${fmtPct(revYoY)})` : ""} | Net Income ${fmt$(a.netIncome)}${prev ? ` (YoY ${fmtPct(niYoY)})` : ""} | EPS ${a.eps != null ? `$${a.eps.toFixed(2)}` : "N/A"}${prev ? ` (YoY ${fmtPct(epsYoY)})` : ""}`,
      );
    }
    // 2y CAGR if we have 3 points
    if (annual.length >= 3 && annual[0].revenue && annual[2].revenue) {
      const cagr = (Math.pow(annual[2].revenue! / annual[0].revenue!, 1 / 2) - 1) * 100;
      lines.push(`  → 2y Revenue CAGR: ${fmtPct(cagr)}`);
    }
  }

  // Quarterly income trend — 4 quarters with QoQ% and YoY% (YoY = vs 4 quarters prior).
  if (isQ.length > 0) {
    const quarters = isQ.slice(0, 4).map((stmt: Record<string, unknown>) => ({
      date: (stmt as { endDate?: { fmt?: string } })?.endDate?.fmt ?? "?",
      revenue: rn(stmt, "totalRevenue"),
      netIncome: rn(stmt, "netIncome"),
      eps: rn(stmt, "dilutedEPS", "basicEPS"),
    }));
    quarters.reverse(); // chronological
    lines.push(`\nINCOME TREND (quarterly, last ${quarters.length}Q chronological — QoQ% vs prior Q, YoY% vs same Q prior year):`);
    for (let i = 0; i < quarters.length; i++) {
      const q = quarters[i];
      const prevQ = quarters[i - 1];
      const yearAgo = quarters[i - 4];
      const revQoQ = prevQ ? pctChange(q.revenue, prevQ.revenue) : null;
      const revYoY = yearAgo ? pctChange(q.revenue, yearAgo.revenue) : null;
      const epsYoY = yearAgo ? pctChange(q.eps, yearAgo.eps) : null;
      const parts: string[] = [`Revenue ${fmt$(q.revenue)}`];
      if (revQoQ != null) parts.push(`QoQ ${fmtPct(revQoQ)}`);
      if (revYoY != null) parts.push(`YoY ${fmtPct(revYoY)}`);
      parts.push(`NI ${fmt$(q.netIncome)}`);
      parts.push(`EPS ${q.eps != null ? `$${q.eps.toFixed(2)}` : "N/A"}${epsYoY != null ? ` (YoY ${fmtPct(epsYoY)})` : ""}`);
      lines.push(`  ${q.date}: ${parts.join(" | ")}`);
    }
  }

  // Annual cash flow trend with FCF margin (FCF / Revenue) and FCF conversion (FCF / Net Income).
  if (cfH.length > 0) {
    const cfRows = cfH.slice(0, 3).map((stmt: Record<string, unknown>, idx: number) => {
      const opCF = rn(stmt, "totalCashFromOperatingActivities");
      const capex = rn(stmt, "capitalExpenditures");
      const fcf = opCF != null ? opCF + (capex ?? 0) : null;
      const annualMatch = isH[idx] as Record<string, unknown> | undefined;
      const revenue = annualMatch ? rn(annualMatch, "totalRevenue") : null;
      const netIncome = annualMatch ? rn(annualMatch, "netIncome") : null;
      return {
        date: (stmt as { endDate?: { fmt?: string } })?.endDate?.fmt ?? "?",
        opCF, capex, fcf, revenue, netIncome,
      };
    });
    cfRows.reverse();
    lines.push(`\nCASH FLOW TREND (annual, chronological — FCF margin = FCF/Revenue, FCF conversion = FCF/NI):`);
    for (let i = 0; i < cfRows.length; i++) {
      const c = cfRows[i];
      const prev = cfRows[i - 1];
      const fcfYoY = prev ? pctChange(c.fcf, prev.fcf) : null;
      const fcfMargin = c.revenue && c.fcf != null ? (c.fcf / c.revenue) * 100 : null;
      const fcfConv = c.netIncome && c.fcf != null ? c.fcf / c.netIncome : null;
      lines.push(
        `  ${c.date}: OpCF ${fmt$(c.opCF)} | Capex ${fmt$(c.capex)} | FCF ${fmt$(c.fcf)}${fcfYoY != null ? ` (YoY ${fmtPct(fcfYoY)})` : ""}${fcfMargin != null ? ` | FCF margin ${fcfMargin.toFixed(1)}%` : ""}${fcfConv != null ? ` | FCF/NI ${fcfConv.toFixed(2)}x` : ""}`,
      );
    }
  }

  // Quarterly cash flow trend — 4 quarters with QoQ + YoY.
  if (cfQ.length > 0) {
    const cfQRows = cfQ.slice(0, 4).map((stmt: Record<string, unknown>) => {
      const opCF = rn(stmt, "totalCashFromOperatingActivities");
      const capex = rn(stmt, "capitalExpenditures");
      const fcf = opCF != null ? opCF + (capex ?? 0) : null;
      return {
        date: (stmt as { endDate?: { fmt?: string } })?.endDate?.fmt ?? "?",
        opCF, capex, fcf,
      };
    });
    cfQRows.reverse();
    lines.push(`\nCASH FLOW TREND (quarterly, last ${cfQRows.length}Q chronological):`);
    for (let i = 0; i < cfQRows.length; i++) {
      const c = cfQRows[i];
      const prevQ = cfQRows[i - 1];
      const yearAgo = cfQRows[i - 4];
      const fcfQoQ = prevQ ? pctChange(c.fcf, prevQ.fcf) : null;
      const fcfYoY = yearAgo ? pctChange(c.fcf, yearAgo.fcf) : null;
      const parts: string[] = [`OpCF ${fmt$(c.opCF)}`, `FCF ${fmt$(c.fcf)}`];
      if (fcfQoQ != null) parts.push(`QoQ ${fmtPct(fcfQoQ)}`);
      if (fcfYoY != null) parts.push(`YoY ${fmtPct(fcfYoY)}`);
      lines.push(`  ${c.date}: ${parts.join(" | ")}`);
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

const SCORING_PROMPT = `You are an institutional equity research analyst scoring a stock for a portfolio management scoring system. You will be provided with REAL FINANCIAL DATA from up to three sources (FactSet, SEC EDGAR, Yahoo Finance) — you MUST use this data to produce accurate, specific explanations. Do not guess or fabricate numbers.

DATA SOURCES (in order of preference for fundamentals):

1. FACTSET FUNDAMENTALS (when present) — the PRIMARY, authoritative source. A block marked "=== FACTSET FUNDAMENTALS ===" carries current multi-year AND trailing-twelve-month (TTM) revenue / EPS, net income, FCF, operating cash flow, capex, margins, leverage, valuation multiples, and consensus estimates pulled live from FactSet. PREFER these numbers above all others for any fundamental, valuation, or estimate metric — they are confirmed and the most current (FactSet carries the latest fiscal year plus TTM, typically fresher than EDGAR's last annual filing). When this block is present, do NOT add "should be verified" caveats — the data is confirmed. Tag every dataPoint sourced from it with source: "factset". This is also the PRIMARY (often only) structured source for Canadian and other non-US issuers, which have no EDGAR coverage at all.

2. SEC EDGAR XBRL DATA (when present) — audited as-reported figures from 10-K/10-Q filings. This is a CROSS-CHECK / FALLBACK that sits BEHIND FactSet: when the FACTSET FUNDAMENTALS block is present, cite FactSet (source: "factset") for fundamentals even if EDGAR lists the same figure — FactSet is more current (it carries the latest fiscal year + TTM; EDGAR lags to the last annual filing). Use EDGAR (source: "edgar") only for metrics FactSet does NOT carry (e.g. a specific segment line or exact XBRL concept), or when there is NO FactSet block. The block is marked "=== SEC EDGAR XBRL FINANCIALS ===" with industry classification, multi-year history, and the exact XBRL concept per metric. EDGAR is US-only (Canadian .TO/-T and OTC names won't have it — those rely on FactSet, then Yahoo).

3. YAHOO FINANCE DATA (always present) — use for: current price, market cap, beta, sentiment metrics (P/E ratios when FactSet/EDGAR aren't present), peer comparison data, analyst recommendations, dividend yield, and anything FactSet/EDGAR don't carry. Yahoo Finance data uses "raw" for numeric values and "fmt" for formatted strings; always use the actual numbers.

WHEN SOURCES DISAGREE: trust FactSet first (current + confirmed), then EDGAR for as-reported audited figures, then Yahoo (which sometimes restates silently and whose definitions can drift). When the SAME figure is available in more than one block, you MUST cite it as source: "factset" — reserve source: "edgar"/"yahoo" only for figures that appear ONLY in those blocks. Whenever a FACTSET FUNDAMENTALS block is present, it is the source of record for the growth, relativeValuation, historicalValuation, leverageCoverage, and cashFlowQuality categories: their dataPoints should be source: "factset" (peer multiples may still come from Yahoo for relativeValuation).

MISSING DATA / MANUAL FALLBACK: if NONE of the sources provide what a fundamental category needs (no FactSet block, no EDGAR, no usable Yahoo figure, and web_search — when enabled — surfaces nothing), do NOT fabricate. Score that category at its MIDPOINT, set confidence: "low", and begin its explanation summary with "INSUFFICIENT DATA — score manually:" so the PM knows to set it by hand. This should be rare now that FactSet covers most issuers.

STALE DATA HANDLING: any EDGAR field marked [STALE — last filed YYYY-MM-DD] has not been reported in over 18 months. Do NOT use stale fields as a current snapshot. Either omit analysis for that metric or note that the issuer no longer reports it discretely. Common stale cases include companies that stopped breaking out a line item in their financial statements (e.g., interest expense lumped into "other income/(expense), net").

INSIDER ACTIVITY: when the EDGAR block includes a "=== INSIDER ACTIVITY (Form 4...) ===" sub-section, this is the PRIMARY data source for the ownershipTrends category. The data comes directly from SEC Form 4 filings (officers, directors, 10%+ owners) over the last 90 days, filtered to OPEN-MARKET trades only (P=Purchase, S=Sale). RSU grants/vests, option exercises, and tax-withholding sales are deliberately EXCLUDED because they're scheduled/mechanical, not discretionary signals. Cite specific insiders, transaction dates, dollar amounts, and the directional bias. A cluster of multi-officer BUYS is a strong bullish signal; sustained broad-based SELLING is a yellow flag (but contextualize: a single 10% owner trimming a position is different from the CFO + CEO + COO all selling). If no Form 4 transactions appear, say so explicitly — quiet insider behavior is itself a neutral data point, not a missing field.

PM NOTES (when present): the user may have logged "External Sources" or "Research Coverage" notes manually on this stock. These are clearly labeled blocks in the data above (=== PM-LOGGED EXTERNAL SOURCES === and === PM-LOGGED RESEARCH COVERAGE NOTES ===). Treat these notes as supporting context for the relevant categories:
  - researchCoverageNotes describe analyst activity (named-firm coverage initiations, PT changes, upgrades/downgrades). Use them as evidence of an active information environment when scoring researchCoverage (which is now a breadth/dispersion meta-signal, not a directional score — see the researchCoverage rubric below). DO NOT use these notes to score directional bullishness or bearishness; that signal is scored separately and deterministically in analystConsensus, which is computed server-side and not your responsibility.
  - Use externalSourceNotes as input for catalysts and as supporting context across other categories where relevant (the user has determined these sources are material).
  - If both are empty, just say so in the relevant dataPoints (label "PM notes" value "none logged" source "model").

HARD FLOORS — MATERIAL ADVERSE EVENTS (override all category scoring rules):
If web_search surfaces credible evidence of ANY of the following within the last 12 months, you MUST score EVERY AI/SEMI category 0/max and clearly explain in the summaries why. These are first-order disqualifying conditions:
  - Active fraud investigation by SEC, DOJ, OSC, or major regulator (must be filed or confirmed by named outlet — rumors don't count)
  - Going-concern doubt expressed by the auditor in a 10-K/Q (look for "substantial doubt" language)
  - Material restatement of prior financials due to error or misconduct (not minor reclassifications)
  - Imminent delisting risk (NYSE/Nasdaq/TSX deficiency notice currently outstanding)
  - SEC/OSC enforcement action with monetary penalty in excess of 5% of market cap
  - CFO or CEO departure cited as resignation under pressure, with a credible source naming financial irregularities
  - Bankruptcy filing, restructuring under CCAA, or Chapter 11 in progress
For each hard-floor event, the affected category's dataPoints must include a "web" source with the URL of the regulatory filing or news article confirming the event. The companySummary and investmentThesis fields should also flag the situation prominently. Do not score "leniently low" out of politeness — zero means zero.

Each category has its own max score (shown as /N). Score from 0 to that max:
- 0 = Poor / negative signal
- Max = Strong / positive signal

Score ONLY the following categories (AUTO and SEMI categories — the PM handles MANUAL ones like charting, relative strength, AI rating, brand, external sources, and turnaround).

DO NOT SCORE these two — they are deterministic and computed server-side from structured inputs; your output for them is ignored and overwritten:
  - analystConsensus (COMPUTED): driven by the RBC + JPM + FactSet snapshot panel.
  - researchMentions (COMPUTED): tallied from cached research-screen scrapes.
Omit both from the "scores" and "explanations" objects in your response. Including them is harmless but wastes tokens.

LONG-TERM GROUP:
- secular (max 2, AUTO): Secular growth trend — long-term industry tailwinds favoring the company

RESEARCH GROUP:
- researchCoverage (max 1, SEMI): Information-environment meta-signal — score is BINARY (0 or 1, no half-points; values like 0.5 will be rounded up).
  - 1 = stock has an active sell-side following: at least ~5 analysts, recent revision activity in the last 90 days, named-firm coverage events (initiations / PT changes / rating changes) visible in Yahoo's recommendation data or the PM-logged researchCoverageNotes block.
  - 0 = thinly covered, stale revisions, no named-firm activity. Default for micro-caps and most non-US tickers without sell-side support.
  This category is intentionally narrow. DIRECTIONAL analyst sentiment (bullish vs bearish) is scored separately in analystConsensus from the RBC/JPM/FactSet panel — do NOT factor rating direction into researchCoverage. Your job here is purely "is this stock well-watched?", not "do analysts like it?".

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
- leverageCoverage (max 2, AUTO): Leverage & coverage — USE INDUSTRY-SPECIFIC METRICS (the generic "debt/EBITDA" framework is wrong for several industries):
  * Banks: CET1 / Tier 1 capital ratio (vs Basel III minimums + buffer), LCR, NSFR, loan/deposit ratio, NPL ratio. "Debt" is not the right framing — banks ARE leveraged by design; what matters is regulatory capital and liquidity.
  * Insurance: combined ratio (<100 healthy), debt/total capital, RBC ratio, financial leverage ratio. Look at reserve adequacy if disclosed.
  * REITs: debt/total assets (target ~30-50%), interest coverage, fixed-charge coverage, fixed-rate maturity ladder, % unsecured debt. Net debt/EBITDA can be misleading because of non-cash depreciation; use debt/gross asset value instead.
  * Utilities: debt/cap structure ratio, interest coverage, FFO/debt (Moody's metric), regulatory-allowed equity layer.
  * Energy E&P: net debt/EBITDAX, reserves coverage of debt, debt/PDP reserves, hedging coverage of next-12M production.
  * SaaS / high-growth tech: cash runway in years vs current burn (cash on hand / annualized FCF burn), debt at all (most should be ~zero), convertible notes due in next 24 months.
  * Industrials / Consumer / Healthcare / Materials: standard framework — net debt/EBITDA (target <3x), interest coverage (>5x healthy), debt maturity ladder.
- cashFlowQuality (max 1, AUTO): Cash flow quality — USE INDUSTRY-SPECIFIC METRICS:
  * Banks: cash flow quality is not really meaningful (CFFO is dominated by deposit flows). Instead look at: dividend payout from earnings (not borrowings), buyback consistency, % of CET1 generated organically.
  * Insurance: operating cash flow vs net income, dividends from operating subs upstreamed (not borrowed at holdco), book value growth.
  * REITs: AFFO conversion of NOI (95%+ healthy), AFFO/distribution ratio (<90% means dividend sustainable), capex/AFFO (>20% = high reinvestment).
  * Energy: FCF after sustaining capex, hedging realized vs unrealized, dividend coverage by FCF (not by borrowings).
  * SaaS: FCF margin trend, deferred revenue growth vs revenue growth (DR growing faster = forward-loaded bookings, good), stock-based comp as % of revenue (SBC > 25% is dilutive).
  * Industrials/Consumer/etc: FCF conversion (FCF/Net Income, target >0.8), operating cash flow trend, capex intensity (capex/sales), working capital efficiency.

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
6. Leverage must cite actual debt figures and coverage ratios from the balance sheet, using the INDUSTRY-APPROPRIATE framework
7. Cash flow must cite actual FCF figures and conversion rates, using the INDUSTRY-APPROPRIATE framework
8. Write in a dense, data-rich paragraph style — like an analyst note
9. Each summary should be 2-3 sentences with key data points (max 4 dataPoints per category)
10. If any data is unavailable, explicitly say "data not available" rather than guessing

CONFIDENCE RATING (required, per category):
For every AI/SEMI category you score, emit a "confidence" field with value "high" | "medium" | "low":
  - "high": you have current, authoritative data (EDGAR XBRL or web-verified press release/filing) for all material inputs, and the categorical signal is clear (no contradicting evidence). Most scores should land here.
  - "medium": you have partial data — e.g., latest quarter is verified but some peer comparisons rely on cached Yahoo data of unclear age, OR the signal is mixed (some bullish data points, some bearish). Use this honestly when 60-80% of the inputs are solid.
  - "low": material data is stale, contradictory, or missing entirely — your score is your best guess but the user should treat it as a starting point, not a final answer. Examples: small-cap with no EDGAR + sparse Yahoo coverage + no recent IR press releases; or a name where the cached fundamentals diverge sharply from what web_search returns. Use this sparingly but honestly — better to flag uncertainty than to project false precision.

Do not stuff every score with "high" confidence to seem authoritative. Honesty here is what makes the audit trail useful.

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
  - "factset" — value came from the FACTSET FUNDAMENTALS block (primary, current, confirmed)
  - "edgar" — value came from the SEC EDGAR XBRL block in the data above
  - "edgar-form4" — insider transaction data from the Form 4 block
  - "yahoo" — value came from the Yahoo Finance block
  - "web" — value came from a web_search result (sourceDetail = source name + date, e.g. "Apple Q4 2025 press release, Oct 30 2025")
  - "model" — qualitative inference based on company description / industry (use sparingly, only for narrative claims)

URL ATTRIBUTION (REQUIRED for web sources):
For every data point with source: "web", you MUST include a "url" field with the actual URL of the source you cited (the underlying press release, filing, analyst note, article, etc.). The URL should come from the web_search results you accessed during this rescore. If the underlying source has multiple URLs (e.g. you saw the press release on both the company's IR page AND on a Reuters re-print), prefer the primary source URL (company IR page > regulatory filing portal > established news outlet > aggregator).

For EDGAR / EDGAR-Form4 sources, do NOT include a URL — the UI will construct the SEC filing URL automatically from the ticker.
For Yahoo sources, do NOT include a URL — the UI will route to the appropriate Yahoo Finance subpage automatically based on the label (financials, key-statistics, analysis, etc.).
For Model sources, do NOT include a URL (qualitative inference has no source URL).

Also provide:
- name: Full company name
- sector: GICS sector
- beta: Use the beta from the provided data
- companySummary: STRICT 1-2 SENTENCES explaining what the company does in plain language that a portfolio manager can relay to clients. Focus on the core business, key products/services, and what drives revenue. Keep it simple and jargon-free. When the "INGESTED ANALYST REPORTS" block is present above, you may ground the description in the analysts' framing of the business — but do NOT extend the length beyond 1-2 sentences. If you draw a fact from a specific report, name the source briefly (e.g., "RBC describes the company as ...").
- investmentThesis: STRICT 1-2 SENTENCES on why to own this stock right now given current market conditions. Reference specific catalysts, valuation support, or thematic tailwinds. This should be a concise "elevator pitch" a PM could use with clients. When the "INGESTED ANALYST REPORTS" block is present above, USE the analysts' actual bull-case thesis bullets as your source material — do not paraphrase from your own training data when RBC/JPM have laid out the rationale. Still capped at 1-2 sentences; pick the strongest 1-2 thesis points and compress them. If the analysts disagree (e.g., one bullish, one bearish), reflect that briefly (e.g., "RBC sees X driving upside; JPM cautions about Y"). When both RBC and JPM rate the stock favorably with similar drivers, lean on their shared thesis. Never let the analyst material lengthen this field beyond 2 sentences.

COMPLETENESS REQUIREMENT: You MUST score ALL 11 categories listed above and include an explanation for EVERY one. Do not skip, omit, or abbreviate any category. If data is sparse for a category, still provide a score (even 0) with a brief explanation noting the data gap. Incomplete responses are unusable.

Respond ONLY with valid JSON (no markdown code fences, no commentary).
IMPORTANT: companySummary and investmentThesis MUST appear BEFORE explanations in your output — they are short fields that must never be truncated.
Keep each explanation summary to 2-3 sentences and max 4 dataPoints per category.

{
  "name": "Company Name",
  "sector": "GICS Sector",
  "beta": 1.0,
  "companySummary": "Plain-language summary of what the company does.",
  "investmentThesis": "Why to own this stock now given market conditions.",
  "scores": {
    "secular": 0, "researchCoverage": 0,
    "growth": 0, "relativeValuation": 0, "historicalValuation": 0,
    "leverageCoverage": 0, "cashFlowQuality": 0,
    "competitiveMoat": 0, "catalysts": 0,
    "trackRecord": 0, "ownershipTrends": 0
  },
  "explanations": {
    "growth": {
      "summary": "2-3 sentence paragraph",
      "confidence": "high",
      "dataPoints": [
        { "label": "Revenue (Q3 2026)", "value": "$5.62B (+12% YoY)", "source": "edgar", "sourceDetail": "10-Q filed 2026-10-30" },
        { "label": "EPS (Q3 2026)", "value": "$2.34 vs $2.10 est", "source": "web", "sourceDetail": "Company press release, Oct 30 2026", "url": "https://investor.example.com/news/2026/q3-earnings" }
      ]
    },
    "relativeValuation": { "summary": "...", "confidence": "medium", "dataPoints": [...] },
    "historicalValuation": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "leverageCoverage": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "cashFlowQuality": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "competitiveMoat": { "summary": "...", "confidence": "medium", "dataPoints": [...] },
    "catalysts": { "summary": "...", "confidence": "medium", "dataPoints": [...] },
    "secular": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "researchCoverage": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "trackRecord": { "summary": "...", "confidence": "high", "dataPoints": [...] },
    "ownershipTrends": { "summary": "...", "confidence": "high", "dataPoints": [...] }
  }
}`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker } = body;
    // Optional PM-logged notes (External Sources + Research Coverage). The
    // stock page passes these in so the scoring prompt can factor user-
    // captured analyst reports / article references into researchCoverage
    // and catalysts. Both are arrays of { id, date, text } — see
    // ExternalSourceNote in app/lib/types.ts.
    const externalSourceNotes = Array.isArray(body?.externalSourceNotes) ? body.externalSourceNotes : [];
    const researchCoverageNotes = Array.isArray(body?.researchCoverageNotes) ? body.researchCoverageNotes : [];
    // Optional flag: when true, the API call enables Anthropic's
    // web_search tool so the model can verify cached fundamentals against
    // the company's most recent press releases / filings / named analyst
    // notes. Defaults to false for backward compatibility — callers must
    // opt in explicitly via the UI "Verify" toggle. Canadian / non-EDGAR
    // tickers benefit most from this since they lack the XBRL fallback.
    const verifyWithWebSearch: boolean = body?.verifyWithWebSearch === true;
    // Strict-FactSet mode (default ON): when FactSet supplies a company's
    // financials, withhold the competing EDGAR XBRL block (keep Form 4 insider)
    // so the model scores fundamentals on FactSet, not EDGAR. Set false to let
    // EDGAR/Yahoo fill holes alongside FactSet (mixed-source mode).
    const strictFactset: boolean = body?.strictFactset !== false;

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
    // Whether FactSet supplied the primary fundamentals block this run. Drives
    // the input-health gate (FactSet can stand in for Yahoo) and lets us skip
    // the "verify the data" caveats since FactSet is confirmed, current data.
    let factsetUsed = false;

    try {
      // Resolve this ticker to a FactSet id (or "existing" → skip FactSet).
      // FactSet is the PRIMARY structured source: current annual + TTM
      // financials, valuation, and estimates — fresher than EDGAR (annual-
      // paced) and the only structured source for Canadian names, which have
      // no EDGAR coverage at all.
      const fsRes = factsetConfigured()
        ? resolveFactsetId(upperTicker)
        : ({ source: "existing", reason: "FactSet relay not configured" } as const);
      const factsetPromise: Promise<CompanySnapshot | null> =
        fsRes.source === "factset"
          ? companySnapshot(fsRes.id).catch((e) => {
              console.error(`[Score] FactSet snapshot failed for ${upperTicker} (${fsRes.id}):`, e);
              return null;
            })
          : Promise.resolve(null);

      // Fetch FactSet + Yahoo + price history + EDGAR XBRL in parallel.
      // Yahoo/price/EDGAR are each wrapped so one upstream hiccup can't drop
      // the FactSet block (EDGAR also returns null cleanly for non-US names).
      const [factsetSnap, financialResult, priceHistory, edgarBlock] = await Promise.all([
        factsetPromise,
        fetchFinancialData(upperTicker),
        fetchPriceHistory(upperTicker).catch(() => [] as OHLCVBar[]),
        formatEdgarSnapshotForPrompt(upperTicker).catch((e) => {
          console.error("[EDGAR] non-fatal fetch error:", e);
          return null;
        }),
      ]);

      stockPrice = financialResult.price;
      rawModules = financialResult.rawModules ?? undefined;

      // Name-guard: only trust FactSet when its company name reasonably matches
      // Yahoo's for this ticker. A mismatch means the ticker resolved to the
      // WRONG FactSet id — drop FactSet and fall back rather than silently
      // score a different company. A missing name doesn't block (lenient).
      let factsetBlock = "";
      if (factsetSnap?.hasData) {
        const yres = rawModules as { price?: { longName?: string; shortName?: string } } | undefined;
        const yahooName = yres?.price?.longName ?? yres?.price?.shortName ?? null;
        if (namesMatch(yahooName, factsetSnap.name)) {
          factsetBlock = formatSnapshotForPrompt(factsetSnap);
          factsetUsed = true;
        } else {
          console.warn(
            `[Score] ${upperTicker} FactSet name guard rejected: FactSet="${factsetSnap.name}" vs Yahoo="${yahooName}" — falling back to EDGAR/Yahoo`
          );
        }
      }

      // FactSet leads as the authoritative block. Yahoo context is appended
      // only when Yahoo actually returned modules, so its "data unavailable —
      // verify" stub is dropped whenever FactSet already supplied the data.
      const yahooContext = rawModules != null ? financialResult.context : "";
      financialContext = [factsetBlock, yahooContext].filter(Boolean).join("\n\n---\n\n");

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
      //
      // When there's no EDGAR block AND the ticker is Canadian, emit
      // an explicit "no SEC data" hint so Claude doesn't sit waiting
      // for a structured-feed block that's never going to arrive.
      // Tells the model to lean harder on web_search of the issuer's
      // own MD&A / IR press releases / SEDAR+ filings as the
      // authoritative source.
      if (edgarBlock) {
        if (factsetUsed && strictFactset) {
          // FactSet supplied the financials — withhold the competing EDGAR XBRL
          // block so the model cites FactSet (it otherwise prefers EDGAR's
          // richer as-reported block). Keep ONLY the Form 4 insider sub-section,
          // which FactSet doesn't provide (the agreed insider carve-out).
          const insiderIdx = edgarBlock.indexOf("=== INSIDER ACTIVITY");
          if (insiderIdx >= 0) financialContext += `\n\n---\n\n${edgarBlock.slice(insiderIdx)}`;
        } else {
          financialContext += `\n\n---\n\n${edgarBlock}`;
        }
      } else if (isCanadianListing) {
        financialContext += `\n\n---\n\n=== NO SEC EDGAR DATA AVAILABLE ===\n${upperTicker} is a Canadian-only listing (no US dual-listing in the SEC ticker map). SEC EDGAR XBRL data is unavailable for this issuer.\n\nFor fundamental categories (growth, leverageCoverage, cashFlowQuality, relativeValuation, historicalValuation), use the Yahoo Finance data block above as the primary source and aggressively use web_search to verify against the company's MOST RECENT quarterly MD&A or earnings press release (cite the IR-page or SEDAR+ filing URL in sourceDetail). For ownershipTrends (normally driven by Form 4 in the US): no SEDI insider feed is available in this pipeline — report the most recent insider activity disclosed via the company's MD&A or news releases if web_search surfaces it, otherwise score conservatively at the midpoint and confidence: "low". Do not pretend Form 4-style data exists when it doesn't.\n`;
      }

      // Append PM-logged notes if any. Each note is rendered as a single
      // line so the prompt stays compact; Claude can still extract the
      // source name + date for citation in dataPoints.
      type NoteRow = { id?: string; date?: string; text?: string };
      const fmtNotes = (notes: NoteRow[]) =>
        notes
          .filter((n) => typeof n?.text === "string" && n.text.trim().length > 0)
          .map((n) => `  - [${n.date || "no date"}] ${(n.text || "").trim()}`)
          .join("\n");
      const extBlock = fmtNotes(externalSourceNotes as NoteRow[]);
      if (extBlock) {
        financialContext += `\n\n---\n\n=== PM-LOGGED EXTERNAL SOURCES ===\nThe PM has manually logged the following external research / news / analyst items for this stock. Treat these as TIER-1 input for the catalysts category (and as supporting context elsewhere):\n${extBlock}`;
      }
      const rcBlock = fmtNotes(researchCoverageNotes as NoteRow[]);
      if (rcBlock) {
        financialContext += `\n\n---\n\n=== PM-LOGGED RESEARCH COVERAGE NOTES ===\nThe PM has manually logged the following sell-side analyst coverage items for this stock. Treat these as TIER-1 input for the researchCoverage category:\n${rcBlock}`;
      }

      // Append ingested analyst-report extractions (RBC + JPM) when available.
      // The Gmail-inbox webhook + manual-upload flow both store extracted
      // thesis/risks/sectorView bullets at pm:analyst-reports keyed by
      // canonical ticker. Surfacing them in the scoring prompt lets the
      // model ground the companySummary + investmentThesis in the actual
      // analyst rationale (vs. its own paraphrase) without affecting the
      // word-count rule for those fields. Compact rendering — one bullet
      // per line — keeps the prompt budget tight.
      try {
        const redis = await getRedis();
        const rawReports = await redis.get("pm:analyst-reports");
        if (rawReports) {
          const reportsBlob = JSON.parse(rawReports) as Record<string, { rbc?: { extracted?: import("@/app/lib/analyst-snapshots").ExtractedReport; uploadedAt?: string }; jpm?: { extracted?: import("@/app/lib/analyst-snapshots").ExtractedReport; uploadedAt?: string } }>;
          const canonical = upperTicker.toUpperCase();
          const tickerReports = reportsBlob[canonical];
          if (tickerReports?.rbc?.extracted || tickerReports?.jpm?.extracted) {
            const lines: string[] = ["=== INGESTED ANALYST REPORTS (RBC / JPM) ==="];
            lines.push("PDF-extracted thesis, risks, and sector view from the most recent reports stored in pm:analyst-reports. Use these to ground the companySummary and investmentThesis fields in the analysts' actual rationale (not your paraphrase). DO NOT extend the length of those fields beyond 1-2 sentences each — the rule still applies.");
            for (const src of ["rbc", "jpm"] as const) {
              const r = tickerReports[src]?.extracted;
              if (!r) continue;
              const headerBits: string[] = [src.toUpperCase()];
              if (r.rating) headerBits.push(`rating=${r.rating}`);
              if (r.target != null) headerBits.push(`target=${r.target}`);
              if (r.asOf) headerBits.push(`as of ${r.asOf}`);
              lines.push(`\n--- ${headerBits.join(" · ")} ---`);
              if (r.sectorView) lines.push(`Sector view: ${r.sectorView}`);
              if (Array.isArray(r.thesis) && r.thesis.length > 0) {
                lines.push("Thesis:");
                for (const b of r.thesis.slice(0, 5)) lines.push(`  - ${b}`);
              }
              if (Array.isArray(r.risks) && r.risks.length > 0) {
                lines.push("Risks:");
                for (const b of r.risks.slice(0, 4)) lines.push(`  - ${b}`);
              }
              if (Array.isArray(r.keyMetrics) && r.keyMetrics.length > 0) {
                lines.push("Key metrics cited:");
                for (const m of r.keyMetrics.slice(0, 6)) lines.push(`  - ${m.label}: ${m.value}`);
              }
            }
            financialContext += `\n\n---\n\n${lines.join("\n")}`;
          }
        }
      } catch (e) {
        console.error("[score] Failed to load analyst reports for prompt context:", e);
      }
    } catch (e) {
      console.error("Failed to fetch financial data:", e);
      financialContext = "Financial data API unavailable. Use your best knowledge but note that data should be verified.";
    }

    // ── Previous-rescore context ────────────────────────────────────
    // Read the most recent entry from pm:score-history (if any) for this
    // ticker and embed it in the prompt. Asking the model to "affirm or
    // explain changes" against last week's scores stabilises a category
    // that would otherwise oscillate (0→2→1→2) on each rescore, and
    // produces honest diff narratives: "downgraded growth from 3 to 2
    // because Q3 revenue growth decelerated to 8% from 14%."
    try {
      const redis = await getRedis();
      const raw = await redis.get("pm:score-history");
      if (raw) {
        const blob = JSON.parse(raw) as Record<string, Array<{ date?: string; timestamp?: string; total?: number; scores?: Record<string, number> }>>;
        const arr = blob[upperTicker];
        if (Array.isArray(arr) && arr.length > 0) {
          const latest = arr[arr.length - 1];
          if (latest?.scores && typeof latest.scores === "object") {
            const ageDays = latest.timestamp
              ? Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 86400000)
              : null;
            const scoreLines = Object.entries(latest.scores)
              .filter(([, v]) => typeof v === "number")
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n");
            const ageLabel = ageDays != null ? `${ageDays} day${ageDays === 1 ? "" : "s"} ago` : "previously";
            financialContext += `\n\n---\n\n=== PREVIOUS RESCORE (${ageLabel}) ===\nLast week's per-category scores for ${upperTicker} (composite ${typeof latest.total === "number" ? latest.total.toFixed(1) : "n/a"}):\n${scoreLines}\n\nTreat these as your prior. AFFIRM the score for a category when the underlying data hasn't materially changed — re-deriving from scratch produces unnecessary volatility. Only change a category's value when there's a concrete reason rooted in the new data (a fresh earnings print, a guidance change, a new analyst note, a sector regime shift). When you DO change a category, briefly state the trigger in the explanation summary so the diff is auditable (e.g. "downgraded from 3 to 2: Q3 revenue growth decelerated to 8% YoY from 14%").\n`;
          }
        }
      }
    } catch (e) {
      // Non-fatal — without prior context the model just rescores from
      // scratch like it did before this branch existed.
      console.error("[Score] failed to load previous score-history for prompt context:", e);
    }

    // Verify-mode preamble: tells the model that web_search is active and
    // it should use the tool aggressively for the items listed in the
    // WEB SEARCH VERIFICATION section of the system prompt (and especially
    // hard for Canadian listings, which have no EDGAR fallback).
    const verifyPreamble = verifyWithWebSearch
      ? `\n\n=== Verified scoring ===\nWeb search verification is ENABLED for this rescore. You MUST use the web_search tool to:\n  1. Confirm the most recent reported quarterly numbers match what's in the data above (or supersede them if the company reported AFTER the data was cached).\n  2. Check for guidance revisions / pre-announcements / 8-K filings issued in the last 90 days.\n  3. Find any analyst rating or price-target changes from named firms in the last 30 days.\n  4. ${isCanadianListing
            ? `THIS IS A CANADIAN LISTING (${upperTicker}) — no EDGAR data is available. Use web_search as the PRIMARY financial verification: look up the company's most recent quarterly press release / MD&A / SEDAR+ filing and use those numbers in your dataPoints. Cite each source URL or publication name in sourceDetail.`
            : `Verify the latest dividend / buyback / split changes.`}\nRespect the noise filter in the system prompt: ignore rumors, opinion blogs, and unsourced speculation. Cite source name and date in dataPoints.sourceDetail for every web-sourced fact.\nMax 2 searches — be targeted.\n=== End verified scoring ===\n`
      : "";

    // ── Input health check ────────────────────────────────────────────
    // Before paying Anthropic ~$0.18 to score this stock, make sure we
    // actually have enough input data to produce a credible result.
    //
    // Yahoo financialContext is the universal floor: if Yahoo returned
    // nothing (or the resulting context is suspiciously short — typically
    // a fallback "API unavailable" stub), every fundamental category
    // would be Claude guessing. Better to skip and surface the upstream
    // failure to the user so they can retry after Yahoo recovers.
    //
    // For US-listed tickers we ALSO expect EDGAR data; its absence on
    // a US ticker is a real signal something's off (CIK lookup failed,
    // company facts endpoint returned 4xx, etc.). We don't hard-fail on
    // missing EDGAR alone since some legitimate small caps don't have
    // XBRL filings, but we log a warning so the [Score] log line in
    // Vercel surfaces the degraded run.
    //
    // Returns 422 (Unprocessable Entity) + `skipped: true` so the Score
    // All loop can distinguish "we deliberately didn't run" from "the
    // run failed inside Anthropic" — different recovery paths.
    // FactSet OR Yahoo provides the structured floor: FactSet is primary, but
    // when it doesn't cover an issuer we still proceed on Yahoo. Only skip when
    // NEITHER returned real data (every fundamental would be pure guessing).
    const FINANCIAL_CONTEXT_MIN_CHARS = 500;
    const haveStructuredData = factsetUsed || rawModules != null;
    const dataOk = haveStructuredData && financialContext.length >= FINANCIAL_CONTEXT_MIN_CHARS;
    if (!dataOk) {
      const reason = !haveStructuredData
        ? "no FactSet snapshot and Yahoo Finance returned no modules"
        : `financial context too short (${financialContext.length} chars; need ${FINANCIAL_CONTEXT_MIN_CHARS}+)`;
      console.warn(`[Score] ${upperTicker} skipped: ${reason}. Saved ~$0.18 in Anthropic spend.`);
      return NextResponse.json(
        {
          error: `Skipped scoring ${upperTicker}: ${reason}. Refresh prices and retry — usually a transient upstream issue.`,
          skipped: true,
          reason: "input-health-check-failed",
        },
        { status: 422 },
      );
    }
    // EDGAR is scoped inside the try block above; proxy "did we get
    // EDGAR data" by looking for the labeled header in financialContext.
    const edgarPresent = financialContext.includes("=== SEC EDGAR XBRL FINANCIALS");
    if (!isCanadianListing && !edgarPresent && !factsetUsed) {
      // Soft warning — proceed but log so the Vercel dashboard shows which US
      // tickers are scoring without either FactSet or EDGAR backing.
      console.warn(`[Score] ${upperTicker} US-listed but no FactSet and no EDGAR — Yahoo-only scoring (lower confidence expected)`);
    }

    // Build tool list. Anthropic's web_search_20250305 tool runs server-side
    // and returns its results inline; the SDK exposes them through
    // server_tool_use and web_search_tool_result content blocks. We cap
    // max_uses to keep cost/latency bounded.
    type WebSearchTool = { type: "web_search_20250305"; name: "web_search"; max_uses?: number };
    const tools: WebSearchTool[] = verifyWithWebSearch
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]
      : [];

    // Prompt caching: the ~10KB system prompt is identical across rescores,
    // so marking it with `cache_control: ephemeral` lets Anthropic cache
    // it for ~5 min. Subsequent rescores within that window get a ~90%
    // discount on the cached portion. On a batch rescore of 50 names this
    // cuts input-token spend by ~25-30%. Model behavior is identical —
    // cache_control is a billing/latency optimization, not a quality knob.
    // temperature: 0 makes scoring reproducible — the same inputs should
    // always produce the same scores. Without this Anthropic's sampling
    // can cause a category to oscillate (e.g. 0→2→1→2) across weekly
    // rescores even when nothing about the underlying company changed.
    //
    // callAnthropicWithRetry wraps this in up to 3 attempts with
    // exponential backoff (1s, 2s) on transient errors — 429 rate
    // limits, 5xx server errors, 529 overloaded, and network errors.
    // Non-retryable errors (400, 401, 404, JSON parse) throw on first
    // attempt so we don't waste retries on a real bug.
    const message = await callAnthropicWithRetry(`Score ${upperTicker}`, () =>
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Score the following stock: ${upperTicker}\n\nHere is the real financial data for this company — USE THIS DATA for your scoring and explanations:\n\n${financialContext}${verifyPreamble}`,
          },
        ],
        system: [
          { type: "text", text: SCORING_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        tools: tools as unknown as Anthropic.Messages.Tool[],
      })
    );

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

    // ── Post-parse completeness check ──────────────────────────────────
    // Detect truncated JSON that parsed successfully but is missing critical
    // fields. This catches the exact class of bugs that caused missing
    // companySummary, investmentThesis, and explanation categories.
    const missingCategories: string[] = [];
    for (const key of AI_KEYS) {
      if (parsed.scores?.[key] === undefined && parsed.explanations?.[key] === undefined) {
        missingCategories.push(key);
      }
    }
    // Log truncation for diagnostics (which categories were lost)
    if (missingCategories.length > 0) {
      console.warn(`[Score] ${upperTicker}: response missing ${missingCategories.length} categories: ${missingCategories.join(", ")}`);
    }

    // Clamp each AI-scored category to its max
    const scores: Partial<Record<ScoreKey, number>> = {};
    for (const key of AI_KEYS) {
      const raw = parsed.scores?.[key];
      const max = maxLookup[key] || 3;
      scores[key as ScoreKey] = clamp(raw, max);
    }

    // Deterministic categories ("computed" inputType) are NOT in AI_KEYS — the
    // LLM doesn't score them. Compute them server-side and inject.
    const mentionsTally = await tallyResearchMentions(upperTicker);
    scores.researchMentions = mentionsTally.score;

    // analystConsensus: read pm:analyst-snapshots, compute RBC + JPM + FactSet
    // formula against current price. Returns 0 with no contributions when no
    // snapshot exists for this ticker yet.
    let analystSnapshotsBlob: AnalystSnapshots = {};
    try {
      const redis = await getRedis();
      const rawSnap = await redis.get("pm:analyst-snapshots");
      if (rawSnap) analystSnapshotsBlob = JSON.parse(rawSnap) as AnalystSnapshots;
    } catch (e) {
      console.error("Failed to read pm:analyst-snapshots:", e);
    }
    const tickerSnapshot = getSnapshotForTicker(analystSnapshotsBlob, upperTicker);
    const consensus = computeAnalystConsensus(tickerSnapshot, stockPrice);
    scores.analystConsensus = consensus.score;

    // aiRating & relativeStrength: derived from BoostedAI / SIA fields on the
    // stock. Read pm:stocks to get the external-tool inputs, then bucket-map.
    let stockBoostedAi: number | null = null;
    let stockBoostedAiConsensus: BoostedAiConsensus | null = null;
    let stockSia: number | null = null;
    try {
      const redis = await getRedis();
      const rawStocks = await redis.get("pm:stocks");
      if (rawStocks) {
        const stocksArr = JSON.parse(rawStocks) as Array<{ ticker: string; boostedAi?: number; boostedAiConsensus?: string; sia?: number }>;
        const match = stocksArr.find((s) => s.ticker.toUpperCase() === upperTicker);
        if (match) {
          stockBoostedAi = typeof match.boostedAi === "number" ? match.boostedAi : null;
          stockBoostedAiConsensus = (match.boostedAiConsensus as BoostedAiConsensus) ?? null;
          stockSia = typeof match.sia === "number" ? match.sia : null;
        }
      }
    } catch (e) {
      console.error("Failed to read pm:stocks for external-tool fields:", e);
    }
    const derivedAiRating = mapBoostedAiToAiRating(stockBoostedAi, stockBoostedAiConsensus);
    if (derivedAiRating != null) scores.aiRating = derivedAiRating;
    const derivedRelativeStrength = mapSmaxToRelativeStrength(stockSia);
    if (derivedRelativeStrength != null) scores.relativeStrength = derivedRelativeStrength;

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
              // Only accept URLs that look like real http(s) addresses, to
              // defend against the model fabricating placeholder strings
              // like "(URL not available)" or "n/a". Anything else falls
              // back to undefined → UI either skips the link (web) or
              // computes a default Yahoo subpage URL.
              const rawUrl = typeof d.url === "string" ? d.url.trim() : "";
              const url = /^https?:\/\/\S+$/.test(rawUrl) ? rawUrl : undefined;
              return {
                label: typeof d.label === "string" ? d.label : "(unnamed)",
                value: typeof d.value === "string" ? d.value : String(d.value ?? ""),
                source: source as ScoreDataPointSource,
                sourceDetail: typeof d.sourceDetail === "string" ? d.sourceDetail : undefined,
                ...(url ? { url } : {}),
              };
            });
          const confidenceRaw = typeof val.confidence === "string" ? val.confidence.toLowerCase() : undefined;
          const confidence: "high" | "medium" | "low" | undefined =
            confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
              ? confidenceRaw
              : undefined;
          explanations[key as ScoreKey] = {
            summary: val.summary,
            dataPoints,
            ...(confidence ? { confidence } : {}),
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

    // Synthesize the researchMentions explanation from the tally citations.
    // No confidence field: deterministic categories don't render a chip.
    const bullishCount = mentionsTally.mentions.filter((m) => m.direction === "bullish").length;
    const bearishCount = mentionsTally.mentions.filter((m) => m.direction === "bearish").length;
    const mentionsSummary =
      mentionsTally.mentions.length === 0
        ? `No mentions of ${upperTicker} found across cached research feeds. Score: ${mentionsTally.score}/3.`
        : `Tallied ${mentionsTally.mentions.length} mention${mentionsTally.mentions.length === 1 ? "" : "s"} across cached research feeds (${bullishCount} bullish, ${bearishCount} bearish). Raw delta: ${mentionsTally.rawDelta >= 0 ? "+" : ""}${mentionsTally.rawDelta}, clamped to ${mentionsTally.score}/3.`;
    explanations.researchMentions = {
      summary: mentionsSummary,
      dataPoints: mentionsTally.mentions.map((m) => ({
        label: m.label,
        value: m.direction === "bullish" ? "Bullish (+1)" : "Bearish (−1)",
        source: "model" as ScoreDataPointSource,
        sourceDetail: m.analyzedAt ? `Analyzed ${m.analyzedAt.slice(0, 10)}` : undefined,
      })),
    };

    // analystConsensus explanation — uses the shared builder so the score
    // route, Coverage Checklist, and stock page all produce identical output.
    explanations.analystConsensus = buildConsensusExplanation(consensus);

    // aiRating explanation (BoostedAI derived)
    if (derivedAiRating != null) {
      const parts: string[] = [];
      if (stockBoostedAi != null) parts.push(`Rating: ${stockBoostedAi.toFixed(1)}/5`);
      if (stockBoostedAiConsensus) parts.push(`Consensus: ${consensusLabel(stockBoostedAiConsensus)}`);
      explanations.aiRating = {
        summary: parts.length > 0
          ? `Auto-derived from BoostedAI inputs (${parts.join(", ")}). Mapped to ${derivedAiRating}/2.`
          : `No BoostedAI data entered. Score: ${derivedAiRating}/2.`,
        dataPoints: [
          ...(stockBoostedAi != null ? [{ label: "BoostedAI rating", value: `${stockBoostedAi.toFixed(1)}/5`, source: "model" as ScoreDataPointSource }] : []),
          ...(stockBoostedAiConsensus ? [{ label: "BoostedAI consensus", value: consensusLabel(stockBoostedAiConsensus), source: "model" as ScoreDataPointSource }] : []),
        ],
      };
    }

    // relativeStrength explanation (SIA derived)
    if (derivedRelativeStrength != null) {
      explanations.relativeStrength = {
        summary: stockSia != null
          ? `Auto-derived from SIA SMAX score of ${stockSia}/10. Mapped to ${derivedRelativeStrength}/2.`
          : `No SIA SMAX score entered. Score: ${derivedRelativeStrength}/2.`,
        dataPoints: stockSia != null
          ? [{ label: "SIA SMAX", value: `${stockSia}/10`, source: "model" as ScoreDataPointSource }]
          : [],
      };
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
      // Whether the FactSet primary-source block actually reached the prompt
      // this run (true = FactSet snapshot fetched + name-guard passed). Lets us
      // tell "FactSet present but Claude cited EDGAR" from "FactSet never ran".
      factsetUsed,
      // Verification metadata — surfaced for the score-history entry and
      // the stock-page UI ("Verified · 3 searches").
      verifiedSearch: verifyWithWebSearch,
      searchQueries,
      searchCitations,
      // Honest audit of whether verification actually ran. "complete" = at
      // least one successful search; "partial" = some searches ran but
      // fewer than requested (rate-limited / refused); "failed" = verify
      // was on but zero searches landed (tool unavailable / upstream
      // error); "skipped" = verify mode was off.
      verificationStatus: !verifyWithWebSearch
        ? "skipped"
        : searchQueries.length === 0
        ? "failed"
        : searchQueries.length < 2
        ? "partial"
        : "complete",
      // Truncation audit — lets callers detect incomplete responses and
      // trigger gap-fill passes automatically.
      missingCategories,
      truncated: missingCategories.length > 0 || !parsed.companySummary || !parsed.investmentThesis,
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
