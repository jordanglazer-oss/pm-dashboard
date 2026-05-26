import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { TechnicalIndicators } from "@/app/lib/technicals";
import { formatTechnicalsForPrompt } from "@/app/lib/technicals";

const client = new Anthropic();

/**
 * Structured chart-analysis response. The original endpoint returned only
 * a prose `analysis` field (300-500 words). That string is still emitted
 * (backward-compat for saved analyses in pm:chart-analysis), but Claude
 * is now asked to return everything as JSON so the UI can surface the
 * scannable bits — outlook, confidence, bull/bear cases, levels, next
 * action — at the top, with the full prose below for context.
 */
type StructuredAnalysis = {
  outlook: "Bullish" | "Neutral" | "Bearish";
  confidence: number; // 0–1
  bullCase: string;
  bearCase: string;
  support: number[];
  resistance: number[];
  stopBelow: number | null;
  nextAction: string;
  prose: string; // The full markdown write-up — same content as legacy `analysis`
};

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

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const technicalsText = technicals ? `\n\n${formatTechnicalsForPrompt(technicals)}` : "";

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      temperature: 0,
      max_tokens: 2000,
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

Respond ONLY with valid JSON in this exact shape — no preamble, no markdown fences, no commentary outside the JSON:

{
  "outlook": "Bullish | Neutral | Bearish",
  "confidence": 0.72,
  "bullCase": "≤ 40 words. The clearest reason to be long here, anchored in something visible on the chart.",
  "bearCase": "≤ 40 words. What would invalidate the bull case, or the strongest contrary read. NEVER 'none' — every chart has a bear scenario, even if low probability.",
  "support": [142.5, 140.0],
  "resistance": [155.0, 160.0],
  "stopBelow": 142.0,
  "nextAction": "≤ 15 words. Imperative, executable today. e.g. 'Accumulate on dips to 148; stop below 142.'",
  "prose": "300-500 word full technical analysis covering Trend, Key Levels, Patterns, Volume, Moving Averages (SMA 50/200), and Outlook. Use **Bold Headers** for sections. No emojis, no horizontal rules, no numbered prefixes."
}

Rules:
- outlook must reflect your true read; don't default to Neutral if you have a directional bias.
- confidence is a real assessment: 0.5 means genuinely uncertain, 0.85+ means strong setup. Don't anchor to 0.7.
- support/resistance are SPECIFIC PRICE LEVELS visible on the chart. Order from most relevant (closest to current price) outward. Empty array if you genuinely can't identify a level — don't fabricate.
- stopBelow is the level that, if broken, invalidates the bull case. Required for Bullish; can be null for Bearish/Neutral.
- nextAction starts with a verb. "Accumulate", "Trim", "Wait", "Hold", "Avoid". Be specific about price triggers.
- Total prose body length: 300-500 words. No blank lines between bullets. Tables fine for key levels if compact.`,
            },
          ],
        },
      ],
      system: `You are a senior technical analyst writing for a portfolio manager. Output JSON ONLY — no prose outside the JSON envelope. Be direct, specific with price levels, no hedging language. The prose body should read like a research note, not a blog post.`,
    });

    const rawText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Robust JSON extraction — Claude usually emits clean JSON when asked,
    // but occasional ```json fences or trailing commentary slip through.
    // Strip fences first, then locate the outermost { ... } object.
    const stripped = rawText.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    let parsed: StructuredAnalysis | null = null;
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1)) as StructuredAnalysis;
      } catch {
        parsed = null;
      }
    }

    // Backward-compat surface: always emit a prose `analysis` field for
    // legacy consumers (saved analyses in pm:chart-analysis pre-structured).
    if (!parsed) {
      // Couldn't parse — fall back to the raw text as prose.
      return NextResponse.json({
        analysis: rawText || "Analysis unavailable",
        ticker,
        range,
      });
    }

    return NextResponse.json({
      // Legacy: prose write-up (saved into pm:chart-analysis).
      analysis: parsed.prose,
      // New structured fields — UI renders these prominently when present.
      outlook: parsed.outlook,
      confidence: parsed.confidence,
      bullCase: parsed.bullCase,
      bearCase: parsed.bearCase,
      support: parsed.support,
      resistance: parsed.resistance,
      stopBelow: parsed.stopBelow,
      nextAction: parsed.nextAction,
      ticker,
      range,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Chart analysis error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
