/**
 * Shared Anthropic-based extractor for RBC / JPM analyst report PDFs.
 *
 * Both the manual-upload route (/api/analyst-report-extract) and the Gmail
 * inbox webhook (/api/inbox/ingest) call this. Single source of truth for
 * the prompt, the JSON parser, and the hash-gated cache.
 *
 * Caching: hash the dataUrl (SHA-256), look up the result in
 * pm:analyst-report-extract-cache. Same PDF → cache hit, zero Anthropic
 * spend. Re-uploading or re-ingesting the same PDF later costs nothing.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { getRedis } from "./redis";
import type { ExtractedReport, AnalystRating } from "./analyst-snapshots";
import { parseModelJson } from "./json-repair";

const CACHE_KEY = "pm:analyst-report-extract-cache";
const client = new Anthropic();

export type AnalystSource = "rbc" | "jpm" | "morningstar";
export const VALID_SOURCES: readonly AnalystSource[] = ["rbc", "jpm", "morningstar"] as const;

type CacheBlob = Record<string, { result: ExtractedReport; extractedAt: string }>;

export function hashDataUrl(dataUrl: string): string {
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

const PROMPT_TEMPLATE = (ticker: string, source: AnalystSource) => `You are extracting structured data from a ${source.toUpperCase()} sell-side equity research PDF on ${ticker}. Output STRICT JSON only — no prose, no markdown fences, nothing outside the JSON object.

Schema:
{
  "rating": "outperform" | "neutral" | "underperform",     // map bank-specific terms: RBC (Outperform/Sector Perform/Underperform), JPM (Overweight/Neutral/Underweight). For Morningstar OMIT this field — stars are extracted separately below. Omit if not stated.
  "target": <number>,                                       // 12-month price target, numeric, no currency symbol. Omit if not stated.
  "targetCurrency": "USD" | "CAD" | "<ISO 4217 code>",       // ISO 4217 currency of the price target. Look for currency symbols (C$, CA$, US$, $, kr, €, £, ¥), disclaimers, or the exchange the report references. Use "USD" for US-listed stocks, "CAD" for TSX-listed, "DKK" for Copenhagen, "SEK" for Stockholm, "GBP"/"GBp" for London, etc. Always emit the standard ISO code (e.g. DKK not "Danish Krone"). Omit only if target is omitted.
  "asOf": "YYYY-MM-DD",                                     // publication date of THIS report. Omit if not clearly stated.
  "thesis": ["bullet 1", "bullet 2", ...],                  // 3-5 dense bullets capturing the analyst's investment thesis (bull case if Outperform, bear case if Underperform, sideways thesis if Neutral). Each bullet ≤ 25 words.
  "risks": ["risk 1", "risk 2", ...],                       // 2-4 bullets capturing key downside risks the report flags. ≤ 25 words each.
  "sectorView": "one sentence",                             // the analyst's sector / industry outlook if it's mentioned in this report. Omit if absent.
  "keyMetrics": [{"label": "...", "value": "..."}, ...],    // 3-6 named numeric data points the analyst uses to support their thesis (e.g. {"label": "FY27 EPS estimate", "value": "$12.40"}). Omit if none.
  "catalysts": [{"date": "YYYY-MM-DD or a period like Q4 FY26 / 2H26", "event": "...", "detail": "expected impact in <=15 words"}, ...],  // 0-5 DATED, company-specific upcoming events the report names (product launches, capital markets days, regulatory decisions, contract awards, guidance events). ONLY events with a stated date or period — a generic "continued execution" is NOT a catalyst. Omit if none.
  "valuationBasis": "...",                                  // one short phrase: how the analyst derives the price target (e.g. "18x FY27 EPS", "DCF at 9% WACC", "SOTP", "1.6x P/B on 14% ROE"). Omit if not stated.
  "scenarios": {"bull": <number>, "base": <number>, "bear": <number>}  // the report's published scenario price targets (RBC upside/downside scenarios, JPM bull/bear cases), numeric, same currency as target. Include only the scenarios actually stated; omit the field entirely if none.
${source === "morningstar" ? `  ,"stars": <1-5>,                                          // the Morningstar star rating. Omit if not stated.
  "fairValue": <number>,                                    // the Fair Value Estimate, numeric. Omit if not stated.
  "moat": "wide" | "narrow" | "none",                       // the Economic Moat rating. Omit if not stated.
  "moatTrend": "positive" | "stable" | "negative",          // the Moat Trend. Omit if not stated.
  "capitalAllocation": "exemplary" | "standard" | "poor",   // the Capital Allocation rating. Omit if not stated.
  "uncertainty": "low" | "medium" | "high" | "very-high" | "extreme"  // the Uncertainty rating. Omit if not stated.` : ""}
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

/** Returns null when the response could not be parsed AT ALL — distinct from a
 *  successful parse that happens to be empty. The caller must not cache a
 *  null: an unparseable response used to become a permanently empty report
 *  for that PDF (the result was cached unconditionally), silently stripping
 *  the rating, target, thesis and risks that feed scoring and the thesis
 *  evidence block. */
