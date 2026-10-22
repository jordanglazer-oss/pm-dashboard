import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";
import { createLogger } from "@/app/lib/logger";
import type { ParsedRow, ParsedKind } from "@/app/lib/model-staging";
import type { EquityBucket, PimAssetClass } from "@/app/lib/pim-types";

/**
 * POST /api/model-staging/parse — model screenshot → rows.
 * Body: { dataUrl: "data:image/...;base64,..." }
 *
 * Read-only: no Redis read or write. The image is NOT stored anywhere (binaries
 * never go in Redis); only the parsed rows come back, and the client saves them
 * into the draft (pm:model-drafts) itself.
 */

const log = createLogger("Model-staging-parse");
const client = new Anthropic();

const PROMPT = `You are reading a screenshot of an investment model's holdings table (an Excel sheet). Extract EVERY holding row.

Typical columns: a section header naming the asset class ("Equities", "Fixed Income", "Alternatives") used as the name column header, "Weight (Asset Class)", "Weight (Portfolio)", "Symbol", "Currency".

For each row return:
  - "name": the security name as shown
  - "symbol": the symbol EXACTLY as shown (keep suffixes such as -T, .U, .F-T, .NE)
  - "currency": "CAD" or "USD"
  - "assetClass": "equity" | "fixedIncome" | "alternative" — from the section the row sits in
  - "kind": "stock" for a single company, "etf" for an exchange-traded fund, "fund" for a mutual fund (FUNDSERV codes like FID5982, DYN3361)
  - "classPct": the Weight (Asset Class) number as shown, e.g. 1.67 (no % sign); null if absent
  - "portfolioPct": the Weight (Portfolio) number as shown, e.g. 1.10; null if absent
  - "fill": the row's background colour as one or two plain words (e.g. "orange", "light blue", "green", "purple", "white")
  - "bucket": the equity bucket, decided by COLOUR BAND, never by the name:
      "alpha"    — individual company stocks (whatever their colour)
      "core"     — the fund colour band that contains the broad-market index ETFs (S&P 500 / total-market)
      "thematic" — any other fund colour band (a small-cap index fund sitting in that band is still thematic)
    Use null for non-equity rows, or when the rows are not colour-coded.

Rules: read numbers exactly as printed, do not round or recompute; skip header and total rows; never invent a row.
Respond with ONLY a JSON array, no prose, no code fences. If you cannot read it, respond [].`;

const KINDS: ParsedKind[] = ["stock", "etf", "fund"];
const CLASSES: PimAssetClass[] = ["equity", "fixedIncome", "alternative"];
const BUCKETS: EquityBucket[] = ["core", "thematic", "alpha"];

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseRows(text: string): ParsedRow[] {
  const cleaned = text.replace(/```json\s*|```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: ParsedRow[] = [];
  for (const r of arr as Record<string, unknown>[]) {
    if (!r || typeof r.symbol !== "string" || !r.symbol.trim()) continue;
    const symbol = r.symbol.trim().toUpperCase();
    const currency = String(r.currency ?? "").toUpperCase() === "USD" ? "USD" : "CAD";
    const assetClass = CLASSES.includes(r.assetClass as PimAssetClass) ? (r.assetClass as PimAssetClass) : "equity";
    const kind = KINDS.includes(r.kind as ParsedKind) ? (r.kind as ParsedKind) : "etf";
    out.push({
      name: String(r.name ?? symbol).trim(),
      symbol,
      currency,
      assetClass,
      kind,
      classPct: num(r.classPct),
      portfolioPct: num(r.portfolioPct),
      ...(assetClass === "equity" && BUCKETS.includes(r.bucket as EquityBucket)
        ? { bucket: kind === "stock" ? "alpha" : r.bucket === "alpha" ? "thematic" : (r.bucket as EquityBucket) }
        : {}),
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { dataUrl?: string };
    const m = typeof body.dataUrl === "string" ? body.dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/) : null;
    if (!m) return NextResponse.json({ error: "dataUrl (image) required" }, { status: 400 });
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    const mediaType = (allowed as readonly string[]).includes(m[1]) ? (m[1] as (typeof allowed)[number]) : "image/png";

    const msg = await client.messages.create({
      model: SONNET_MODEL,
      thinking: THINKING_OFF,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image", source: { type: "base64", media_type: mediaType, data: m[2].replace(/\s/g, "") } },
          ],
        },
      ],
    });
    const text = msg.content.find((b) => b.type === "text");
    const raw = text && text.type === "text" ? text.text : "";
    const rows = parseRows(raw);
    log.info(`parsed ${rows.length} rows`);
    if (rows.length === 0) log.warn("no rows — raw output:", raw.slice(0, 2000));
    return NextResponse.json({ rows });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "could not read the screenshot" }, { status: 500 });
  }
}
