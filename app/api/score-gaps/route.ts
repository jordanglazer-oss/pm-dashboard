/**
 * POST /api/score-gaps
 *
 * Targeted scoring for ONLY the categories missing explanations on a stock.
 * Much cheaper than a full rescore (~$0.01/stock vs ~$0.18) because:
 *   - Only the missing category rubrics are included in the prompt
 *   - No web search
 *   - Minimal financial context (uses existing explanations as reference)
 *   - Short output (only the missing categories)
 *
 * Body: {
 *   ticker: string,
 *   missingKeys: string[],      // e.g. ["trackRecord", "ownershipTrends"]
 *   name?: string,
 *   sector?: string,
 *   existingExplanations?: Record<string, { summary: string }>
 * }
 *
 * Returns: { scores: Record<string, number>, explanations: Record<string, {...}> }
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ScoreKey, ScoreExplanations, ScoreDataPointSource } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";

const client = new Anthropic();

// Build category rubrics map from the score groups
const CATEGORY_RUBRICS: Record<string, { max: number; group: string; description: string }> = {};
for (const g of SCORE_GROUPS) {
  for (const c of g.categories) {
    if (c.inputType === "auto" || c.inputType === "semi") {
      CATEGORY_RUBRICS[c.key] = { max: c.max, group: g.name, description: c.label };
    }
  }
}

// Short rubric descriptions for each AI/SEMI category (matching the main scoring prompt)
const RUBRIC_TEXT: Record<string, string> = {
  secular: "Secular growth trend — long-term industry tailwinds favoring the company (max 2)",
  researchCoverage: "Information-environment meta-signal — BINARY (0 or 1). 1 = active sell-side following (~5+ analysts, recent revisions). 0 = thinly covered (max 1)",
  growth: "Growth (rev / earnings / FCF) — cite actual figures and YoY% changes (max 3)",
  relativeValuation: "Relative valuation vs named peers — cite specific multiples (max 3)",
  historicalValuation: "Historical valuation — current multiples vs company's own history (max 2)",
  leverageCoverage: "Leverage & coverage — industry-appropriate debt metrics (max 2)",
  cashFlowQuality: "Cash flow quality — FCF conversion, sustainability (max 1)",
  competitiveMoat: "Competitive moat — durable advantages, margin/returns vs peers (max 2)",
  catalysts: "Potential catalysts — upcoming events, product launches, strategic shifts (max 3)",
  trackRecord: "Track record — management execution history, capital allocation (max 1)",
  ownershipTrends: "Ownership trends — institutional ownership, insider buying/selling (max 2)",
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker, missingKeys, name, sector, existingExplanations } = body;

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
    }
    if (!Array.isArray(missingKeys) || missingKeys.length === 0) {
      return NextResponse.json({ error: "missingKeys array is required" }, { status: 400 });
    }

    // Filter to only valid AI/SEMI keys
    const validKeys = missingKeys.filter((k: string) => RUBRIC_TEXT[k]);
    if (validKeys.length === 0) {
      return NextResponse.json({ error: "No valid scoring categories in missingKeys" }, { status: 400 });
    }

    // Build context from existing explanations so the model has some reference
    const contextLines: string[] = [];
    contextLines.push(`Stock: ${name || ticker} (${ticker.toUpperCase()})`);
    if (sector) contextLines.push(`Sector: ${sector}`);

    // Include summaries from categories that DO have explanations
    if (existingExplanations && typeof existingExplanations === "object") {
      contextLines.push("\nExisting scored categories (for context — DO NOT re-score these):");
      for (const [key, val] of Object.entries(existingExplanations)) {
        const expl = val as { summary?: string } | undefined;
        if (expl?.summary && !validKeys.includes(key)) {
          contextLines.push(`  ${key}: ${expl.summary}`);
        }
      }
    }

    // Build rubric section for only the missing categories
    const rubricLines = validKeys.map((k: string) => `- ${k}: ${RUBRIC_TEXT[k]}`);

    const scoresTemplate = validKeys.reduce((acc: Record<string, number>, k: string) => {
      acc[k] = 0;
      return acc;
    }, {});

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Score ONLY the following missing categories for ${ticker.toUpperCase()}. Use the existing category context to inform your scoring.

${contextLines.join("\n")}

CATEGORIES TO SCORE (score EVERY one — do not skip any):
${rubricLines.join("\n")}

Each explanation needs:
- summary: 2-3 dense sentences with specific data
- confidence: "high" | "medium" | "low"
- dataPoints: array of { label, value, source ("model"), sourceDetail? } — max 3 per category

Respond ONLY with valid JSON:
{
  "scores": ${JSON.stringify(scoresTemplate)},
  "explanations": {
    ${validKeys.map((k: string) => `"${k}": { "summary": "...", "confidence": "...", "dataPoints": [...] }`).join(",\n    ")}
  }
}`,
        },
      ],
    });

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
    } catch {
      // Try to repair truncated JSON
      let repaired = jsonMatch[0];
      repaired = repaired.replace(/,\s*"[^"]*":\s*"[^"]*$/, "");
      repaired = repaired.replace(/,\s*"[^"]*$/, "");
      const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      repaired += "]".repeat(Math.max(0, openBrackets));
      repaired += "}".repeat(Math.max(0, openBraces));
      parsed = JSON.parse(repaired);
    }

    // Extract scores with clamping
    const scores: Partial<Record<string, number>> = {};
    for (const key of validKeys) {
      const raw = parsed.scores?.[key];
      const max = CATEGORY_RUBRICS[key]?.max || 3;
      const num = typeof raw === "number" ? raw : 0;
      scores[key] = Math.max(0, Math.min(max, Math.round(num)));
    }

    // Extract explanations
    const explanations: Partial<ScoreExplanations> = {};
    if (parsed.explanations && typeof parsed.explanations === "object") {
      const allowedSources = new Set(["edgar", "edgar-form4", "yahoo", "web", "model"]);
      for (const key of validKeys) {
        const val = parsed.explanations[key];
        if (!val) continue;
        if (typeof val === "object" && !Array.isArray(val) && typeof val.summary === "string") {
          const dpsRaw = Array.isArray(val.dataPoints) ? val.dataPoints : [];
          const dataPoints = (dpsRaw as unknown[])
            .filter((d: unknown): d is Record<string, unknown> => d != null && typeof d === "object")
            .map((d: Record<string, unknown>) => {
              const source = typeof d.source === "string" && allowedSources.has(d.source) ? d.source : "model";
              return {
                label: typeof d.label === "string" ? d.label : "(unnamed)",
                value: typeof d.value === "string" ? d.value : String(d.value ?? ""),
                source: source as ScoreDataPointSource,
                sourceDetail: typeof d.sourceDetail === "string" ? d.sourceDetail : undefined,
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
        } else if (typeof val === "string") {
          explanations[key as ScoreKey] = { summary: val, dataPoints: [] };
        }
      }
    }

    return NextResponse.json({ scores, explanations });
  } catch (error) {
    console.error("Score gaps error:", error);
    return NextResponse.json({ error: "Failed to score missing categories" }, { status: 500 });
  }
}
