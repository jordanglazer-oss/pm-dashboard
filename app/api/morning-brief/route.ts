import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";

const client = new Anthropic();

// Fetch live sector ETF performance from Yahoo Finance
const SECTOR_ETFS: Record<string, string> = {
  "Technology": "XLK",
  "Health Care": "XLV",
  "Financials": "XLF",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Energy": "XLE",
  "Utilities": "XLU",
  "Industrials": "XLI",
  "Materials": "XLB",
  "Communication Services": "XLC",
  "Real Estate": "XLRE",
};

async function fetchSectorPerformance(): Promise<string> {
  try {
    const tickers = Object.values(SECTOR_ETFS).join(",");
    const res = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${tickers}&fields=symbol,shortName,regularMarketChangePercent,regularMarketPrice`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) return "Sector data unavailable";
    const data = await res.json();
    const quotes = data?.quoteResponse?.result || [];
    const lines: string[] = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
      const q = quotes.find((r: { symbol: string }) => r.symbol === etf);
      if (q) {
        const pct = q.regularMarketChangePercent?.toFixed(2) ?? "N/A";
        lines.push(`- ${sector} (${etf}): ${pct}% today, price $${q.regularMarketPrice?.toFixed(2) ?? "N/A"}`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : "Sector data unavailable";
  } catch (e) {
    console.error("Sector ETF fetch error:", e);
    return "Sector data unavailable";
  }
}

const ATTACHMENT_CACHE_KEY = "pm:attachment-analysis";

const BRIEF_PROMPT = `You are a senior portfolio strategist generating a daily morning brief for a portfolio management team. Your audience is professional portfolio managers who need actionable, institutional-quality market intelligence.

Given current market data indicators, portfolio holdings, and any attached research screenshots (e.g., JPM Flows & Liquidity reports, charts), generate a comprehensive morning brief. When screenshots are provided, analyze them carefully and incorporate their insights — especially fund flow data, positioning data, and liquidity metrics — directly into your analysis. Be specific about what the screenshots show.

Be direct, opinionated, and specific. Avoid generic platitudes. Write like a seasoned PM talking to their team.

Respond ONLY with valid JSON matching this exact structure:
{
  "marketRegime": "Risk-On or Neutral or Risk-Off — your assessment based on all the data provided. This determines score multipliers for the portfolio.",
  "bottomLine": "2-4 sentence executive summary of the market regime and what it means for portfolio positioning. Be bold and direct.",
  "compositeAnalysis": "2-3 sentences on the overall market signal, what's driving it, and what PMs should focus on today.",
  "creditAnalysis": "2-3 sentences on credit spread dynamics, what they're signaling about risk appetite, and implications for equity portfolios.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime, term structure, and what it means for hedging and position sizing.",
  "breadthAnalysis": "2-3 sentences on market breadth and participation: S&P 500 and Nasdaq DMA participation rates, NYSE A/D line direction, and new highs vs new lows. Focus on market structure health — is the rally/selloff broad-based or narrow?",
  "contrarianAnalysis": "2-3 sentences providing the contrarian take. ALL four indicators (S&P Oscillator, Put/Call ratio, Fear & Greed, AAII survey) are interpreted INVERSELY: oversold/fearful = BULLISH opportunity, overbought/greedy = BEARISH warning. Provide an overall contrarian assessment and what it means for positioning.",
  "flowsAnalysis": "2-3 sentences on fund flows, positioning, and whether the market is washed out or still has room to deteriorate. If JPM Flows & Liquidity screenshots are attached, reference specific data points from them.",
  "hedgingAnalysis": "2-3 sentences on whether current conditions favor adding hedges (focused on cost efficiency: hedge when VIX is low and puts are cheap, not when expensive). Consider put cost environment, VIX context, and whether sentiment suggests complacency (cheap protection) or fear (expensive protection).",
  "sectorRotation": {
    "summary": "1-2 sentence overview of which sectors are leading vs lagging based on the LIVE sector ETF performance data provided.",
    "leading": ["Sector (+X.XX% today, reason)", "Sector (+X.XX% today, reason)"],
    "lagging": ["Sector (-X.XX% today, reason)", "Sector (-X.XX% today, reason)"],
    "pmImplication": "1-2 sentence implication for the portfolio given its current sector exposures."
  },
  "riskScan": [
    {
      "ticker": "TICKER",
      "priority": "High",
      "summary": "Brief explanation of why this holding is flagged.",
      "action": "Specific recommended action."
    }
  ],
  "forwardActions": [
    {
      "priority": "High",
      "title": "Short actionable title",
      "detail": "1-2 sentence explanation of why this action matters now."
    }
  ]
}

Notes:
- sectorRotation.leading and .lagging should each have 2-3 entries with sector name, approximate MTD performance, and a brief reason.
- riskScan should list portfolio holdings ordered from highest risk to lowest, with priority: "High", "Medium-High", "Medium", or "Low-Medium". Focus on the weakest/most at-risk names. Include 4-7 entries.
- forwardActions should contain 4-6 specific, actionable recommendations ordered by priority. Use "High", "Medium", or "Low" for priority.`;

type AttachmentInput = {
  section: string;
  label: string;
  dataUrl: string;
};

function buildImageBlocks(attachments: AttachmentInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  if (!attachments || attachments.length === 0) return blocks;

  // Group by section
  const bySection: Record<string, AttachmentInput[]> = {};
  for (const att of attachments) {
    if (!bySection[att.section]) bySection[att.section] = [];
    bySection[att.section].push(att);
  }

  for (const [section, atts] of Object.entries(bySection)) {
    blocks.push({
      type: "text",
      text: `\n--- Attached screenshots for ${section} (${atts.length} image${atts.length > 1 ? "s" : ""}) ---\nAnalyze these carefully and incorporate findings into your brief:`,
    });

    for (const att of atts) {
      // Extract media type and base64 data from data URL
      const match = att.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) continue;

      const mediaType = match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      const data = match[2];

      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
      });

      blocks.push({
        type: "text",
        text: `(Image: ${att.label})`,
      });
    }
  }

  return blocks;
}

// Generate a fingerprint of the current attachments so we know if they changed
function hashAttachments(attachments: AttachmentInput[]): string {
  if (!attachments || attachments.length === 0) return "none";
  const ids = attachments.map((a) => a.dataUrl.slice(-100)).sort().join("|");
  return createHash("md5").update(ids).digest("hex");
}

type CachedAnalysis = {
  hash: string;
  summary: string;
  analyzedAt: string;
};

// Get cached analysis from KV, or null if cache miss / images changed
async function getCachedAnalysis(hash: string): Promise<string | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(ATTACHMENT_CACHE_KEY);
    if (!raw) return null;
    const cached: CachedAnalysis = JSON.parse(raw);
    if (cached.hash === hash) return cached.summary;
    return null;
  } catch {
    return null;
  }
}

// Save analysis to KV cache
async function saveCachedAnalysis(hash: string, summary: string) {
  try {
    const redis = await getRedis();
    const cached: CachedAnalysis = {
      hash,
      summary,
      analyzedAt: new Date().toISOString(),
    };
    await redis.set(ATTACHMENT_CACHE_KEY, JSON.stringify(cached));
  } catch (e) {
    console.error("Failed to cache attachment analysis:", e);
  }
}

// Run a separate Claude call to analyze screenshots, then cache the result
async function analyzeAttachments(attachments: AttachmentInput[]): Promise<string> {
  const imageBlocks = buildImageBlocks(attachments);
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "You are a senior portfolio strategist. Analyze these JPM Flows & Liquidity report screenshots. Extract all key data points: fund flow figures ($bn), asset class flows (equity, bond, money market), regional flows, sector positioning, and any notable trends. Be specific with numbers. Write a concise 3-5 paragraph summary that a PM can reference daily.",
          },
          ...imageBlocks,
        ],
      },
    ],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

export async function POST(request: NextRequest) {
  try {
    const { marketData, holdings, attachments } = await request.json();

    if (!marketData) {
      return NextResponse.json(
        { error: "Market data is required" },
        { status: 400 }
      );
    }

    const holdingsSummary = holdings
      ? holdings
          .map(
            (h: { ticker: string; bucket: string; sector: string; scores?: Record<string, number>; weights: { portfolio: number } }) => {
              const rawScore = h.scores ? Object.values(h.scores).reduce((a: number, b: number) => a + b, 0) : 0;
              return `${h.ticker} (${h.bucket}, ${h.sector}, ${h.weights.portfolio}% weight, score ${rawScore}/40)`;
            }
          )
          .join(", ")
      : "No holdings provided";

    // Fetch live sector ETF data for sector rotation analysis
    const sectorPerformance = await fetchSectorPerformance();

    // Build content blocks: text prompt + any image attachments
    const textContent = `Generate the morning brief for today. Here are the current market indicators:

Composite Signal: ${marketData.compositeSignal}
Conviction: ${marketData.conviction}

IMPORTANT: Based on ALL the data below, determine the market regime yourself (Risk-On, Neutral, or Risk-Off). Return it in the "marketRegime" field.

Volatility:
- VIX: ${marketData.vix}
- MOVE Index: ${marketData.move}
- VIX Term Structure: ${marketData.termStructure}

Credit Spreads:
- HY OAS: ${marketData.hyOas} bps
- IG OAS: ${marketData.igOas} bps

Breadth & Market Structure:
- S&P 500 % Above 200 DMA: ${marketData.breadth}%
- Nasdaq % Above 200 DMA: ${marketData.nasdaqBreadth}%
- S&P 500 % Above 50 DMA: ${marketData.sp50dma}%
- NYSE A/D Line: ${marketData.nyseAdLine}
- New Highs - New Lows: ${marketData.newHighsLows}

Contrarian Indicators (ALL interpreted INVERSELY — oversold/fearful = BULLISH, overbought/greedy = BEARISH):
- S&P Oscillator: ${marketData.spOscillator} — negative = oversold = BULLISH, positive = overbought = BEARISH
- Put/Call Ratio (Total): ${marketData.putCall} — >1.0 = excessive fear = BULLISH, <0.7 = complacency = BEARISH
- Fear & Greed Index: ${marketData.fearGreed}/100 — <25 = extreme fear = BULLISH, >75 = extreme greed = BEARISH
- AAII Bull-Bear Spread: ${marketData.aaiiBullBear} — <-20 = excessive bearishness = BULLISH, >+30 = excessive bullishness = BEARISH

Equity Flows: ${marketData.equityFlows}

Hedge Timing Score: ${marketData.hedgeScore}/100

Live Sector ETF Performance (from Yahoo Finance — use this for sector rotation analysis):
${sectorPerformance}

Current Portfolio Holdings: ${holdingsSummary}`;

    // Check if we can reuse cached screenshot analysis instead of re-sending images
    const atts: AttachmentInput[] = attachments || [];
    const attHash = hashAttachments(atts);
    let flowsContext = "";

    if (atts.length > 0) {
      const cached = await getCachedAnalysis(attHash);
      if (cached) {
        // Images haven't changed — use cached summary (saves vision tokens)
        flowsContext = `\n\n--- JPM Flows & Liquidity Report Summary (from attached screenshots, unchanged since last analysis) ---\n${cached}`;
        console.log("Using cached attachment analysis (images unchanged)");
      } else {
        // New images — analyze them separately and cache the result
        console.log("New attachments detected — running vision analysis...");
        const summary = await analyzeAttachments(atts);
        await saveCachedAnalysis(attHash, summary);
        flowsContext = `\n\n--- JPM Flows & Liquidity Report Summary (freshly analyzed from screenshots) ---\n${summary}`;
      }
    }

    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
      { type: "text", text: textContent + flowsContext },
    ];

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: contentBlocks,
        },
      ],
      system: BRIEF_PROMPT,
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Failed to parse brief response" },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      date: new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      marketData,
      ...parsed,
    });
  } catch (error) {
    console.error("Morning brief API error:", error);
    return NextResponse.json(
      { error: "Failed to generate morning brief" },
      { status: 500 }
    );
  }
}
