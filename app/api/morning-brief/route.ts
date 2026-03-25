import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic();

const BRIEF_PROMPT = `You are a senior portfolio strategist generating a daily morning brief for a portfolio management team. Your audience is professional portfolio managers who need actionable, institutional-quality market intelligence.

Given current market data indicators, portfolio holdings, and any attached research screenshots (e.g., JPM Flows & Liquidity reports, charts), generate a comprehensive morning brief. When screenshots are provided, analyze them carefully and incorporate their insights — especially fund flow data, positioning data, and liquidity metrics — directly into your analysis. Be specific about what the screenshots show.

Be direct, opinionated, and specific. Avoid generic platitudes. Write like a seasoned PM talking to their team.

Respond ONLY with valid JSON matching this exact structure:
{
  "bottomLine": "2-4 sentence executive summary of the market regime and what it means for portfolio positioning. Be bold and direct.",
  "compositeAnalysis": "2-3 sentences on the overall market signal, what's driving it, and what PMs should focus on today.",
  "creditAnalysis": "2-3 sentences on credit spread dynamics, what they're signaling about risk appetite, and implications for equity portfolios.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime, term structure, and what it means for hedging and position sizing.",
  "breadthAnalysis": "2-3 sentences on market breadth, internals, and what the median stock is doing vs the index.",
  "flowsAnalysis": "2-3 sentences on fund flows, positioning, sentiment indicators, and whether the market is washed out or still has room to deteriorate. If JPM Flows & Liquidity screenshots are attached, reference specific data points from them.",
  "hedgingAnalysis": "2-3 sentences on whether current conditions favor adding hedges (focused on cost efficiency: hedge when VIX is low and puts are cheap, not when expensive). Consider put cost environment, VIX context, and whether sentiment suggests complacency (cheap protection) or fear (expensive protection).",
  "sectorRotation": {
    "summary": "1-2 sentence overview of which sectors are leading vs lagging and the rotation theme.",
    "leading": ["Sector (+X% MTD, reason)", "Sector (+X% MTD, reason)"],
    "lagging": ["Sector (-X% MTD, reason)", "Sector (-X% MTD, reason)"],
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

    // Build content blocks: text prompt + any image attachments
    const textContent = `Generate the morning brief for today. Here are the current market indicators:

Composite Signal: ${marketData.compositeSignal}
Conviction: ${marketData.conviction}
Risk Regime: ${marketData.riskRegime}

Volatility:
- VIX: ${marketData.vix}
- MOVE Index: ${marketData.move}
- VIX Term Structure: ${marketData.termStructure}

Credit Spreads:
- HY OAS: ${marketData.hyOas} bps
- IG OAS: ${marketData.igOas} bps

Breadth:
- % Above 200 DMA: ${marketData.breadth}%

Sentiment & Positioning:
- Fear & Greed Index: ${marketData.fearGreed}/100
- AAII Bull-Bear Spread: ${marketData.aaiiBullBear}
- Put/Call Ratio: ${marketData.putCall}

S&P Oscillator: ${marketData.spOscillator} (negative = oversold/bullish, positive = overbought/bearish)

Equity Flows: ${marketData.equityFlows}

Hedge Timing Score: ${marketData.hedgeScore}/100

Current Portfolio Holdings: ${holdingsSummary}`;

    const imageBlocks = buildImageBlocks(attachments || []);

    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [
      { type: "text", text: textContent },
      ...imageBlocks,
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
