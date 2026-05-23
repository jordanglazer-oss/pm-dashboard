/**
 * POST /api/backfill-summaries
 *
 * Lightweight endpoint that generates ONLY companySummary + investmentThesis
 * for stocks that are missing them. No web search, no EDGAR, no scoring —
 * just a cheap text generation using existing stock data as context.
 *
 * Cost: ~$0.002/stock (vs ~$0.18/stock for a full rescore).
 *
 * Body: { ticker: string }
 * Returns: { companySummary: string, investmentThesis: string }
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { callAnthropicWithRetry } from "@/app/lib/anthropic-retry";

const client = new Anthropic();
const log = createLogger("Backfill-summaries");

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker, name, sector, scores, explanations } = body;

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
    }

    // Build a compact context from existing score explanations so the model
    // has real data to work with — no need to refetch anything.
    const contextLines: string[] = [];
    contextLines.push(`Stock: ${name || ticker} (${ticker.toUpperCase()})`);
    if (sector) contextLines.push(`Sector: ${sector}`);

    // Include top-line score info
    if (scores && typeof scores === "object") {
      const total = Object.values(scores as Record<string, number>).reduce(
        (s: number, v) => s + (typeof v === "number" ? v : 0),
        0
      );
      contextLines.push(`Composite score: ${total.toFixed(1)}`);
    }

    // Include explanation summaries (they already contain the key data points)
    if (explanations && typeof explanations === "object") {
      for (const [key, val] of Object.entries(explanations)) {
        const expl = val as { summary?: string } | undefined;
        if (expl?.summary) {
          contextLines.push(`${key}: ${expl.summary}`);
        }
      }
    }

    const message = await callAnthropicWithRetry(`Backfill ${ticker.toUpperCase()}`, () =>
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Given the following stock data, generate two fields as JSON:

${contextLines.join("\n")}

Respond with ONLY valid JSON (no markdown):
{
  "companySummary": "1-2 sentences: what the company does in plain language a PM can relay to clients. Focus on core business, key products/services, and revenue drivers.",
  "investmentThesis": "1-2 sentences: why to own this stock now. Reference specific catalysts, valuation support, or thematic tailwinds. A concise elevator pitch."
}`,
          },
        ],
      })
    );

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "No JSON in response" }, { status: 500 });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      log.error("JSON parse error:", parseErr);
      return NextResponse.json({ error: "Malformed JSON in response" }, { status: 500 });
    }
    return NextResponse.json({
      companySummary: parsed.companySummary || "",
      investmentThesis: parsed.investmentThesis || "",
    });
  } catch (error) {
    log.error("Failed:", error);
    return NextResponse.json({ error: "Failed to generate summaries" }, { status: 500 });
  }
}
