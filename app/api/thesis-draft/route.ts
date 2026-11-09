import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import type { KillConditionKind, MetricSpec, ThesisPillar, PillarMeasure, PillarStance, ThesisTheme } from "@/app/lib/kill-conditions";
import { buildTickerEvidence } from "@/app/lib/thesis-evidence";
import { parseModelJson } from "@/app/lib/json-repair";
import { loadStreetTakeaways, formatStreetTakeawaysForPrompt, type StreetTakeawaysStore } from "@/app/lib/street-takeaways";
import { availableMetricLines, labelMatches, recapHistoryBlock, recapLineLabels } from "@/app/lib/metric-resolver";
import { canonicalTicker } from "@/app/lib/ticker";
import { abbreviationRule } from "@/app/lib/prose-style";
import type { SynthesisScreenCache, SynthesisEntry } from "@/app/lib/synthesis-screen-display";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";
import { POLICY_TEXT } from "@/app/lib/agents/policy";
import { webResearch } from "@/app/lib/web-research";
import { loadThemes } from "@/app/lib/themes";

/**
 * POST /api/thesis-draft { ticker } — AI-drafted LONG-TERM thesis (Phase 2).
 *
 * One research call (Sonnet, main key — Draft with AI is not a watcher) writes
 * the whole thesis for the PM to read and sign:
 *   - "why I own it" (3-5 bullets)
 *   - 3-5 PILLARS: the durable drivers that must stay true for years, each
 *     with the reported lines to track as its evidence (`measures`), and a
 *     PROPOSED status (intact / watch / broken) with the evidence behind it
 *   - 1-3 THESIS BREAKERS: long-horizon conditions that end the case
 *     (custom, AI-verified after each report), plus at most one
 *     company-reported `metric` guard per pillar
 *   - THEMES: the investment themes the company belongs to and its place in
 *     each (e.g. AI data-centre buildout — what it supplies, how much of
 *     revenue), researched on the web
 *
 * Inputs: the synthesis, the stored generated thesis / bear case / company
 * summary, the PM's analyst reports + FactSet alerts, EVERY reported line
 * from the last 6 FactSet Metrics Recaps (the multi-quarter trend), the
 * latest Transcript Intelligence, and up to 6 web searches for the 10-K
 * business description, long-term targets and the theme position.
 *
 * Short-term signals (SIA, Equate, MarketEdge, score, revisions, technicals)
 * are NOT proposed as conditions any more: under the policy a stock is sold
 * when its thesis weakens, and none of those can say that.
 *
 * DESIGN RULE — draft, never commit: this route writes NOTHING to Redis. The
 * response fills the ThesisTile editor and the PM signs by saving.
 */

export const maxDuration = 300;

const client = new Anthropic();

type DraftCondition = {
  kind: KillConditionKind;
  threshold?: number;
  note?: string;
  theme?: string;
  pillarId?: string;
  metric?: MetricSpec;
};
type Draft = { why: string; pillars: ThesisPillar[]; conditions: DraftCondition[]; themes: ThesisTheme[] };

const MIN_PILLARS = 3;
const MAX_PILLARS = 5;
const MAX_BREAKERS = 3;
const MAX_NOTE = 300;
const STANCES = new Set(["intact", "watch", "broken"]);

function clipNote(t: string, max = MAX_NOTE): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s(\[,;:—-]+$/, "") + "…";
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "pillar";

/** Validate + normalise the model's proposal. Invalid rows are dropped, not
 *  guessed at — the PM reviews whatever survives. */
