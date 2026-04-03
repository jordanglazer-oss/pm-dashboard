import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { TechnicalIndicators } from "@/app/lib/technicals";
import { formatTechnicalsForPrompt } from "@/app/lib/technicals";

const client = new Anthropic();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker, imageBase64, range, technicals } = body as {
      ticker: string;
      imageBase64: string;
      range: string;
      technicals?: TechnicalIndicators;
    };

    if (!ticker || !imageBase64) {
      return NextResponse.json({ error: "ticker and imageBase64 are required" }, { status: 400 });
    }

    // Strip data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const technicalsText = technicals ? `\n\n${formatTechnicalsForPrompt(technicals)}` : "";

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64Data },
            },
            {
              type: "text",
              text: `Analyze this ${range} candlestick chart for ${ticker}.${technicalsText}

Provide a concise technical analysis covering:
1. **Trend Analysis** — Primary trend direction, strength, and any recent changes
2. **Key Levels** — Support and resistance levels visible on the chart
3. **Pattern Recognition** — Any chart patterns (head & shoulders, triangles, channels, flags, etc.)
4. **Volume Analysis** — Volume trends and any divergences with price
5. **Moving Averages** — SMA 50 (blue) and SMA 200 (red) relationship and crossovers
6. **Overall Outlook** — Bullish/bearish/neutral assessment with near-term and medium-term view

Be specific about price levels. Keep the analysis data-rich and actionable.`,
            },
          ],
        },
      ],
      system:
        "You are a professional technical analyst specializing in equity chart analysis. Analyze the provided stock chart image along with any technical indicator data. Be specific about price levels, patterns, and actionable insights. Format your response with clear sections using markdown. Keep the analysis concise but thorough.",
    });

    const analysis =
      message.content[0].type === "text" ? message.content[0].text : "Analysis unavailable";

    return NextResponse.json({ analysis, ticker, range });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Chart analysis error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
