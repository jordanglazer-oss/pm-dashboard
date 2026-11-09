import { NextRequest, NextResponse } from "next/server";
import { loadFundRows, sanitizePager } from "@/app/lib/fund-one-pagers";
import { webResearch } from "@/app/lib/web-research";
import { parseModelJson } from "@/app/lib/json-repair";

/**
 * POST /api/fund-one-pagers/draft { symbol } — "Draft with AI" for one
 * fund's client one-pager (MAIN key — a PM tool like thesis drafting —
 * Sonnet with up to 5 web searches, ~10-15¢). Uses the fund facts on file
 * for every figure. Writes NOTHING; the PM edits and signs.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROMPT = (facts: string) => `You are drafting a ONE-PAGE client explainer for a wealth-management team: why we own this fund / ETF. Advisors will use it to explain the holding to clients, so write in plain, confident, compliant language: no promises, no predictions of returns, no jargon without a short explanation.

Research the fund on the web (at most 5 searches): the manager / firm, the team and how long they have run it, the investment philosophy and process, and anything notable recently (manager change, fee change, strategy change). Prefer the fund company's own pages and Morningstar.

Use ONLY the figures in the FACTS block for performance, fees and assets (they are what our dashboard shows); do not quote other performance numbers. If a fact is missing, leave it out rather than guess.

=== FACTS (from our dashboard) ===
${facts}

Return ONLY this JSON, no markdown:
{
  "name": "full fund name",
  "headline": "one sentence a client can take away",
  "whyWeOwn": ["3-4 short reasons, each one sentence"],
  "manager": { "firm": "", "team": "lead managers and their role", "since": "how long the team has run it, e.g. 'since 2014'", "philosophy": "2-3 sentences" },
  "process": "3-4 sentences on how they pick and size holdings",
  "role": "2 sentences: its job in our portfolio (Core = broad market exposure; Thematic = a manager we believe can outperform in a long-term theme)",
  "record": "2-3 sentences on the record versus its category using the FACTS figures, balanced (mention weaker periods too)",
  "fees": "one sentence on the fee (MER) in context",
  "risks": ["2-4 plain risks a client should understand"],
  "talkingPoints": ["4-6 short client-ready lines"],
  "watch": "one sentence, internal: what would make us reconsider the holding",
  "sources": [ { "url": "", "title": "" } ]
}`;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { symbol?: unknown };
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const fund = (await loadFundRows()).find((f) => f.symbol.toUpperCase() === symbol);
  if (!fund) return NextResponse.json({ error: "not a fund in the PIM model" }, { status: 404 });
  const f = fund.facts;
  const p = (x?: number) => (x == null ? "?" : `${x}%`);
  const facts = [
    `Symbol: ${fund.symbol}${fund.name ? ` — ${fund.name}` : ""}`,
    `Our bucket: ${fund.bucket === "core" ? "Core" : fund.bucket === "thematic" ? "Thematic" : fund.bucket === "fixedIncome" ? "Fixed income" : "Other"}; ${(fund.weightInClass * 100).toFixed(1)}% of the ${fund.assetClass === "equity" ? "equity" : fund.assetClass} class in our model`,
    f.category ? `Category: ${f.category}` : "",
    f.fundFamily ? `Fund family: ${f.fundFamily}` : "",
    f.expenseRatio != null ? `MER / expense ratio: ${f.expenseRatio}%` : "",
    f.aum != null ? `Assets: ${(f.aum / 1e9).toFixed(2)}B` : "",
    f.starRating != null ? `Morningstar rating: ${f.starRating} stars` : "",
    f.perf ? `Annualised returns — fund: 1y ${p(f.perf.oneYear)}, 3y ${p(f.perf.threeYear)}, 5y ${p(f.perf.fiveYear)}` : "",
    f.categoryPerf ? `Category average: 1y ${p(f.categoryPerf.oneYear)}, 3y ${p(f.categoryPerf.threeYear)}, 5y ${p(f.categoryPerf.fiveYear)}` : "",
    f.topHoldings?.length ? `Top holdings: ${f.topHoldings.map((h) => `${h.name || h.symbol} ${h.weight}%`).join(", ")}` : "",
    f.asOf ? `Data as of ${f.asOf}` : "",
  ].filter(Boolean).join("\n");
  try {
    let r = await webResearch(PROMPT(facts), { maxSearches: 5, maxTokens: 3500 });
    let parsed = parseModelJson<Record<string, unknown>>(r.text);
    if (!parsed.ok) {
      r = await webResearch(`${PROMPT(facts)}\n\nAnswer from what you know without searching; JSON only.`, { maxSearches: 1, maxTokens: 3000 });
      parsed = parseModelJson<Record<string, unknown>>(r.text);
    }
    if (!parsed.ok) return NextResponse.json({ error: `unparseable draft: ${parsed.error}` }, { status: 502 });
    const draft = sanitizePager({ ...parsed.value, aiDrafted: true, sources: [...(Array.isArray(parsed.value.sources) ? parsed.value.sources : []), ...r.sources] }, fund.symbol);
    return NextResponse.json({ draft });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "draft failed" }, { status: 500 });
  }
}
