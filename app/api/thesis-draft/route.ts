import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { KILL_TEMPLATES, type KillConditionKind } from "@/app/lib/kill-conditions";
import { buildTickerEvidence } from "@/app/lib/thesis-evidence";
import { parseModelJson } from "@/app/lib/json-repair";

/**
 * POST /api/thesis-draft { ticker } — AI-drafted thesis + kill conditions.
 *
 * The generation half of the thesis-discipline build (the Boosted-Alfa-style
 * flow): one model call assembles a PROPOSED "why I own it" and a proposed set
 * of pre-registered exit conditions from material the app already produced —
 * the rescore-generated investmentThesis and bearCase, the current composite /
 * revision / technical state, and the fixed kill-condition template set.
 *
 * DESIGN RULE — draft, never commit: this route writes NOTHING to Redis. The
 * response fills the ThesisTile editor and the PM edits and signs by clicking
 * "Underwrite position" exactly as with a hand-written thesis. Pre-registration
 * only means something if the human commits to the conditions, so AI proposes
 * and the PM disposes. (The methodology page's "AI never edits a thesis"
 * promise stays true: it never *persists* one either.)
 *
 * No cache: this is a manual button (~1 call per click), and a draft should
 * reflect the state at the moment it's requested.
 */

const client = new Anthropic();

type DraftCondition = { kind: KillConditionKind; threshold?: number; note?: string };
type Draft = { why: string; conditions: DraftCondition[] };

const VALID_KINDS = new Set<KillConditionKind>(KILL_TEMPLATES.map((t) => t.kind));

/** Total conditions kept, and how many of them may be company-specific
 *  customs. Customs are kept in preference to the automatic kinds — they are
 *  the part of a thesis that is actually about THIS business. */
const MAX_CONDITIONS = 6;
const MAX_CUSTOM = 3;

/** Validate + normalize the model's proposal. Invalid rows are dropped, not
 *  guessed at — the PM reviews whatever survives. */
