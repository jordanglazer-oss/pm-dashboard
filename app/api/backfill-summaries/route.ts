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
import { parseModelJson } from "@/app/lib/json-repair";
import { SCORE_GROUPS, MAX_SCORE } from "@/app/lib/types";
import { RATING_BANDS } from "@/app/lib/rating-bands";

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

    // Top-line score on the scale the app actually shows: the conviction
    // composite sums ONLY the categories in SCORE_GROUPS (setup-layer
    // technicals are stored beside them but never blended in).
    let belowHold = false;
    if (scores && typeof scores === "object") {
      const sc = scores as Record<string, number>;
      const total = SCORE_GROUPS.flatMap((g) => g.categories).reduce((sum, c) => sum + (typeof sc[c.key] === "number" ? sc[c.key] : 0), 0);
      belowHold = total < RATING_BANDS.hold;
      contextLines.push(`Conviction score: ${total.toFixed(1)} of ${MAX_SCORE}${belowHold ? " — BELOW the hold cutoff" : ""}`);
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
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content: `Given the following stock data, generate two fields as JSON:

${contextLines.join("\n")}

Respond with ONLY valid JSON (no markdown):
{
  "companySummary": "1-2 sentences: what the company does in plain language a PM can relay to clients. Focus on core business, key products/services, and revenue drivers.",
  "investmentThesis": "1-2 sentences on why to own this stock now, from the evidence above. If the conviction score is below the hold cutoff, or the evidence does not support a case, say plainly that there is no compelling thesis at the current price and name what would change that — do not manufacture a pitch.",
  "bearCase": "1-2 sentences: the most credible way the thesis is wrong, and the specific metric or level that would confirm it. Required for every name, strong or weak."
}`,
          },
        ],
      })
    );

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parseResult = parseModelJson<{ companySummary?: string; investmentThesis?: string; bearCase?: string }>(text);
    if (!parseResult.ok) {
      log.error("JSON parse error:", parseResult.error, parseResult.excerpt ?? "");
      return NextResponse.json({ error: `Malformed JSON in response: ${parseResult.error}` }, { status: 500 });
    }
    const parsed = parseResult.value;
    return NextResponse.json({
      companySummary: parsed.companySummary || "",
      investmentThesis: parsed.investmentThesis || "",
      bearCase: parsed.bearCase || "",
    });
  } catch (error) {
    log.error("Failed:", error);
    return NextResponse.json({ error: "Failed to generate summaries" }, { status: 500 });
  }
}
