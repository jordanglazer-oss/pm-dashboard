import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { loadAlertInputs, type KillWatchRow } from "./alert-inputs";
import { buildTickerEvidence, latestEvidenceAt } from "./thesis-evidence";
import { loadStreetTakeaways } from "./street-takeaways";
import { availableMetricLines, labelMatches } from "./metric-resolver";
import { describeCondition, type KillCondition, type KillConditionKind, type MetricSpec, type ThesisPillar } from "./kill-conditions";
import { parseModelJson } from "./json-repair";
import { canonicalTicker } from "./ticker";
import type { SynthesisScreenCache, SynthesisEntry } from "./synthesis-screen-display";

/**
 * Post-earnings thesis review — the "regenerate after each report" answer that
 * does NOT rewrite a signed thesis.
 *
 * After new evidence lands for a Portfolio name (a report, a FactSet recap, a
 * fresh synthesis), one model call reads the thesis AS WRITTEN — pillars and
 * conditions with their live readings — against the new material and returns:
 *   - a status per pillar: confirmed / contested / broken, with the reading
 *   - a DIFF of proposed changes: tighten / loosen / replace / add / drop a
 *     condition, or reword a pillar — each with a reason
 *   - a two-line summary
 * The PM accepts or rejects each change in the ThesisTile and re-signs. The
 * thesis text never changes without that click.
 *
 * Token discipline: hash-gated on (thesis prose, pillars, condition ids +
 * status + reading, synthesis generatedAt, latest evidence timestamp). Same
 * facts → cache hit → zero spend. Nightly sweep caps at MAX_PER_RUN.
 *
 * Cache: pm:thesis-review:{TICKER} — regenerable, safe to nuke.
 */

const log = createLogger("ThesisReview");
const client = new Anthropic();
const keyFor = (tk: string) => `pm:thesis-review:${tk.toUpperCase()}`;
const MAX_PER_RUN = 5;

export type PillarStatus = "confirmed" | "contested" | "broken" | "unknown";

export type ReviewChange = {
  id: string;
  type: "tighten" | "loosen" | "replace" | "add" | "drop" | "pillar";
  /** Target condition (tighten/loosen/replace/drop) or pillar (pillar). */
  conditionId?: string;
  pillarId?: string;
  before?: string;
  /** The proposed condition (add/replace/tighten/loosen) or pillar wording (pillar). */
  after?: {
    kind?: KillConditionKind;
    threshold?: number;
    note?: string;
    theme?: string;
    metric?: MetricSpec;
    pillarId?: string;
    title?: string;
    claim?: string;
  };
  reason: string;
};

export type ThesisReview = {
  hash: string;
  generatedAt: string;
  /** Latest evidence ingest the review saw (for the nightly "is it stale" test). */
  evidenceAt: string | null;
  synthesisAt: string | null;
  summary: string;
  pillars: Array<{ pillarId: string; title: string; status: PillarStatus; reading: string }>;
  changes: ReviewChange[];
  /** Change ids the PM dismissed (kept so they don't come back on reload). */
  dismissed?: string[];
  /** Set when the PM applied changes and re-signed. */
  appliedAt?: string;
};

export async function readThesisReview(tk: string): Promise<ThesisReview | null> {
  try {
    const raw = await (await getRedis()).get(keyFor(tk));
    return raw ? (JSON.parse(raw) as ThesisReview) : null;
  } catch {
    return null;
  }
}

export async function updateThesisReview(tk: string, patch: Partial<ThesisReview>): Promise<ThesisReview | null> {
  const redis = await getRedis();
  const cur = await readThesisReview(tk);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await redis.set(keyFor(tk), JSON.stringify(next));
  return next;
}

type ThesisStore = Record<string, { why?: string; pillars?: ThesisPillar[]; killConditions?: KillCondition[]; underwrittenAt?: string }>;

async function loadContext(tk: string) {
  const redis = await getRedis();
  const [{ killWatch, context }, thesesRaw, synthRaw, takeaways, evidence, evidenceAt] = await Promise.all([
    loadAlertInputs(),
    redis.get("pm:position-theses"),
    redis.get("pm:synthesis-screen-cache"),
    loadStreetTakeaways().catch(() => ({})),
    buildTickerEvidence(tk).catch(() => ""),
    latestEvidenceAt(tk).catch(() => null),
  ]);
  const row = killWatch.find((k) => k.ticker === tk) ?? null;
  let theses: ThesisStore = {};
  try { theses = thesesRaw ? (JSON.parse(thesesRaw) as ThesisStore) : {}; } catch { theses = {}; }
  const thesis = theses[tk] ?? theses[tk.toUpperCase()];
  let synth: SynthesisEntry | undefined;
  try {
    const cache = synthRaw ? (JSON.parse(synthRaw) as SynthesisScreenCache) : {};
    synth = cache[canonicalTicker(tk)] ?? cache[tk];
  } catch { synth = undefined; }
  return { row, thesis, synth, ctx: context[tk], takeaways, evidence, evidenceAt };
}