function sanitize(raw: unknown, lineLabels: { results: string[]; guidance: string[] }, latest: { results: string[]; guidance: string[] }): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { why?: unknown; pillars?: unknown; breakers?: unknown; themes?: unknown };
  const why = typeof o.why === "string" ? o.why.trim() : "";
  if (!why) return null;

  const pillars: ThesisPillar[] = [];
  const conditions: DraftCondition[] = [];
  const seenTitles = new Set<string>();
  for (const p of Array.isArray(o.pillars) ? o.pillars : []) {
    if (!p || typeof p !== "object") continue;
    const pp = p as Record<string, unknown>;
    const title = String(pp.title ?? "").trim().slice(0, 40);
    const claim = String(pp.claim ?? "").trim().slice(0, 260);
    if (!title || !claim || seenTitles.has(title.toLowerCase())) continue;
    seenTitles.add(title.toLowerCase());
    const id = `${slug(title)}-${pillars.length + 1}`;

    // Measures: only lines that exist in the recaps on file (otherwise the
    // trend can never be read). Up to 3.
    const measures: PillarMeasure[] = [];
    for (const m of Array.isArray(pp.measures) ? pp.measures : []) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      const match = typeof mm.match === "string" ? mm.match.trim().slice(0, 60) : "";
      const mode = mm.mode === "guidance" ? "guidance" : mm.mode === "actual" ? "actual" : "yoy";
      if (!match) continue;
      const pool = mode === "guidance" ? lineLabels.guidance : lineLabels.results;
      const hit = pool.find((l) => labelMatches(l, match));
      if (!hit) continue;
      if (measures.some((x) => x.match.toLowerCase() === hit.toLowerCase() && (x.source === "guidance") === (mode === "guidance") && (x.field === "yoy") === (mode === "yoy"))) continue;
      measures.push({
        label: mode === "yoy" ? `${hit} YoY` : mode === "guidance" ? `${hit} guide` : hit,
        source: mode === "guidance" ? "guidance" : "results",
        match: hit,
        ...(mode === "yoy" ? { field: "yoy" as const } : {}),
      });
      if (measures.length >= 3) break;
    }

    const status = typeof pp.status === "string" && STANCES.has(pp.status) ? (pp.status as PillarStance) : undefined;
    const statusNote = typeof pp.statusNote === "string" && pp.statusNote.trim() ? clipNote(pp.statusNote.trim(), 280) : undefined;
    pillars.push({
      id,
      title,
      claim,
      ...(measures.length ? { measures } : {}),
      ...(status ? { status, statusBy: "ai" as const } : {}),
      ...(status && statusNote ? { statusNote } : {}),
    });

    // Optional single metric guard per pillar — must exist in the LATEST recap
    // and must pass today.
    const g = pp.guard as Partial<MetricSpec> | undefined;
    if (g && typeof g === "object" && typeof g.match === "string" && typeof g.threshold === "number" && Number.isFinite(g.threshold)) {
      const source = g.source === "guidance" ? "guidance" : "results";
      const pool = source === "results" ? latest.results : latest.guidance;
      if (pool.some((line) => labelMatches(line.split(":")[0] ?? line, g.match!))) {
        conditions.push({
          kind: "metric",
          pillarId: id,
          theme: title,
          metric: {
            label: (typeof g.label === "string" && g.label.trim() ? g.label.trim() : g.match).slice(0, 60),
            source,
            match: g.match.trim().slice(0, 60),
            field: g.field === "yoy" ? "yoy" : "actual",
            period: typeof g.period === "string" && g.period.trim() ? g.period.trim().slice(0, 12) : undefined,
            comparator: g.comparator === "<=" ? "<=" : ">=",
            threshold: Math.round(g.threshold * 100) / 100,
            unit: typeof g.unit === "string" ? g.unit.slice(0, 2) : undefined,
          },
        });
      }
    }
    if (pillars.length >= MAX_PILLARS) break;
  }
  if (pillars.length < MIN_PILLARS - 1) return null; // 2 is tolerated; fewer is not a thesis

  const byTitle = new Map(pillars.map((p) => [p.title.toLowerCase(), p]));
  let breakers = 0;
  for (const b of Array.isArray(o.breakers) ? o.breakers : []) {
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const note = typeof bb.note === "string" ? clipNote(bb.note.trim()) : "";
    if (!note) continue;
    const pillar = typeof bb.pillar === "string" ? byTitle.get(bb.pillar.trim().toLowerCase()) : undefined;
    conditions.push({ kind: "custom", note, pillarId: pillar?.id, theme: (pillar?.title ?? (typeof bb.theme === "string" ? bb.theme : "")).slice(0, 40) || undefined });
    if (++breakers >= MAX_BREAKERS) break;
  }

  const themes: ThesisTheme[] = [];
  for (const t of Array.isArray(o.themes) ? o.themes : []) {
    if (!t || typeof t !== "object") continue;
    const tt = t as Record<string, unknown>;
    const name = typeof tt.name === "string" ? tt.name.trim().slice(0, 50) : "";
    const role = typeof tt.role === "string" ? tt.role.trim().slice(0, 220) : "";
    if (!name || !role || themes.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const exposure = typeof tt.exposure === "string" && tt.exposure.trim() ? tt.exposure.trim().slice(0, 60) : undefined;
    themes.push({ name, role, ...(exposure ? { exposure } : {}) });
    if (themes.length >= 3) break;
  }

  return { why, pillars, conditions, themes };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    const redis = await getRedis();
    const [{ context, killWatch }, stocksRaw, evidence, takeaways, synthRaw, thesesRaw, casesRaw] = await Promise.all([
      loadAlertInputs(),
      redis.get("pm:stocks"),
      buildTickerEvidence(tk),
      loadStreetTakeaways().catch(() => ({})),
      redis.get("pm:synthesis-screen-cache"),
      redis.get("pm:position-theses"),
      redis.get("pm:entry-cases"),
    ]);
    const ctx = context[tk];
    if (!ctx) return NextResponse.json({ error: "unknown ticker" }, { status: 404 });

    // Metrics already PROVEN unverifiable for this name — never re-proposed.
    let blocked: string[] = [];
    try {
      const theses = thesesRaw ? (JSON.parse(thesesRaw) as Record<string, { unverifiableNotes?: string[]; killConditions?: { note?: string; aiCheck?: { undisclosed?: boolean } }[] }>) : {};
      const t = theses[tk] ?? theses[tk.toUpperCase()];
      const fromStore = t?.unverifiableNotes ?? [];
      const fromLive = (t?.killConditions ?? []).filter((c) => c?.aiCheck?.undisclosed && c.note).map((c) => c.note as string);
      blocked = [...new Set([...fromStore, ...fromLive])].slice(-12);
    } catch { /* draft normally */ }

    type StoredStock = {
      ticker?: string; investmentThesis?: string; bearCase?: string; companySummary?: string;
      healthData?: { currentPrice?: number; twoHundredDayAvg?: number }; price?: number;
      sia?: number; marketEdge?: { opinion?: string; powerRating?: number };
      instrumentType?: string; name?: string;
      fundData?: {
        category?: string; fundFamily?: string; expenseRatio?: number;
        topHoldings?: Array<{ symbol?: string; name?: string; weight?: number }>;
        sectorWeightings?: Array<{ sector?: string; weight?: number }>;
        performance?: Record<string, number | undefined>;
        categoryPerformance?: Record<string, number | undefined>;
      };
    };
    const stocks: StoredStock[] = stocksRaw ? JSON.parse(stocksRaw) : [];
    const stock = stocks.find((s) => (s.ticker || "").toUpperCase() === tk);
    // The synthesis — the primary source for pillars.
    let synth: SynthesisEntry | undefined;
    try {
      const cache = synthRaw ? (JSON.parse(synthRaw) as SynthesisScreenCache) : {};
      synth = cache[canonicalTicker(tk)] ?? cache[tk];
    } catch { synth = undefined; }
    const bullets = (arr: Array<{ text?: string; point?: string } | string> | undefined) =>
      (arr ?? []).map((b) => (typeof b === "string" ? b : (b as { text?: string; point?: string }).text ?? (b as { point?: string }).point ?? JSON.stringify(b))).slice(0, 5).map((t) => `  • ${t}`).join("\n");
    const synthBlock = synth
      ? [
          `SYNTHESIS (${synth.generatedAt.slice(0, 10)}, verdict ${synth.result.verdict}: ${synth.result.verdictReason})`,
          synth.result.whatTheyDo ? `What they do: ${synth.result.whatTheyDo}` : null,
          `Base case:\n${bullets(synth.result.base as never)}`,
          `Bull case:\n${bullets(synth.result.bull as never)}`,
          `Bear case:\n${bullets(synth.result.bear as never)}`,
          `Key debate: ${synth.result.keyDebate}`,
          synth.result.wouldChangeCall?.length ? `Would change the call:\n${synth.result.wouldChangeCall.map((w) => `  • ${w}`).join("\n")}` : null,
          synth.result.catalysts?.length ? `Catalysts: ${synth.result.catalysts.map((c) => `${c.date ? `${c.date}: ` : ""}${c.event}`).join("; ")}` : null,
        ].filter(Boolean).join("\n")
      : "(no synthesis on file — generate one on Ideas › Synthesis first for a better draft)";

    const store = takeaways as StreetTakeawaysStore;
    const available = availableMetricLines(store, tk);
    const lineLabels = recapLineLabels(store, tk);
    const history = recapHistoryBlock(store, tk, 6);
    const historyBlock = history
      ? `REPORTED HISTORY — every line from the last FactSet Metrics Recaps, oldest first. Read the TREND, not one print. Pillar "measures" may reference ONLY these line labels:\n${history}`
      : "NO FACTSET METRICS RECAP ON FILE for this name — leave every pillar's \"measures\" empty and propose no \"guard\".";
    const transcripts = (store[tk] ?? []).filter((t) => t.kind === "transcript").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2);
    const transcriptBlock = transcripts.length ? formatStreetTakeawaysForPrompt(transcripts) : "";

    const existing = killWatch.find((k) => k.ticker === tk);
    let existingPillars = "";
    try {
      const theses = thesesRaw ? (JSON.parse(thesesRaw) as Record<string, { pillars?: ThesisPillar[] }>) : {};
      const ps = theses[tk]?.pillars ?? [];
      existingPillars = ps.map((p) => `  - ${p.title}: ${p.claim}${p.status ? ` [signed status ${p.status}${p.statusNote ? `: ${p.statusNote}` : ""}]` : ""}`).join("\n");
    } catch { /* none */ }
    let watchingWhy = "";
    try {
      const cases = casesRaw ? (JSON.parse(casesRaw) as Record<string, { why?: string; addedAt?: string }>) : {};
      const c = cases[tk] ?? cases[canonicalTicker(tk)];
      if (c?.why) watchingWhy = `${c.why}${c.addedAt ? ` (captured ${c.addedAt.slice(0, 10)})` : ""}`;
    } catch { /* none */ }

    const isFund = Boolean(stock?.instrumentType && stock.instrumentType !== "stock");
    const fd = stock?.fundData;
    const fundBlock = isFund
      ? [
          `THIS IS A FUND / ETF held as a long-run position. Under the policy a Thematic fund is held for a MANAGER who can outperform: pillars are the mandate (the exposure it exists to deliver), the manager and their record, and the vehicle (fees, structure). Leave "measures" empty and propose no "guard".`,
          fd?.category ? `Category: ${fd.category}${fd.fundFamily ? ` · ${fd.fundFamily}` : ""}${typeof fd.expenseRatio === "number" ? ` · MER ${fd.expenseRatio}%` : ""}` : null,
          fd?.topHoldings?.length ? `Top holdings: ${fd.topHoldings.slice(0, 10).map((h) => `${h.symbol ?? h.name}${typeof h.weight === "number" ? ` ${h.weight.toFixed(1)}%` : ""}`).join(", ")}` : "Top holdings: not on file",
          fd?.sectorWeightings?.length ? `Sectors: ${fd.sectorWeightings.slice(0, 6).map((w) => `${w.sector} ${typeof w.weight === "number" ? w.weight.toFixed(0) : "?"}%`).join(", ")}` : null,
          fd?.performance ? `Fund returns: ${Object.entries(fd.performance).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${(v as number).toFixed(1)}%`).join(" · ")}` : null,
          fd?.categoryPerformance ? `Category returns: ${Object.entries(fd.categoryPerformance).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${(v as number).toFixed(1)}%`).join(" · ")}` : null,
        ].filter(Boolean).join("\n")
      : "";

    const generated = [
      stock?.companySummary ? `Company summary: ${stock.companySummary.slice(0, 800)}` : null,
      stock?.investmentThesis ? `Generated investment thesis (from scoring): ${stock.investmentThesis.slice(0, 1200)}` : null,
      stock?.bearCase ? `Generated bear case: ${stock.bearCase.slice(0, 800)}` : null,
    ].filter(Boolean).join("\n");

    const themeStore = await loadThemes();
    const knownThemes = Object.values(themeStore.themes).filter((t) => !t.archivedAt).map((t) => t.name);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are writing a portfolio manager's LONG-TERM investment thesis for ${tk} — ${ctx.name || ""}${ctx.sector ? ` (${ctx.sector})` : ""}. Today is ${today}. The PM will read it and sign it; you do the research and the writing.

