import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic();

const BRIEF_PROMPT = `You are a senior portfolio strategist generating a daily morning brief for a portfolio management team. Your audience is professional portfolio managers who need actionable, institutional-quality market intelligence.

Given current market data indicators, generate a comprehensive morning brief. Be direct, opinionated, and specific. Avoid generic platitudes. Write like a seasoned PM talking to their team.

Respond ONLY with valid JSON matching this exact structure:
{
  "bottomLine": "2-4 sentence executive summary of the market regime and what it means for portfolio positioning. Be bold and direct.",
  "compositeAnalysis": "2-3 sentences on the overall market signal, what's driving it, and what PMs should focus on today.",
  "creditAnalysis": "2-3 sentences on credit spread dynamics, what they're signaling about risk appetite, and implications for equity portfolios.",
  "volatilityAnalysis": "2-3 sentences on the volatility regime, term structure, and what it means for hedging and position sizing.",
  "breadthAnalysis": "2-3 sentences on market breadth, internals, and what the median stock is doing vs the index.",
  "flowsAnalysis": "2-3 sentences on fund flows, positioning, sentiment indicators, and whether the market is washed out or still has room to deteriorate.",
  "hedgingAnalysis": "2-3 sentences on whether current conditions favor adding hedges, the optimal approach, and timing considerations.",
  "forwardActions": [
    {
      "priority": "High",
      "title": "Short actionable title",
      "detail": "1-2 sentence explanation of why this action matters now."
    }
  ]
}

The forwardActions array should contain 3-5 specific, actionable recommendations ordered by priority. Use "High", "Medium", or "Low" for priority.`;

export async function POST(request: NextRequest) {
  try {
    const { marketData, holdings } = await request.json();

    if (!marketData) {
      return NextResponse.json(
        { error: "Market data is required" },
        { status: 400 }
      );
    }

    const holdingsSummary = holdings
      ? holdings
          .map(
            (h: { ticker: string; bucket: string; sector: string; weights: { portfolio: number } }) =>
              `${h.ticker} (${h.bucket}, ${h.sector}, ${h.weights.portfolio}% weight)`
          )
          .join(", ")
      : "No holdings provided";

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Generate the morning brief for today. Here are the current market indicators:

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

Hedge Timing Score: ${marketData.hedgeScore}/100

Current Portfolio Holdings: ${holdingsSummary}`,
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