function fingerprint(row: KillWatchRow | null, thesis: ThesisStore[string] | undefined, synth: SynthesisEntry | undefined, evidenceAt: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({
      why: thesis?.why ?? "",
      pillars: (thesis?.pillars ?? []).map((p) => [p.id, p.title, p.claim]),
      checks: (row?.checks ?? []).map((c) => [c.condition.id, c.status, c.reading]),
      synthesisAt: synth?.generatedAt ?? null,
      evidenceAt,
    }))
    .digest("hex");
}

const bullets = (arr: unknown[] | undefined) =>
  (arr ?? []).map((b) => (typeof b === "string" ? b : (b as { text?: string; point?: string }).text ?? (b as { point?: string }).point ?? JSON.stringify(b))).slice(0, 5).map((t) => `  • ${t}`).join("\n");

/** Generate (or return the cached) review for one name. */
export async function reviewThesis(tk: string, opts: { force?: boolean } = {}): Promise<{ review: ThesisReview | null; cached: boolean; error?: string }> {
  const { row, thesis, synth, ctx, takeaways, evidence, evidenceAt } = await loadContext(tk);
  if (!thesis || !thesis.why?.trim()) return { review: null, cached: false, error: "no thesis on file" };
  const hash = fingerprint(row, thesis, synth, evidenceAt);
  const existing = await readThesisReview(tk);
  if (existing && existing.hash === hash && !opts.force) return { review: existing, cached: true };

  const pillars = thesis.pillars ?? [];
  const conds = thesis.killConditions ?? [];
  const pillarTitle = (id?: string) => pillars.find((p) => p.id === id)?.title;
  const condLines = (row?.checks ?? conds.map((c) => ({ condition: c, status: "unknown", reading: "not evaluated" }))).map((c) => {
    const p = pillarTitle(c.condition.pillarId);
    return `- [${c.status.toUpperCase()}] (${c.condition.id})${p ? ` [pillar: ${p}]` : ""} ${describeCondition(c.condition)} — ${c.reading}`;
  }).join("\n");
  const pillarLines = pillars.length ? pillars.map((p) => `- (${p.id}) ${p.title}: ${p.claim}`).join("\n") : "(no pillars registered — propose 2-4 from the thesis text via \"pillar\" changes with type \"add\")";
  const available = availableMetricLines(takeaways, tk);
  const linesBlock = available.results.length || available.guidance.length
    ? `REPORTED LINES IN THE LATEST METRICS RECAP (${available.event ?? "earnings"}, ${available.asOf}) — the only labels a "metric" condition may use:\n${[...available.results.map((l) => `  - ${l}`), ...available.guidance.map((l) => `  - [guidance] ${l}`)].join("\n")}`
    : "No Metrics Recap on file — propose custom (AI-verified) conditions rather than metric ones.";
  const synthBlock = synth
    ? `LATEST SYNTHESIS (${synth.generatedAt.slice(0, 10)}, verdict ${synth.result.verdict}: ${synth.result.verdictReason})\nBase:\n${bullets(synth.result.base as unknown[])}\nBull:\n${bullets(synth.result.bull as unknown[])}\nBear:\n${bullets(synth.result.bear as unknown[])}\nKey debate: ${synth.result.keyDebate}\nWould change the call:\n${(synth.result.wouldChangeCall ?? []).map((w) => `  • ${w}`).join("\n")}`
    : "(no synthesis on file)";

  const prompt = `You are reviewing a portfolio manager's SIGNED, pre-registered investment thesis after new evidence arrived. You do not rewrite it. You report, pillar by pillar, whether the new evidence confirms, contests or breaks each pillar, and you propose a DIFF of specific changes the PM can accept or reject one at a time. Be direct: the PM wrote the conditions so a future self could not rationalize past them.

TICKER: ${tk} — ${ctx?.name ?? ""}${ctx?.sector ? ` (${ctx.sector})` : ""}
THESIS AS SIGNED${thesis.underwrittenAt ? ` (${thesis.underwrittenAt})` : ""}:
${thesis.why}

PILLARS:
${pillarLines}

CONDITIONS (live readings):
${condLines || "(none)"}

${synthBlock}

${evidence ? `INGESTED EVIDENCE (dated, attributable):\n${evidence}\n` : ""}
${linesBlock}

Answer in JSON only:
{
  "summary": "two sentences: what the new evidence did to the case, and what the PM should decide",
  "pillars": [ { "pillarId": "<id from PILLARS>", "status": "confirmed" | "contested" | "broken" | "unknown", "reading": "one line: the figure or fact that decides it, with its date" } ],
  "changes": [
    { "type": "tighten" | "loosen" | "replace" | "drop", "conditionId": "<id from CONDITIONS>", "after": { "kind": "metric"|"custom"|"sia_floor"|"equate_rank"|"marketedge"|"ma200"|"revisions", "threshold": number, "note": "custom prose", "theme": "2-4 words", "metric": { "label": "...", "source": "results"|"guidance", "match": "<label verbatim from the recap lines>", "field": "actual"|"yoy", "comparator": ">="|"<=", "threshold": number, "unit": "%"|"$"|"" } }, "reason": "one line" },
    { "type": "add", "pillarId": "<id>", "after": { ...same shape... }, "reason": "one line" },
    { "type": "pillar", "pillarId": "<id or omit for a new pillar>", "after": { "title": "...", "claim": "..." }, "reason": "one line" }
  ]
}

Rules:
- Use ONLY the facts above. No invented figures, segments or events.
- A pillar is "broken" only when a reported fact contradicts its claim; "contested" when the evidence cuts against it without settling it; "confirmed" when the new print supports it; "unknown" when nothing new speaks to it.
- Propose a change ONLY when the evidence warrants it: a threshold the latest print makes trivial (tighten), a threshold that trips on noise the thesis never cared about (loosen), a condition whose metric stopped being disclosed (replace with a line that IS in the recap), a condition the case no longer rests on (drop), a pillar the evidence shows is missing or misstated (pillar / add). Zero changes is a valid answer.
- "metric" conditions must use a "match" verbatim from the recap lines; otherwise use "custom".
- One test per condition, under 250 characters, reported every quarter, no judgment calls.
- Do not propose score_floor or score_decay.`;

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const parsed = parseModelJson<{ summary?: unknown; pillars?: unknown; changes?: unknown }>(text);
    if (!parsed.ok) return { review: existing, cached: false, error: `unparseable: ${parsed.error}` };
    const o = parsed.value;
    const summary = typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "";
    if (!summary) return { review: existing, cached: false, error: "malformed review" };

    const statuses = new Set<PillarStatus>(["confirmed", "contested", "broken", "unknown"]);
    const pillarOut: ThesisReview["pillars"] = [];
    for (const p of Array.isArray(o.pillars) ? o.pillars : []) {
      const pp = p as { pillarId?: unknown; status?: unknown; reading?: unknown };
      const id = typeof pp.pillarId === "string" ? pp.pillarId : "";
      const pillar = pillars.find((x) => x.id === id);
      if (!pillar) continue;
      const status = statuses.has(pp.status as PillarStatus) ? (pp.status as PillarStatus) : "unknown";
      pillarOut.push({ pillarId: id, title: pillar.title, status, reading: String(pp.reading ?? "").trim().slice(0, 240) });
    }

    const validKinds = new Set<KillConditionKind>(["metric", "custom", "sia_floor", "equate_rank", "marketedge", "ma200", "revisions", "risk_alert"]);
    const pool = [...available.results, ...available.guidance].map((l) => l.split(":")[0] ?? l);
    const changes: ReviewChange[] = [];
    for (const c of Array.isArray(o.changes) ? o.changes : []) {
      const cc = c as Record<string, unknown>;
      const type = cc.type as ReviewChange["type"];
      if (!["tighten", "loosen", "replace", "drop", "add", "pillar"].includes(type)) continue;
      const reason = String(cc.reason ?? "").trim().slice(0, 240);
      const conditionId = typeof cc.conditionId === "string" ? cc.conditionId : undefined;
      const pillarId = typeof cc.pillarId === "string" ? cc.pillarId : undefined;
      const target = conditionId ? conds.find((x) => x.id === conditionId) : undefined;
      if (["tighten", "loosen", "replace", "drop"].includes(type) && !target) continue;
      let after: ReviewChange["after"] | undefined;
      const a = cc.after as Record<string, unknown> | undefined;
      if (type === "pillar") {
        if (!a || typeof a.title !== "string" || typeof a.claim !== "string") continue;
        after = { title: a.title.trim().slice(0, 40), claim: a.claim.trim().slice(0, 240) };
      } else if (type !== "drop") {
        if (!a || !validKinds.has(a.kind as KillConditionKind)) continue;
        const kind = a.kind as KillConditionKind;
        after = { kind, pillarId: pillarId ?? target?.pillarId };
        if (typeof a.threshold === "number" && Number.isFinite(a.threshold)) after.threshold = Math.round(a.threshold * 100) / 100;
        if (typeof a.note === "string" && a.note.trim()) after.note = a.note.trim().slice(0, 300);
        if (typeof a.theme === "string" && a.theme.trim()) after.theme = a.theme.trim().slice(0, 40);
        if (kind === "metric") {
          const m = a.metric as Partial<MetricSpec> | undefined;
          const match = typeof m?.match === "string" ? m.match.trim() : "";
          const th = typeof m?.threshold === "number" ? m.threshold : after.threshold;
          if (!match || th == null || !pool.some((l) => labelMatches(l, match))) continue;
          after.metric = {
            label: (typeof m?.label === "string" && m.label.trim() ? m.label.trim() : match).slice(0, 60),
            source: m?.source === "guidance" ? "guidance" : "results",
            match: match.slice(0, 60),
            field: m?.field === "yoy" ? "yoy" : "actual",
            comparator: m?.comparator === "<=" ? "<=" : ">=",
            threshold: Math.round(th * 100) / 100,
            unit: typeof m?.unit === "string" ? m.unit.slice(0, 2) : undefined,
          };
        }
        if (kind === "custom" && !after.note) continue;
      }
      changes.push({
        id: `chg-${changes.length + 1}-${Date.now().toString(36)}`,
        type,
        conditionId,
        pillarId,
        before: target ? describeCondition(target) : type === "pillar" && pillarId ? pillars.find((p) => p.id === pillarId)?.claim : undefined,
        after,
        reason,
      });
    }

    const review: ThesisReview = {
      hash,
      generatedAt: new Date().toISOString(),
      evidenceAt,
      synthesisAt: synth?.generatedAt ?? null,
      summary,
      pillars: pillarOut,
      changes,
    };
    await (await getRedis()).set(keyFor(tk), JSON.stringify(review));
    return { review, cached: false };
  } catch (e) {
    log.error(`${tk} failed:`, e);
    return { review: existing, cached: false, error: e instanceof Error ? e.message : "failed" };
  }
}