${POLICY_TEXT}

WHAT A THESIS IS HERE: the three to five things that must stay true for this ${isFund ? "fund" : "company"} to be worth owning for YEARS. Quarterly noise, the share price and technical readings are not pillars and never break a thesis.
${fundBlock ? `\n${fundBlock}\n` : ""}
RESEARCH (you have web search, up to 6 searches). Use it for what the material below lacks:
${isFund ? "- the fund's mandate, manager tenure and long-run record vs its benchmark" : `- the latest annual report (10-K / AIF): segments and what drives each
- long-term targets from the latest investor day or management commentary
- the investment THEMES the company belongs to (for example the AI data-centre buildout) and its position in each: what it supplies, to whom, how exposed it is (share of revenue), and how secure that position is`}
Prefer the PM's own material below when it covers a point; cite web facts by source.

${synthBlock}

${generated ? `GENERATED CONTEXT:\n${generated}\n` : ""}${evidence ? `INGESTED ANALYST & FACTSET EVIDENCE (dated, attributable — prefer these figures):\n${evidence}\n` : ""}
${historyBlock}
${transcriptBlock ? `\nLATEST EARNINGS-CALL TRANSCRIPT NOTES:\n${transcriptBlock}\n` : ""}${watchingWhy ? `\nWHY THE PM WAS WATCHING THIS NAME:\n${watchingWhy}\n` : ""}${existing?.why ? `\nEXISTING THESIS (being redrafted — keep what still holds, drop what the evidence no longer supports):\n${existing.why}\n` : ""}${existingPillars ? `EXISTING PILLARS:\n${existingPillars}\n` : ""}${blocked.length ? `\nALREADY PROVEN UNVERIFIABLE FOR THIS NAME — never propose these or a close variant:\n${blocked.map((b) => `- ${b}`).join("\n")}\n` : ""}
When the research is done, answer with ONE JSON object and nothing else:
{
  "why": "3-5 bullet lines separated by \\n, each starting with '• '. The long-term case in plain words, each with the figure it rests on and its source inline, e.g. '(FactSet Q2 recap)' / '(10-K 2025)'. Final bullet starts '• Wrong if: '.",
  "themes": [ { "name": "short theme name, e.g. AI data-centre buildout${knownThemes.length ? ` — REUSE one of the PM's themes when the company fits: ${knownThemes.join("; ")}` : ""}", "role": "the company's place in it in one sentence", "exposure": "e.g. ~60% of revenue (10-K 2025)" } ],
  "pillars": [
    {
      "title": "2-5 words",
      "claim": "one falsifiable sentence about the long term, with the figure it rests on",
      "measures": [ { "match": "<a line label EXACTLY as printed in REPORTED HISTORY>", "mode": "yoy" | "actual" | "guidance" } ],
      "status": "intact" | "watch" | "broken",
      "statusNote": "one or two sentences: the evidence for that status, with figures, dates and sources",
      "guard": { "label": "...", "source": "results" | "guidance", "match": "<label from the LATEST recap>", "field": "actual" | "yoy", "comparator": ">=" | "<=", "threshold": <number>, "unit": "%" | "$" | "" }
    }
  ],
  "breakers": [ { "pillar": "<pillar title>", "note": "a long-horizon condition that would END the case, checkable from what the company reports" } ]
}

