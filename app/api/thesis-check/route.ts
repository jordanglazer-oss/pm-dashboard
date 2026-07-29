import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { createHash } from "crypto";

/**
 * POST /api/thesis-check { ticker } — the on-trip written thesis check
 * (phase ④ of the thesis-discipline build, preview-only).
 *
 * Answers ONE question with one model call: does the tripped kill condition
 * actually break the pre-registered thesis, or is it noise against it?
 * The model sees the thesis as written, every condition with its live
 * reading, and the name's current score/revision state — nothing else.
 *
 * Token discipline (the hash-gated cache pattern used by upticks-scrape):
 *   - Refuses to run unless a condition is actually tripped (force: true
 *     overrides for an on-demand read) — the watchers are free; prose isn't.
 *   - The fingerprint covers the thesis text + each condition's status and
 *     reading. Same facts → cache hit → zero spend. A new trip, a recovered
 *     condition, or an edited thesis changes the hash and re-runs once.
 *
 * Cache: pm:thesis-check:{TICKER} { hash, result, analyzedAt } — regenerable,
 * safe to nuke. GET returns the cached check without ever spending.
 */

const client = new Anthropic();

type CheckResult = {
  breaksThesis: "direct" | "partial" | "no";
  assessment: string;
  bearCase: string;
  restore: string;
  suggestedAction: string;
};

const keyFor = (tk: string) => `pm:thesis-check:${tk.toUpperCase()}`;

export async function GET(req: NextRequest) {
  const tk = (new URL(req.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  try {
    const redis = await getRedis();
    const raw = await redis.get(keyFor(tk));
    if (!raw) return NextResponse.json({ check: null });
    return NextResponse.json({ check: JSON.parse(raw) });
  } catch {
    return NextResponse.json({ check: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tk = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!tk) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const force = body?.force === true;

    const { killWatch, context } = await loadAlertInputs();
    const row = killWatch.find((k) => k.ticker === tk);
    if (!row) return NextResponse.json({ error: "no underwritten thesis for this ticker" }, { status: 404 });
    if (row.tripped === 0 && !force)
      return NextResponse.json({ error: "no condition tripped — the deterministic watchers are the answer while everything holds" }, { status: 409 });

    const condLines = row.checks
      .map((c) => {
        const label = c.condition.kind === "custom" ? c.condition.note || "custom" : c.condition.kind.replace(/_/g, " ");
        const th = c.condition.threshold != null ? ` (threshold ${c.condition.threshold})` : "";
        return `- [${c.status.toUpperCase()}] ${label}${th}: ${c.reading}${c.condition.trippedAt ? ` — tripped since ${c.condition.trippedAt}` : ""}`;
      })
      .join("\n");
    const ctx = context[tk];
    const ctxLine = [
      ctx?.composite != null ? `composite ${ctx.composite}/41` : null,
      ctx?.scoreDelta != null ? `Δ45d ${ctx.scoreDelta >= 0 ? "+" : ""}${ctx.scoreDelta}` : null,
      ctx?.netRevisions != null ? `net revisions ${ctx.netRevisions >= 0 ? "+" : ""}${ctx.netRevisions}` : null,
      ctx?.riskLevel ? `risk ${ctx.riskLevel}` : null,
      ctx?.earningsDate ? `reports ${ctx.earningsDate}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ tk, why: row.why ?? "", checks: row.checks.map((c) => [c.condition.id, c.status, c.reading]) }))
      .digest("hex");

    const redis = await getRedis();
    const cachedRaw = await redis.get(keyFor(tk));
    if (cachedRaw && !force) {
      const cached = JSON.parse(cachedRaw) as { hash?: string };
      if (cached.hash === fingerprint) return NextResponse.json({ check: JSON.parse(cachedRaw), cached: true });
    }

    const prompt = `You are reviewing a portfolio manager's pre-registered investment thesis after one of its kill conditions tripped. Be direct and unsentimental — the PM wrote these conditions specifically so a future version of themselves could not rationalize past them.

TICKER: ${tk}
THESIS AS WRITTEN AT UNDERWRITE${row.underwrittenAt ? ` (${row.underwrittenAt})` : ""}:
${row.why || "(no prose thesis — conditions only)"}

KILL CONDITIONS (live readings):
${condLines}

CURRENT STATE: ${ctxLine || "no additional context"}

Answer in JSON only:
{
  "breaksThesis": "direct" | "partial" | "no",   // does the tripped condition hit the thesis's core variable, a supporting leg, or neither?
  "assessment": "2-3 sentences: what tripped, whether it is the thesis variable or noise near it, and what the PM's own pre-registered rule implies",
  "bearCase": "1-2 sentences stating the bear case as it now stands",
  "restore": "1 sentence: what observable fact would restore the thesis",
  "suggestedAction": "1 sentence, concrete. NEVER recommend an automatic trade — recommend what to review/decide and by when. If the PM's own rule says exit, say so plainly."
}

Rules: use ONLY the facts above — do not invent numbers or events. If the tripped condition is unrelated to the written thesis, say "no" and explain the mismatch; do not manufacture a connection.`;

    const resp = await client.messages.create({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: "model returned no JSON" }, { status: 502 });
    const result = JSON.parse(m[0]) as CheckResult;
    if (!result.assessment || !["direct", "partial", "no"].includes(result.breaksThesis))
      return NextResponse.json({ error: "model returned malformed check" }, { status: 502 });

    const stored = { hash: fingerprint, result, analyzedAt: new Date().toISOString(), tripped: row.tripped, auto: row.auto };
    await redis.set(keyFor(tk), JSON.stringify(stored));
    return NextResponse.json({ check: stored, cached: false });
  } catch (e) {
    console.error("thesis-check failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
