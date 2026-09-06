import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { KILL_TEMPLATES, type KillConditionKind, type MetricSpec, type ThesisPillar } from "@/app/lib/kill-conditions";
import { buildTickerEvidence } from "@/app/lib/thesis-evidence";
import { parseModelJson } from "@/app/lib/json-repair";
import { loadStreetTakeaways } from "@/app/lib/street-takeaways";
import { availableMetricLines, labelMatches } from "@/app/lib/metric-resolver";
import { canonicalTicker } from "@/app/lib/ticker";
import type { SynthesisScreenCache, SynthesisEntry } from "@/app/lib/synthesis-screen-display";

/**
 * POST /api/thesis-draft { ticker } — AI-drafted thesis: pillars + conditions.
 *
 * The generation half of the thesis-discipline build. One model call proposes
 * a PROPOSED "why I own it", the 2-4 PILLARS the case rests on, and one or two
 * pre-registered exit conditions per pillar — from material the app already
 * produced: the name's SYNTHESIS (base / bull / bear, key debate, "would change
 * the call"), the extracted RBC/JPM/Morningstar reports, the FactSet Metrics
 * Recap lines (the ONLY things a `metric` condition may reference — they are
 * what the deterministic resolver can read next quarter), and the live
 * position reads (SIA / Equate / MarketEdge).
 *
 * DESIGN RULE — draft, never commit: this route writes NOTHING to Redis. The
 * response fills the ThesisTile editor and the PM edits and signs by clicking
 * "Underwrite position" exactly as with a hand-written thesis. Pre-registration
 * only means something if the human commits to the conditions, so AI proposes
 * and the PM disposes.
 *
 * Condition priorities (agreed 2026-09-06): company-specific first. `metric`
 * conditions against reported lines, then `custom` (AI-verified) for pillars
 * the recap doesn't print, then at most two position reads (SIA / Equate /
 * MarketEdge / 200-day). Score floor / decay are NOT proposed — the score is a
 * summary of these inputs and says nothing about which pillar broke.
 */

const client = new Anthropic();

type DraftCondition = {
  kind: KillConditionKind;
  threshold?: number;
  note?: string;
  theme?: string;
  pillarId?: string;
  metric?: MetricSpec;
};
type Draft = { why: string; pillars: ThesisPillar[]; conditions: DraftCondition[] };

const VALID_KINDS = new Set<KillConditionKind>(KILL_TEMPLATES.map((t) => t.kind));
const POSITION_KINDS = new Set<KillConditionKind>(["sia_floor", "equate_rank", "marketedge", "ma200", "risk_alert", "revisions"]);
const MAX_PILLARS = 4;
const MAX_CONDITIONS = 8;
const MAX_POSITION = 2;
const MAX_NOTE = 300;