Rules:
- 3 to 5 pillars, each a DIFFERENT durable driver (end-market demand, competitive position / moat, unit economics and margins, capital allocation and balance sheet, an industry-structure or regulatory fact). Where the company belongs to a theme, at least one pillar states its position in that theme.
- measures: 1-3 per pillar where REPORTED HISTORY prints a line that evidences it; [] otherwise. Never invent a label.
- status: judge each pillar on the multi-quarter evidence, not one print. "intact" unless the evidence shows sustained erosion ("watch") or a structural break ("broken"). A share-price fall is never evidence.
- guard: OPTIONAL, at most one per pillar, only on a line in the latest recap, set with room so today's print passes. Omit the key when not useful.
- breakers: 1 to 3. Structural, long-horizon (loss of a key customer, a regulatory change, losing the leadership position), each one test, under 250 characters, against something the company reports at least annually. Never a price, technical, rating or score condition.
- themes: 0 to 3; [] when the company belongs to no clear theme.
- No invented figures, segments, customers or events. Every figure has a source.
- ${abbreviationRule('the "why" bullets, the pillars and the breakers — each is displayed on its own')}`;

    let { text, sources } = await webResearch(prompt, { maxSearches: 6 });
    let parseResult = parseModelJson(text);
    if (!parseResult.ok) {
      console.warn(`[thesis-draft] ${tk} JSON parse failed, retrying once without search:`, parseResult.error, parseResult.excerpt ?? "");
      const retry = await client.messages.create({
        model: SONNET_MODEL,
        thinking: THINKING_OFF,
        max_tokens: 4000,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: text.slice(0, 12000) || "(no answer)" },
          { role: "user", content: "Reply again with the JSON object ONLY — no prose, no code fences, every string double-quoted with inner quotes escaped, newlines inside strings written as \\n." },
        ],
      });
      text = retry.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      parseResult = parseModelJson(text);
    }
    if (!parseResult.ok) {
      console.error(`[thesis-draft] ${tk} JSON parse failed twice:`, parseResult.error, parseResult.excerpt ?? "");
      return NextResponse.json({ error: `draft failed — unparseable response: ${parseResult.error}` }, { status: 502 });
    }
    const draft = sanitize(parseResult.value, lineLabels, available);
    if (!draft) return NextResponse.json({ error: "draft failed — model returned no usable proposal" }, { status: 502 });
    sources = sources.slice(0, 12);

    return NextResponse.json({ draft, sources, usedSynthesis: !!synth, recapLines: available.results.length + available.guidance.length });
  } catch (e) {
    console.error("thesis-draft error:", e);
    return NextResponse.json({ error: "draft failed" }, { status: 500 });
  }
}