/**
 * Nightly: review every underwritten Portfolio name whose evidence or synthesis
 * is newer than its last review. Bounded by count and wall clock.
 */
export async function runThesisReviews(opts: { deadlineAt?: number } = {}): Promise<{ reviewed: string[]; skipped: number; errors: number }> {
  const redis = await getRedis();
  const [thesesRaw, synthRaw] = await Promise.all([redis.get("pm:position-theses"), redis.get("pm:synthesis-screen-cache")]);
  let theses: ThesisStore = {};
  try { theses = thesesRaw ? (JSON.parse(thesesRaw) as ThesisStore) : {}; } catch { theses = {}; }
  let synthCache: SynthesisScreenCache = {};
  try { synthCache = synthRaw ? (JSON.parse(synthRaw) as SynthesisScreenCache) : {}; } catch { synthCache = {}; }

  const reviewed: string[] = [];
  let skipped = 0;
  let errors = 0;
  for (const rawTk of Object.keys(theses)) {
    const tk = rawTk.toUpperCase();
    const t = theses[rawTk];
    if (!t?.why?.trim() || !(t.killConditions?.length)) { skipped++; continue; }
    if (reviewed.length >= MAX_PER_RUN || (opts.deadlineAt != null && Date.now() >= opts.deadlineAt)) { skipped++; continue; }
    const prev = await readThesisReview(tk);
    const evidenceAt = await latestEvidenceAt(tk).catch(() => null);
    const synthAt = (synthCache[canonicalTicker(tk)] ?? synthCache[tk])?.generatedAt ?? null;
    const due = !prev || (evidenceAt != null && (prev.evidenceAt == null || evidenceAt > prev.evidenceAt)) || (synthAt != null && (prev.synthesisAt == null || synthAt > prev.synthesisAt));
    if (!due) { skipped++; continue; }
    const r = await reviewThesis(tk);
    if (r.error && !r.review) errors++;
    else if (!r.cached) reviewed.push(tk);
    else skipped++;
  }
  return { reviewed, skipped, errors };
}