function clipNote(t: string): string {
  if (t.length <= MAX_NOTE) return t;
  const cut = t.slice(0, MAX_NOTE);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_NOTE * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s(\[,;:—-]+$/, "") + "…";
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "pillar";

/** Validate + normalise the model's proposal. Invalid rows are dropped, not
 *  guessed at — the PM reviews whatever survives. */
function sanitize(
  raw: unknown,
  available: { results: string[]; guidance: string[] },
  live: { aboveMa200: boolean | null; siaPercentile: number | null; equateRank: number | null | undefined; marketEdge: string | null; netRevisions: number | null },
): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { why?: unknown; pillars?: unknown; conditions?: unknown };
  const why = typeof o.why === "string" ? o.why.trim() : "";
  if (!why) return null;

  // Pillars: 2-4, unique titles.
  const pillars: ThesisPillar[] = [];
  const seenTitles = new Set<string>();
  for (const p of Array.isArray(o.pillars) ? o.pillars : []) {
    if (!p || typeof p !== "object") continue;
    const title = String((p as { title?: unknown }).title ?? "").trim().slice(0, 40);
    const claim = String((p as { claim?: unknown }).claim ?? "").trim().slice(0, 240);
    if (!title || !claim || seenTitles.has(title.toLowerCase())) continue;
    seenTitles.add(title.toLowerCase());
    pillars.push({ id: `${slug(title)}-${pillars.length + 1}`, title, claim });
    if (pillars.length >= MAX_PILLARS) break;
  }
  const pillarByTitle = new Map(pillars.map((p) => [p.title.toLowerCase(), p.id]));

  const conditions: DraftCondition[] = [];
  const seenPosition = new Set<KillConditionKind>();
  const availableLabels = [...available.results, ...available.guidance];
  for (const c of Array.isArray(o.conditions) ? o.conditions : []) {
    if (!c || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    const kind = cc.kind as KillConditionKind;
    if (!VALID_KINDS.has(kind)) continue;
    if (kind === "score_floor" || kind === "score_decay") continue; // not proposed any more
    const pillarTitle = typeof cc.pillar === "string" ? cc.pillar.trim().toLowerCase() : "";
    const pillarId = pillarByTitle.get(pillarTitle) ?? (pillars.length ? undefined : undefined);
    const themeRaw = cc.theme;
    const theme = (typeof themeRaw === "string" ? themeRaw.trim() : pillars.find((p) => p.id === pillarId)?.title ?? "").slice(0, 40) || undefined;
    const noteRaw = cc.note;
    const note = typeof noteRaw === "string" ? clipNote(noteRaw.trim()) : undefined;
    const thRaw = cc.threshold;
    const threshold = typeof thRaw === "number" && Number.isFinite(thRaw) ? Math.round(thRaw * 10) / 10 : undefined;

    if (kind === "metric") {
      const m = cc.metric as Partial<MetricSpec> | undefined;
      if (!m || typeof m !== "object") continue;
      const source = m.source === "guidance" ? "guidance" : "results";
      const match = typeof m.match === "string" ? m.match.trim() : "";
      const th = typeof m.threshold === "number" && Number.isFinite(m.threshold) ? m.threshold : threshold;
      const comparator = m.comparator === "<=" ? "<=" : ">=";
      if (!match || th == null) continue;
      // The line must exist in the latest recap — otherwise the resolver can
      // never read it and the condition would sit at NO DATA forever.
      const pool = source === "results" ? available.results : available.guidance;
      if (!pool.some((line) => labelMatches(line.split(":")[0] ?? line, match))) continue;
      const spec: MetricSpec = {
        label: (typeof m.label === "string" && m.label.trim() ? m.label.trim() : match).slice(0, 60),
        source,
        match: match.slice(0, 60),
        field: m.field === "yoy" ? "yoy" : "actual",
        period: typeof m.period === "string" && m.period.trim() ? m.period.trim().slice(0, 12) : undefined,
        comparator,
        threshold: Math.round(th * 100) / 100,
        unit: typeof m.unit === "string" ? m.unit.slice(0, 2) : undefined,
      };
      conditions.push({ kind, pillarId, theme, note, metric: spec });
      continue;
    }
    if (kind === "custom") {
      if (!note) continue;
      conditions.push({ kind, pillarId, theme, note });
      continue;
    }
    if (POSITION_KINDS.has(kind)) {
      if (seenPosition.has(kind)) continue;
      // Don't propose a position read that is already tripped or unreadable today.
      if (kind === "ma200" && live.aboveMa200 !== true) continue;
      if (kind === "sia_floor" && (live.siaPercentile == null || (threshold != null && live.siaPercentile < threshold))) continue;
      if (kind === "equate_rank" && (live.equateRank == null || (threshold != null && live.equateRank > threshold))) continue;
      if (kind === "marketedge" && (!live.marketEdge || live.marketEdge === "avoid")) continue;
      if (kind === "revisions" && (live.netRevisions == null || (threshold != null && live.netRevisions < threshold))) continue;
      seenPosition.add(kind);
      conditions.push({ kind, threshold, pillarId, theme, note });
    }
  }
  if (!conditions.length) return null;

  // Order: company-specific first, then at most MAX_POSITION position reads.
  const company = conditions.filter((c) => c.kind === "metric" || c.kind === "custom");
  const position = conditions.filter((c) => POSITION_KINDS.has(c.kind)).slice(0, MAX_POSITION);
  const kept = [...company, ...position].slice(0, MAX_CONDITIONS);
  void availableLabels;
  return { why, pillars, conditions: kept };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    const redis = await getRedis();
    const [{ context, killWatch }, stocksRaw, evidence, takeaways, synthRaw, thesesRaw] = await Promise.all([
      loadAlertInputs(),
      redis.get("pm:stocks"),
      buildTickerEvidence(tk),
      loadStreetTakeaways().catch(() => ({})),
      redis.get("pm:synthesis-screen-cache"),
      redis.get("pm:position-theses"),
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
    };
    const stocks: StoredStock[] = stocksRaw ? JSON.parse(stocksRaw) : [];
    const stock = stocks.find((s) => (s.ticker || "").toUpperCase() === tk);
    const price = typeof stock?.price === "number" ? stock.price : stock?.healthData?.currentPrice ?? null;
    const ma200 = stock?.healthData?.twoHundredDayAvg ?? null;
    const aboveMa200 = price != null && ma200 != null && ma200 > 0 ? price >= ma200 : null;

    // Position reads (same resolver the sweep uses), for the prompt and the sanitizer.
    const { loadKillSignalSources, killSignalExtrasFor } = await import("@/app/lib/metric-resolver");
    const extras = killSignalExtrasFor(tk, [], await loadKillSignalSources());

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

    const available = availableMetricLines(takeaways, tk);
    const linesBlock = available.results.length || available.guidance.length
      ? `REPORTED LINES IN THE LATEST METRICS RECAP (${available.event ?? "earnings"}, ${available.asOf}). A "metric" condition may reference ONLY these labels — they are what the app can read again next quarter:\n` +
        (available.results.length ? `Results:\n${available.results.map((l) => `  - ${l}`).join("\n")}\n` : "") +
        (available.guidance.length ? `Guidance:\n${available.guidance.map((l) => `  - ${l}`).join("\n")}\n` : "")
      : "NO METRICS RECAP ON FILE for this name yet — do not propose any \"metric\" conditions; use \"custom\" for company-specific tests (they are AI-verified against filings after each report).";

    const positionLine = [
      extras.siaPercentile != null ? `SIA percentile ${extras.siaPercentile}` : extras.siaSmax != null ? `SIA SMAX ${extras.siaSmax} (no percentile)` : "no SIA read",
      extras.equateRank === undefined ? "no Equate sheet" : extras.equateRank === null ? "not in the Equate top-decile list" : `Equate rank ${extras.equateRank}`,
      extras.marketEdgeOpinion ? `MarketEdge ${extras.marketEdgeOpinion.toUpperCase()}${extras.marketEdgePower != null ? ` (power ${extras.marketEdgePower})` : ""}` : "no MarketEdge read",
      aboveMa200 != null ? `price ${aboveMa200 ? "above" : "BELOW"} the 200-day` : null,
      ctx.netRevisions != null ? `net FY+1 revisions ${ctx.netRevisions >= 0 ? "+" : ""}${ctx.netRevisions}` : null,
      ctx.earningsDate ? `next earnings ${ctx.earningsDate}` : null,
    ].filter(Boolean).join(" · ");

    const existing = killWatch.find((k) => k.ticker === tk);

    const prompt = `You are drafting a portfolio manager's pre-registered investment thesis for a holding. The PM will edit and sign it. Structure it as PILLARS: the 2-4 things the case actually rests on, each guarded by one or two conditions that would tell the PM that pillar has failed. Make every claim FALSIFIABLE — the point is that a future version of the PM cannot rationalize past their own exit criteria.

TICKER: ${tk} — ${ctx.name || ""}${ctx.sector ? ` (${ctx.sector})` : ""}

${synthBlock}

${evidence ? `INGESTED ANALYST & FACTSET EVIDENCE (dated, attributable — prefer these figures when they conflict with the synthesis):\n${evidence}\n` : ""}
${linesBlock}

POSITION READS TODAY: ${positionLine}
${existing?.why ? `\nEXISTING THESIS (being redrafted — keep what still holds, drop what the evidence no longer supports):\n${existing.why}\n` : ""}${blocked.length ? `\nALREADY PROVEN UNVERIFIABLE FOR THIS NAME — DO NOT PROPOSE THESE OR ANY CLOSE VARIANT:\n${blocked.map((b) => `- ${b}`).join("\n")}\n` : ""}
CONDITION KINDS:
- metric: a reported figure from the Metrics Recap lines above vs a threshold. Checked automatically from the next recap. Fields: {"kind":"metric","pillar":"<pillar title>","metric":{"label":"<human label>","source":"results"|"guidance","match":"<the label EXACTLY as it appears in the lines above>","field":"actual"|"yoy","period":"<guidance only, e.g. FY2026>","comparator":">="|"<=","threshold":<number in the line's unit — % for yoy/margins, $B for dollar lines as printed>,"unit":"%"|"$"|""}}
- custom: a company-specific test the recap does NOT print (a segment, backlog, contract, unit metric, market-share or competitive-position fact). AI-verified against filings after each report. Must name the metric, the comparison and the current reference figure, be reported EVERY quarter, and be one test (never "and"). {"kind":"custom","pillar":"...","note":"...","theme":"..."}
- sia_floor (threshold = percentile, e.g. 50), equate_rank (threshold = rank, e.g. 60), marketedge, ma200, revisions (threshold = net floor, e.g. 0): the name's POSITION in the market / its universe. At most TWO of these, and only ones that currently pass.

Answer in JSON only:
{
  "why": "3-5 bullet lines separated by \\n, each starting with '• '. Lead each with the claim itself and the figure it rests on (attribute inline, e.g. '(RBC 2026-07-28)' / '(FactSet Q2 recap)'). One bullet on what should happen next. Final bullet starts '• Wrong if: '.",
  "pillars": [ { "title": "2-5 words", "claim": "one falsifiable sentence with the figure it rests on" } ],
  "conditions": [ ... ]
}

Rules:
- 2 to 4 pillars, each a DIFFERENT leg of the case (demand driver, margin/unit economics, competitive position, capital allocation, balance sheet, a regulatory or industry-structure fact). Draw them from the synthesis base/bull case and key debate.
- Every condition names its "pillar" by title. Each pillar gets at least one condition; a company-specific condition (metric or custom) for every pillar where the recap or the reports give you a figure.
- PREFER metric over custom whenever the recap prints the line. Use "match" verbatim from the lines above. Set the threshold from the reported figure with sensible room (a growth line that printed +73% YoY might get a floor of 40%; a margin that printed 71% might get a floor of 65%). Never set a threshold the latest print already fails.
- At least ONE condition must test the company's position in its industry or the market (a share, a relative-growth, a peer-relative figure as a custom — or one of the position kinds).
- Do NOT propose score_floor or score_decay.
- Keep each custom under 250 characters. One test per condition. No judgment calls ("management loses credibility").
- Ground everything in the material above — no invented figures, segments or events.`;

    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const parseResult = parseModelJson(text);
    if (!parseResult.ok) {
      console.error(`[thesis-draft] ${tk} JSON parse failed:`, parseResult.error, parseResult.excerpt ?? "");
      return NextResponse.json({ error: `draft failed — unparseable response: ${parseResult.error}` }, { status: 502 });
    }
    const draft = sanitize(parseResult.value, available, {
      aboveMa200,
      siaPercentile: extras.siaPercentile ?? null,
      equateRank: extras.equateRank,
      marketEdge: extras.marketEdgeOpinion ?? null,
      netRevisions: ctx.netRevisions ?? null,
    });
    if (!draft) return NextResponse.json({ error: "draft failed — model returned no usable proposal" }, { status: 502 });

    return NextResponse.json({ draft, usedSynthesis: !!synth, recapLines: available.results.length + available.guidance.length });
  } catch (e) {
    console.error("thesis-draft error:", e);
    return NextResponse.json({ error: "draft failed" }, { status: 500 });
  }
}