function sanitize(raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { why?: unknown; conditions?: unknown };
  const why = typeof o.why === "string" ? o.why.trim() : "";
  if (!why) return null;
  const seen = new Set<string>();
  const parsed: DraftCondition[] = [];
  for (const c of Array.isArray(o.conditions) ? o.conditions : []) {
    if (!c || typeof c !== "object") continue;
    const kind = (c as { kind?: unknown }).kind as KillConditionKind;
    if (!VALID_KINDS.has(kind)) continue;
    // one condition per kind (customs may repeat — they're distinct prose)
    if (kind !== "custom" && seen.has(kind)) continue;
    const thRaw = (c as { threshold?: unknown }).threshold;
    const threshold = typeof thRaw === "number" && isFinite(thRaw) ? Math.round(thRaw * 10) / 10 : undefined;
    const noteRaw = (c as { note?: unknown }).note;
    const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, 200) : undefined;
    if (kind === "custom" && !note) continue;
    seen.add(kind);
    parsed.push({ kind, threshold, note: note || undefined });
  }
  if (!parsed.length) return null;

  // Trim to MAX_CONDITIONS by dropping AUTOMATIC kinds first. The company-
  // specific customs are the point of the exercise, so a verbose response must
  // never cost them — the old code capped in arrival order and could drop a
  // custom the model listed last.
  const customs = parsed.filter((c) => c.kind === "custom");
  const autos = parsed.filter((c) => c.kind !== "custom");
  const keptCustoms = customs.slice(0, MAX_CUSTOM);
  const conditions = [
    ...keptCustoms,
    ...autos.slice(0, Math.max(0, MAX_CONDITIONS - keptCustoms.length)),
  ];
  return { why, conditions };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    // Read-only gathers: live signal context, the stock's own generated prose,
    // and the ingested report/FactSet evidence (dated, attributable sourcing).
    const [{ context }, stocksRaw, evidence] = await Promise.all([
      loadAlertInputs(),
      getRedis().then((r) => r.get("pm:stocks")),
      buildTickerEvidence(tk),
    ]);
    const ctx = context[tk];
    if (!ctx) return NextResponse.json({ error: "unknown ticker" }, { status: 404 });

    type StoredStock = {
      ticker?: string;
      investmentThesis?: string;
      bearCase?: string;
      companySummary?: string;
      healthData?: { currentPrice?: number; twoHundredDayAvg?: number };
      price?: number;
    };
    const stocks: StoredStock[] = stocksRaw ? JSON.parse(stocksRaw) : [];
    const stock = stocks.find((s) => (s.ticker || "").toUpperCase() === tk);
    const price = typeof stock?.price === "number" ? stock.price : stock?.healthData?.currentPrice ?? null;
    const ma200 = stock?.healthData?.twoHundredDayAvg ?? null;
    const aboveMa200 = price != null && ma200 != null && ma200 > 0 ? price >= ma200 : null;

    const stateLine = [
      ctx.composite != null ? `composite score ${ctx.composite}/41` : null,
      ctx.scoreDelta != null ? `score Δ45d ${ctx.scoreDelta >= 0 ? "+" : ""}${ctx.scoreDelta}` : null,
      ctx.netRevisions != null ? `net FY+1 estimate revisions ${ctx.netRevisions >= 0 ? "+" : ""}${ctx.netRevisions} (${ctx.revUp ?? 0}▲/${ctx.revDown ?? 0}▼)` : null,
      ctx.riskLevel ? `technical risk alert: ${ctx.riskLevel}` : "no technical risk alert",
      aboveMa200 != null ? `price ${aboveMa200 ? "above" : "BELOW"} the 200-day average` : null,
      ctx.earningsDate ? `next earnings ${ctx.earningsDate}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const prompt = `You are drafting a portfolio manager's pre-registered investment thesis for a holding. The PM will edit and sign it — write it as tight bullet points (not narrative prose), and make it FALSIFIABLE: the point of the exercise is that a future version of the PM cannot rationalize past their own exit criteria.

TICKER: ${tk} — ${ctx.name || ""}${ctx.sector ? ` (${ctx.sector})` : ""}

GENERATED INVESTMENT THESIS (from the latest scoring run):
${stock?.investmentThesis || "(none on file)"}

GENERATED BEAR CASE / THESIS-BREAKERS (from the same run):
${stock?.bearCase || "(none on file)"}

CURRENT STATE: ${stateLine}
${evidence ? `\nINGESTED ANALYST & FACTSET EVIDENCE (dated and attributable — prefer these figures over the generated prose when they conflict):\n${evidence}\n` : ""}
AVAILABLE KILL-CONDITION TEMPLATES (all except "custom" are checked automatically every day):
- score_floor: composite score must stay >= threshold (scale is 0–41; this name is currently ${ctx.composite ?? "unknown"})
- score_decay: composite must not drop >= threshold points over ~45 days (typical threshold 5)
- revisions: net FY+1 estimate revisions (upgrades minus downgrades) must stay >= threshold (typical 0, or a floor like -3)
- risk_alert: no CRITICAL technical alert (no threshold)
- ma200: price holds above the 200-day average (no threshold)
- custom: prose, verified automatically against reported figures after each earnings report. This is where the REAL underwriting happens — the thesis-specific breakers the templates cannot measure. Write each as an objectively verifiable claim about REPORTED figures, naming the metric and the comparison (e.g. "quarterly cloud backlog declines sequentially"), never a judgment call. AT LEAST TWO are required (see the rules below).

Answer in JSON only:
{
  "why": "3-5 bullet lines separated by \\n, each starting with '• '. No preamble like 'I own X because' — lead each bullet with the claim itself. First bullets: the core economic drivers WITH the specific figures from the material above. One bullet on what is expected to happen next (catalyst/trajectory). Final bullet starts '• Wrong if: ' and names the observable breakers. Ground every bullet in the material above — do not invent facts, numbers, or events that are not present. When a figure comes from an ingested report or FactSet alert, attribute it inline in parentheses, e.g. '(RBC 2026-07-28)' or '(FactSet Q2 recap)'.",
  "conditions": [ { "kind": "...", "threshold": number-if-applicable, "note": "custom prose OR short annotation" } ]
}

Rules for conditions:
- Propose 4 to 6 conditions, and AT LEAST TWO of them MUST be "custom". This is the most important rule. The automatic kinds (score_floor, score_decay, revisions, risk_alert, ma200) are generic portfolio hygiene — they would read almost identically for any holding and none of them tests why THIS business specifically works. A draft whose only breakers are a score floor, a moving average and a revisions count has not underwritten anything.
- Each custom condition must name a COMPANY-SPECIFIC observable: a named segment, product line, contract, backlog, customer concentration, margin line, unit metric or guidance figure that appears in the material above. Use the metric and level verbatim when the material states them.
- The two customs must test DIFFERENT legs of the thesis — not the same claim reworded. If the thesis rests on growth in one segment AND on margin expansion, that is one custom each.
- A custom must be objectively checkable from REPORTED figures (it is verified against filings and earnings releases after each report), never a judgment call. "Cloud backlog declines sequentially" works; "management loses credibility" does not.
- Do NOT write a custom that restates an automatic kind (e.g. "the stock falls below its 200-day average") — those are already covered.
- Set score_floor relative to the CURRENT composite (typically current minus 3-4, rounded), never above it — a floor already tripped at underwrite is useless.
- Only include ma200 if the price is currently above it.
- Set the revisions threshold at or below the current net so it is not tripped on day one.
- Every condition must connect to the "why" — a breaker for a claim the thesis doesn't make is noise.`;

    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parseResult = parseModelJson(text);
    if (!parseResult.ok) {
      console.error(`[thesis-draft] ${tk} JSON parse failed:`, parseResult.error, parseResult.excerpt ?? "");
      return NextResponse.json({ error: `draft failed — unparseable response: ${parseResult.error}` }, { status: 502 });
    }
    const draft = sanitize(parseResult.value);
    if (!draft) return NextResponse.json({ error: "draft failed — model returned no usable proposal" }, { status: 502 });

    return NextResponse.json({ draft });
  } catch (e) {
    console.error("thesis-draft error:", e);
    return NextResponse.json({ error: "draft failed" }, { status: 500 });
  }
}
