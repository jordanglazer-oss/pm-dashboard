import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "@/app/lib/json-repair";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";
import { loadStrategistHistory, type StrategistEntry } from "@/app/lib/forward-looking";
import { stripReportAppendices } from "@/app/lib/strategist-note-prompt";

/**
 * GET /api/fundstrat-view — the Brief's "Fundstrat view": Mark Newton's and
 * Tom Lee's latest notes distilled into a few digestible bullets each.
 *
 * Source: pm:strategist-history (READ-ONLY here — the inbox ingest and the
 * Daily input are its only writers). Takes each author's latest note plus
 * the one before it, so the summary can say what changed.
 *
 * Caching mirrors the other hash-gated AI routes: the latest note text of
 * both authors (+ PROMPT_VERSION) is hashed and the result stored in
 * `pm:fundstrat-view-cache`. A page load on unchanged notes spends nothing;
 * one Sonnet call runs only when a new note arrives. `?refresh=1` forces.
 * On a failed rebuild the stale cache is served with `error` set.
 *
 * Redis footprint: reads pm:strategist-history; reads/writes ONE key,
 * `pm:fundstrat-view-cache`, a pure regenerable cache (matches the backup
 * `-cache$` exclude). Touches no user data.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("Fundstrat-view");
const CACHE_KEY = "pm:fundstrat-view-cache";
const PROMPT_VERSION = "v1";
const client = new Anthropic();

/** Per-note prompt budget: the analysis lives up front; appendices are cut. */
const MAX_NOTE_CHARS = 14000;
const MAX_PRIOR_CHARS = 2500;

export type StrategistView = {
  date: string;
  stance: "constructive" | "neutral" | "cautious";
  headline: string;
  bullets: string[];
  /** Newton: price levels to watch. Lee: names / sectors favoured. */
  watch?: string[];
  changeVsPrior?: string;
};
export type FundstratView = {
  newton: StrategistView | null;
  lee: StrategistView | null;
  /** One line on where the two agree or differ (only when both are present). */
  together?: string;
  generatedAt: string;
};
type Cached = { hash: string; result: FundstratView };

const latestTwo = (entries: StrategistEntry[]) => {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { latest: sorted[sorted.length - 1] ?? null, prior: sorted[sorted.length - 2] ?? null };
};

const clean = (t: string, max: number) => stripReportAppendices(t).text.slice(0, max);

function noteBlock(label: string, latest: StrategistEntry | null, prior: StrategistEntry | null): string {
  if (!latest) return `${label}: (no note on file)`;
  return [
    `${label} — LATEST NOTE (${latest.date}):`,
    clean(latest.text, MAX_NOTE_CHARS),
    prior ? `\n${label} — PREVIOUS NOTE (${prior.date}), opening only, for "what changed":\n${clean(prior.text, MAX_PRIOR_CHARS)}` : "",
  ].join("\n");
}

function buildPrompt(n: ReturnType<typeof latestTwo>, l: ReturnType<typeof latestTwo>): string {
  return `You are summarizing Fundstrat strategist notes for a portfolio manager's morning brief. He reads these two people more closely than anyone else, so the summary must carry their actual calls, not generic market colour.

${noteBlock("MARK NEWTON (Head of Technical Strategy)", n.latest, n.prior)}

====

${noteBlock("TOM LEE (Head of Research)", l.latest, l.prior)}

RULES:
- Use ONLY what the notes say. Never add your own view, data or forecasts.
- Keep each strategist's specific numbers: index levels, targets, support/resistance, dates, percentages, tickers, sectors.
- Plain English, one sentence per bullet, at most 26 words. No markdown, no bullet characters.
- 3 to 5 bullets per strategist, most decision-relevant first (what to do / what would change the view).
- "stance" is the strategist's own near-term posture on US equities.
- "watch": for Newton, the price levels he names (e.g. "SPX support 6,550"); for Lee, the sectors or names he favours. Up to 5 short items. Omit if none.
- "changeVsPrior": one sentence on how the view moved since the previous note, or omit if there is no previous note or nothing changed.
- "together": one sentence on where Newton and Lee agree or differ right now. Omit if either note is missing.
- A strategist with no note on file is null.

Return JSON only, no prose and no code fences:
{
  "newton": { "stance": "constructive|neutral|cautious", "headline": string, "bullets": string[], "watch": string[], "changeVsPrior": string } | null,
  "lee": { same shape } | null,
  "together": string
}`;
}

const STANCES = new Set(["constructive", "neutral", "cautious"]);
const strArr = (v: unknown, max: number) =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").trim()).slice(0, max)
    : [];

function toView(raw: unknown, date: string | undefined): StrategistView | null {
  if (!raw || typeof raw !== "object" || !date) return null;
  const r = raw as Record<string, unknown>;
  const bullets = strArr(r.bullets, 6);
  if (!bullets.length) return null;
  const watch = strArr(r.watch, 6);
  return {
    date,
    stance: STANCES.has(r.stance as string) ? (r.stance as StrategistView["stance"]) : "neutral",
    headline: typeof r.headline === "string" ? r.headline.trim() : "",
    bullets,
    ...(watch.length ? { watch } : {}),
    ...(typeof r.changeVsPrior === "string" && r.changeVsPrior.trim() ? { changeVsPrior: r.changeVsPrior.trim() } : {}),
  };
}

async function readCache(): Promise<Cached | null> {
  try {
    const raw = await (await getRedis()).get(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const history = await loadStrategistHistory();
  const n = latestTwo(history.newton);
  const l = latestTwo(history.lee);

  if (!n.latest && !l.latest) return NextResponse.json({ result: null, empty: true });

  const hash = createHash("md5")
    .update(JSON.stringify([PROMPT_VERSION, n.latest, n.prior?.date, l.latest, l.prior?.date]))
    .digest("hex");
  const cached = await readCache();
  if (!force && cached?.hash === hash) return NextResponse.json({ result: cached.result, cached: true });

  let result: FundstratView | null = null;
  try {
    const msg = await client.messages.create({
      model: SONNET_MODEL,
      thinking: THINKING_OFF,
      max_tokens: 1800,
      messages: [{ role: "user", content: buildPrompt(n, l) }],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    const parsed = parseModelJson<{ newton?: unknown; lee?: unknown; together?: unknown }>(
      text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""),
    );
    if (parsed.ok && parsed.value) {
      const newton = toView(parsed.value.newton, n.latest?.date);
      const lee = toView(parsed.value.lee, l.latest?.date);
      if (newton || lee) {
        result = {
          newton,
          lee,
          ...(newton && lee && typeof parsed.value.together === "string" && parsed.value.together.trim()
            ? { together: parsed.value.together.trim() }
            : {}),
          generatedAt: new Date().toISOString(),
        };
      }
    } else {
      log.error("unparseable model output:", text.slice(0, 400));
    }
  } catch (e) {
    log.error("Anthropic call failed:", e);
  }

  if (!result) {
    // Serve the last good summary rather than blanking the panel.
    return NextResponse.json({ result: cached?.result ?? null, stale: Boolean(cached), error: "Could not summarize the latest notes." });
  }
  try {
    await (await getRedis()).set(CACHE_KEY, JSON.stringify({ hash, result } satisfies Cached));
  } catch (e) {
    log.error("cache write failed:", e);
  }
  return NextResponse.json({ result, cached: false });
}
