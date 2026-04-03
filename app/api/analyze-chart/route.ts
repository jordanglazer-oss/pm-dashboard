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
      max_tokens: 1500,
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

Provide a concise technical analysis for a portfolio manager. Cover:
1. Trend — direction, strength, recent inflection points
2. Key Levels — specific support and resistance prices
3. Patterns — any identifiable chart formations
4. Volume — notable trends or divergences
5. Moving Averages — SMA 50/200 positioning and crossovers
6. Outlook — bullish/bearish/neutral with near-term and medium-term view, actionable positioning guidance`,
            },
          ],
        },
      ],
      system: `You are a senior technical analyst writing for a portfolio manager. Rules:
- No emojis, no decorative characters, no horizontal rules (---)
- No numbered prefixes on section headers (write "Trend Analysis" not "1. Trend Analysis")
- Use **bold** for section headers only, not for emphasis within sentences
- Be direct and specific with price levels — no hedging language
- Keep paragraphs tight: 2-3 sentences max per point
- Tables are fine for key levels if needed, but keep them compact
- No blank lines between bullet points
- Write like a research note, not a blog post
- Total length should be 300-500 words`,
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
