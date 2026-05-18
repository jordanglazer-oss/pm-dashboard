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

const CACHE_KEY = "pm:analyst-report-extract-cache";
const client = new Anthropic();

export type AnalystSource = "rbc" | "jpm";
export const VALID_SOURCES: readonly AnalystSource[] = ["rbc", "jpm"] as const;

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
  "rating": "outperform" | "neutral" | "underperform",     // map bank-specific terms: RBC (Outperform/Sector Perform/Underperform), JPM (Overweight/Neutral/Underweight). Omit if not stated.
  "target": <number>,                                       // 12-month price target, numeric, no currency symbol. Omit if not stated.
  "targetCurrency": "USD" | "CAD" | "EUR" | "GBP" | "GBp" | "DKK" | ...,  // ISO 4217 currency code of the target. See rules below.
  "asOf": "YYYY-MM-DD",                                     // publication date of THIS report. Omit if not clearly stated.
  "thesis": ["bullet 1", "bullet 2", ...],                  // 3-5 dense bullets capturing the analyst's investment thesis (bull case if Outperform, bear case if Underperform, sideways thesis if Neutral). Each bullet ≤ 25 words.
  "risks": ["risk 1", "risk 2", ...],                       // 2-4 bullets capturing key downside risks the report flags. ≤ 25 words each.
  "sectorView": "one sentence",                             // the analyst's sector / industry outlook if it's mentioned in this report. Omit if absent.
  "keyMetrics": [{"label": "...", "value": "..."}, ...]     // 3-6 named numeric data points the analyst uses to support their thesis (e.g. {"label": "FY27 EPS estimate", "value": "$12.40"}). Omit if none.
}

CURRENCY EXTRACTION RULES (critical — the dashboard converts targets between currencies and getting this wrong corrupts the displayed price target):
- Read the currency directly from the PDF wherever the price target appears. Look for explicit notation: "$245 USD", "C$330", "€185", "DKK 1,720", "£12.50", "1,500p" or "1,500 GBp" (London pence), etc.
- Use ISO 4217 codes: USD, CAD, EUR, GBP, DKK, SEK, NOK, CHF, JPY, AUD, NZD, HKD, SGD, CNY, KRW, INR, MXN, BRL, ZAR, ILS.
- LONDON LISTINGS commonly quote in pence (GBp), NOT pounds. If the target is "1,500" on a UK stock, that's almost certainly pence. Use "GBp" (case-sensitive!) for pence and "GBP" for pounds. Same applies to Johannesburg (ZAc = SA cents) and Tel Aviv (ILA = agorot).
- If the analyst is a US/Canada/Europe desk, the currency notation is usually a single character symbol — disambiguate carefully:
   - "$" alone in an RBC US report → USD; in an RBC Canada report → CAD; check the report's cover or footer for the issuing entity.
   - "$" in a JPM US report → USD; in JPM Toronto → CAD.
   - "€" → EUR; "£" → GBP (or GBp if pence); "¥" → JPY (or CNY for China desks — disambiguate from the entity).
- Look at the report's cover page, footer disclaimer, or the line containing the price target. The issuing entity ("RBC Capital Markets, LLC" = US/USD; "RBC Dominion Securities Inc." = Canada/CAD; "J.P. Morgan Securities Asia Pacific" = often local currency) is usually clear.
- If you genuinely cannot determine the currency, OMIT the targetCurrency field entirely. Do NOT guess. The system will flag the entry as "currency unverified" and the user will manually correct it.

Rules:
- Use ONLY information present in the PDF. Do NOT supplement with external knowledge.
- Numbers go in as raw numbers without dollar signs or commas (target: 245.50, not "$245.50").
- For minor-unit currencies (GBp, ZAc, ILA), report the target AS WRITTEN in the PDF — e.g. London target "1,500p" → target: 1500, targetCurrency: "GBp". The dashboard handles the /100 normalization.
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
    if (r === "outperform" || r === "neutral" || r === "underperform") out.rating = r as AnalystRating;
  }
  if (typeof parsed.target === "number" && Number.isFinite(parsed.target)) out.target = parsed.target;
  // Currency: validate that the string looks like an ISO 4217 code (3-letter
  // uppercase) or one of the minor-unit notations (GBp, GBX, ZAc, ILA). Strip
  // anything that doesn't match so a hallucinated "$USD" doesn't leak through.
  if (typeof parsed.targetCurrency === "string") {
    const raw = parsed.targetCurrency.trim();
    const isMajor = /^[A-Z]{3}$/.test(raw);
    const isMinor = /^(GBp|GBX|GBx|ZAc|ILa|ILA)$/.test(raw);
    if (isMajor || isMinor) out.targetCurrency = raw;
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
    model: "claude-sonnet-4-6",
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
  const extractedAt = new Date().toISOString();

  const cache = await readCache();
  cache[hash] = { result, extractedAt };
  await writeCache(cache);

  return { result, extractedAt, hash, cached: false };
}