function parseExtraction(text: string): ExtractedReport | null {
  const res = parseModelJson<Record<string, unknown>>(text);
  if (!res.ok) {
    console.error("[analyst-extract] JSON parse failed:", res.error, res.excerpt ? `\n…${res.excerpt}…` : "");
    return null;
  }
  const parsed = res.value;

  const out: ExtractedReport = {};
  if (typeof parsed.rating === "string") {
    const r = parsed.rating.toLowerCase();
    if (r === "outperform" || r === "neutral" || r === "underperform") out.rating = r as AnalystRating;
  }
  if (typeof parsed.target === "number" && Number.isFinite(parsed.target)) out.target = parsed.target;
  if (typeof parsed.targetCurrency === "string") {
    const cur = parsed.targetCurrency.toUpperCase().trim();
    // Accept any valid-looking ISO 4217 currency code (3 uppercase letters)
    if (/^[A-Z]{3}$/.test(cur)) out.targetCurrency = cur;
  }
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
  // ── Finding 14 fields (all optional; absent on pre-widening cache hits) ──
  if (Array.isArray(parsed.catalysts)) {
    out.catalysts = parsed.catalysts
      .filter((c: unknown): c is Record<string, unknown> => c !== null && typeof c === "object")
      .map((c: Record<string, unknown>) => ({
        ...(typeof c.date === "string" && c.date.trim() ? { date: c.date.trim() } : {}),
        event: typeof c.event === "string" ? c.event.trim() : "",
        ...(typeof c.detail === "string" && c.detail.trim() ? { detail: c.detail.trim() } : {}),
      }))
      .filter((c) => c.event)
      .slice(0, 5);
    if (out.catalysts.length === 0) delete out.catalysts;
  }
  if (typeof parsed.valuationBasis === "string" && parsed.valuationBasis.trim()) {
    out.valuationBasis = parsed.valuationBasis.trim();
  }
  if (parsed.scenarios && typeof parsed.scenarios === "object") {
    const sc = parsed.scenarios as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const scenarios = { bull: num(sc.bull), base: num(sc.base), bear: num(sc.bear) };
    if (scenarios.bull != null || scenarios.base != null || scenarios.bear != null) {
      out.scenarios = scenarios;
    }
  }
  return out;
}

export type ExtractResult = {
  result: ExtractedReport;
  extractedAt: string;
  hash: string;
  cached: boolean;
};

export async function extractAnalystReport(opts: {
  ticker: string;
  source: AnalystSource;
  dataUrl: string;
  force?: boolean;
}): Promise<ExtractResult> {
  const { ticker, source, dataUrl, force } = opts;
  const hash = hashDataUrl(dataUrl);

  if (!force) {
    const cache = await readCache();
    if (cache[hash]) {
      return {
        result: cache[hash].result,
        extractedAt: cache[hash].extractedAt,
        hash,
        cached: true,
      };
    }
  }

  const pdfBlocks = buildPdfBlocks(dataUrl);
  if (pdfBlocks.length === 0) {
    throw new Error("Failed to decode PDF dataUrl");
  }

  const msg = await client.messages.create({
    model: "claude-sonnet-5",
    // No sampling parameters: temperature/top_p/top_k are removed on Sonnet 5
    // (400 if sent). Extraction consistency comes from the strict JSON schema
    // in PROMPT_TEMPLATE and the hash-gated cache, not from a temperature knob.
    thinking: { type: "disabled" },
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          ...pdfBlocks,
          { type: "text", text: PROMPT_TEMPLATE(ticker.toUpperCase(), source) },
        ],
      },
    ],
  });

  let text = "";
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
  }

  const result = parseExtraction(text);
  if (result === null) {
    // Do NOT cache: caching an unparseable response made the empty result
    // permanent for this PDF (same hash → cache hit → same empty report).
    // Throwing instead surfaces it — the ingest route logs an inbox event and
    // returns 500, which the Apps Script retries, and model output varies
    // enough that a retry usually parses.
    throw new Error("Could not parse the extraction response — report not stored; retry to re-extract");
  }
  const extractedAt = new Date().toISOString();

  const cache = await readCache();
  cache[hash] = { result, extractedAt };
  await writeCache(cache);

  return { result, extractedAt, hash, cached: false };
}
