import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import type { AnalystRating } from "@/app/lib/analyst-snapshots";

/**
 * One-shot PDF extractor for RBC / JPM analyst reports. Mirrors the
 * upticks-scrape + research-scrape caching pattern: hash the dataUrl,
 * look up pm:analyst-report-extract-cache[hash], and only call Anthropic
 * on miss. Re-uploading the same PDF is $0.
 *
 * The route returns structured JSON only — the client persists both the
 * extraction (in pm:analyst-reports) and the raw PDF (in
 * pm:analyst-report-pdf:<id>) via the kv routes. That split storage
 * keeps the manifest small and survives Redis's per-value write limits
 * even when one ticker accumulates multiple reports.
 */

const CACHE_KEY = "pm:analyst-report-extract-cache";
const client = new Anthropic();

const VALID_SOURCES = ["rbc", "jpm"] as const;
type SourceKey = typeof VALID_SOURCES[number];

export type ExtractedReport = {
  rating?: AnalystRating;
  target?: number;
  asOf?: string;
  thesis?: string[];
  risks?: string[];
  sectorView?: string;
  keyMetrics?: { label: string; value: string }[];
};

type CacheBlob = Record<string, { result: ExtractedReport; extractedAt: string }>;

function hashDataUrl(dataUrl: string): string {
  return createHash("sha256").update(dataUrl).digest("hex");
}

async function readCache(): Promise<CacheBlob> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CacheBlob;
  } catch {
    return {};
  }
}

async function writeCache(blob: CacheBlob) {
  try {
    const redis = await getRedis();
    await redis.set(CACHE_KEY, JSON.stringify(blob));
  } catch (e) {
    console.error("Failed to write analyst-report-extract-cache:", e);
  }
}

const PROMPT_TEMPLATE = (ticker: string, source: SourceKey) => `You are extracting structured data from a ${source.toUpperCase()} sell-side equity research PDF on ${ticker}. Output STRICT JSON only — no prose, no markdown fences, nothing outside the JSON object.

Schema:
{
  "rating": "outperform" | "neutral" | "underperform",     // map bank-specific terms: RBC (Outperform/Sector Perform/Underperform), JPM (Overweight/Neutral/Underweight). Omit if not stated.
  "target": <number>,                                       // 12-month price target, numeric, no currency symbol. Omit if not stated.
  "asOf": "YYYY-MM-DD",                                     // publication date of THIS report. Omit if not clearly stated.
  "thesis": ["bullet 1", "bullet 2", ...],                  // 3-5 dense bullets capturing the analyst's investment thesis (bull case if Outperform, bear case if Underperform, sideways thesis if Neutral). Each bullet ≤ 25 words.
  "risks": ["risk 1", "risk 2", ...],                       // 2-4 bullets capturing key downside risks the report flags. ≤ 25 words each.
  "sectorView": "one sentence",                             // the analyst's sector / industry outlook if it's mentioned in this report. Omit if absent.
  "keyMetrics": [{"label": "...", "value": "..."}, ...]     // 3-6 named numeric data points the analyst uses to support their thesis (e.g. {"label": "FY27 EPS estimate", "value": "$12.40"}). Omit if none.
}

Rules:
- Use ONLY information present in the PDF. Do NOT supplement with external knowledge.
- Numbers go in as raw numbers without dollar signs or commas (target: 245.50, not "$245.50").
- If a field is not stated in the PDF, OMIT it entirely. Do NOT emit nulls or empty strings.
- Output the JSON object only. Nothing before or after.`;

function buildPdfBlocks(dataUrl: string): Anthropic.Messages.ContentBlockParam[] {
  const match = dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
  if (!match) return [];
  const data = match[1].replace(/\s/g, "");
  return [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    },
  ];
}

function parseExtraction(text: string): ExtractedReport {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return {};
  }

  const out: ExtractedReport = {};
  if (typeof parsed.rating === "string") {
    const r = parsed.rating.toLowerCase();
    if (r === "outperform" || r === "neutral" || r === "underperform") out.rating = r;
  }
  if (typeof parsed.target === "number" && Number.isFinite(parsed.target)) out.target = parsed.target;
  if (typeof parsed.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.asOf)) out.asOf = parsed.asOf;
  if (typeof parsed.sectorView === "string" && parsed.sectorView.trim()) out.sectorView = parsed.sectorView.trim();
  if (Array.isArray(parsed.thesis)) {
    out.thesis = parsed.thesis
      .filter((b: unknown): b is string => typeof b === "string" && b.trim().length > 0)
      .slice(0, 8);
  }
  if (Array.isArray(parsed.risks)) {
    out.risks = parsed.risks
      .filter((b: unknown): b is string => typeof b === "string" && b.trim().length > 0)
      .slice(0, 6);
  }
  if (Array.isArray(parsed.keyMetrics)) {
    out.keyMetrics = parsed.keyMetrics
      .filter((m: unknown): m is Record<string, unknown> => m !== null && typeof m === "object")
      .map((m: Record<string, unknown>) => ({
        label: typeof m.label === "string" ? m.label : "",
        value: typeof m.value === "string" ? m.value : String(m.value ?? ""),
      }))
      .filter((m) => m.label && m.value)
      .slice(0, 10);
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.toUpperCase() : "";
    const source = typeof body?.source === "string" ? body.source.toLowerCase() : "";
    const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
    const force = body?.force === true;

    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    if (!(VALID_SOURCES as readonly string[]).includes(source)) {
      return NextResponse.json({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` }, { status: 400 });
    }
    if (!dataUrl.startsWith("data:application/pdf;base64,")) {
      return NextResponse.json({ error: "dataUrl must be a base64-encoded PDF" }, { status: 400 });
    }

    const hash = hashDataUrl(dataUrl);

    if (!force) {
      const cache = await readCache();
      if (cache[hash]) {
        return NextResponse.json({
          result: cache[hash].result,
          extractedAt: cache[hash].extractedAt,
          hash,
          cached: true,
        });
      }
    }

    const pdfBlocks = buildPdfBlocks(dataUrl);
    if (pdfBlocks.length === 0) {
      return NextResponse.json({ error: "Failed to decode PDF" }, { status: 400 });
    }

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            ...pdfBlocks,
            { type: "text", text: PROMPT_TEMPLATE(ticker, source as SourceKey) },
          ],
        },
      ],
    });

    let text = "";
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
    }

    const result = parseExtraction(text);
    const extractedAt = new Date().toISOString();

    const cache = await readCache();
    cache[hash] = { result, extractedAt };
    await writeCache(cache);

    return NextResponse.json({ result, extractedAt, hash, cached: false });
  } catch (e) {
    console.error("analyst-report-extract error:", e);
    const msg = e instanceof Error ? e.message : "Extraction failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
