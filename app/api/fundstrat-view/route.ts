import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "@/app/lib/json-repair";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";
import { loadStrategistHistory, type StrategistEntry } from "@/app/lib/forward-looking";
import { stripReportAppendices } from "@/app/lib/strategist-note-prompt";
import {
  LEVELS_KEY,
  DROP_AFTER_DAYS,
  activeLevels,
  normalizeLevels,
  noteId,
  pruneStore,
  type ActiveLevel,
  type Author,
  type LevelsStore,
} from "@/app/lib/fundstrat-levels";

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
 * Levels memory (app/lib/fundstrat-levels.ts): every note from the last
 * DROP_AFTER_DAYS gets its support / resistance / target levels extracted
 * ONCE (one small call covering only notes not yet extracted, or re-saved
 * with different text) into `pm:fundstrat-levels`; the panel shows the
 * newest level per instrument + kind, so a level stays until a newer note
 * replaces it, fading after two weeks and dropping after four.
 *
 * Redis footprint: reads pm:strategist-history; reads/writes
 * `pm:fundstrat-view-cache` (pure regenerable cache, matches the backup
 * `-cache$` exclude) and `pm:fundstrat-levels` (per-note read-merge-write,
 * derived from the notes). Touches no user data.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("Fundstrat-view");
const CACHE_KEY = "pm:fundstrat-view-cache";
const PROMPT_VERSION = "v2";
const LEVELS_PROMPT_VERSION = "l1";
/** Notes per extraction call (first run backfills the last four weeks). */
const MAX_NOTES_PER_EXTRACT = 10;
const MAX_LEVEL_NOTE_CHARS = 9000;
const client = new Anthropic();

/** Per-note prompt budget: the analysis lives up front; appendices are cut. */
const MAX_NOTE_CHARS = 14000;
const MAX_PRIOR_CHARS = 2500;

export type StrategistView = {
  date: string;
  stance: "constructive" | "neutral" | "cautious";
  headline: string;
  bullets: string[];
  /** Lee: names / sectors favoured. (Price levels live in `levels`.) */
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
- "watch": for Lee only, the sectors or names he favours, up to 5 short items. Omit for Newton (his price levels are tracked separately). Never put price levels here.
- "changeVsPrior": one sentence on how the view moved since the previous note, or omit if there is no previous note or nothing changed.
- "together": one sentence on where Newton and Lee agree or differ right now. Omit if either note is missing.
- A strategist with no note on file is null.

Return JSON only, no prose and no code fences:
{
  "newton": { "stance": "constructive|neutral|cautious", "headline": string, "bullets": string[], "changeVsPrior": string } | null,
  "lee": { "stance": ..., "headline": string, "bullets": string[], "watch": string[], "changeVsPrior": string } | null,
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

const textHash = (t: string) => createHash("md5").update(LEVELS_PROMPT_VERSION + t).digest("hex");

async function readLevels(): Promise<LevelsStore> {
  try {
    const raw = await (await getRedis()).get(LEVELS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && parsed.notes ? (parsed as LevelsStore) : { notes: {} };
  } catch {
    return { notes: {} };
  }
}

async function markLevelsFailed() {
  try {
    const cur = await readLevels();
    await (await getRedis()).set(LEVELS_KEY, JSON.stringify({ ...cur, lastFailAt: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}

/**
 * Extract levels from every recent note not yet in the store (or re-saved
 * with new text). Self-gating: a note is recorded even when it names no
 * levels, so it is never sent again. Returns the merged store.
 */
async function refreshLevels(history: { newton: StrategistEntry[]; lee: StrategistEntry[] }): Promise<LevelsStore> {
  const store = await readLevels();
  const cutoff = new Date(Date.now() - DROP_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10);
  const pending: Array<{ author: Author; e: StrategistEntry; hash: string }> = [];
  for (const author of ["newton", "lee"] as const) {
    for (const e of history[author]) {
      if (e.date < cutoff) continue;
      const hash = textHash(e.text);
      if (store.notes[noteId(author, e.date)]?.textHash !== hash) pending.push({ author, e, hash });
    }
  }
  if (!pending.length) return store;
  // A failed extraction is not retried on every page load: back off 6h.
  if (store.lastFailAt && Date.now() - Date.parse(store.lastFailAt) < 6 * 3_600_000) return store;
  const batch = pending.sort((a, b) => (a.e.date < b.e.date ? 1 : -1)).slice(0, MAX_NOTES_PER_EXTRACT);

  const prompt = `Extract the specific price LEVELS named in each Fundstrat strategist note below.

${batch.map((b, i) => `=== NOTE ${i + 1} (${b.author === "newton" ? "Mark Newton" : "Tom Lee"}, ${b.e.date}) ===\n${clean(b.e.text, MAX_LEVEL_NOTE_CHARS)}`).join("\n\n")}

RULES:
- Only levels the note itself states as support, resistance, a price target, or another explicit line to watch. Never infer or compute one.
- "subject": the instrument as a short ticker-style code — SPX for the S&P 500 index, NDX for the Nasdaq-100 index, QQQ, SPY, IWM, DJIA, VIX, TNX for the US 10-year yield, DXY, BTC, or the stock / ETF ticker.
- "kind": support | resistance | target | other.
- "value": the number or range exactly as written (e.g. "585", "6,550-6,600"). One entry per distinct level.
- "note": optional, at most 6 words of context (e.g. "50-day MA", "year-end", "breakdown below").
- A note with no levels gets an empty list.

Return JSON only, no prose and no code fences:
{ "notes": [ { "n": 1, "levels": [ { "subject": string, "kind": string, "value": string, "note": string } ] } ] }`;

  try {
    const msg = await client.messages.create({
      model: SONNET_MODEL,
      thinking: THINKING_OFF,
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    const parsed = parseModelJson<{ notes?: Array<{ n?: number; levels?: unknown }> }>(
      text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""),
    );
    if (!parsed.ok || !Array.isArray(parsed.value?.notes)) {
      log.error("unparseable levels output:", text.slice(0, 400));
      await markLevelsFailed();
      return store;
    }
    const byN = new Map(parsed.value.notes.map((x) => [x.n, x.levels]));
    // Read-merge-write: re-read so a concurrent extraction's notes survive.
    const latest = await readLevels();
    const at = new Date().toISOString();
    batch.forEach((b, i) => {
      latest.notes[noteId(b.author, b.e.date)] = { textHash: b.hash, extractedAt: at, levels: normalizeLevels(byN.get(i + 1)) };
    });
    const next = pruneStore({ ...latest, lastFailAt: undefined });
    await (await getRedis()).set(LEVELS_KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    log.error("levels extraction failed:", e);
    await markLevelsFailed();
    return store;
  }
}

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const history = await loadStrategistHistory();
  const n = latestTwo(history.newton);
  const l = latestTwo(history.lee);

  if (!n.latest && !l.latest) return NextResponse.json({ result: null, empty: true, levels: [] });

  const levels: ActiveLevel[] = activeLevels(await refreshLevels(history));

  const hash = createHash("md5")
    .update(JSON.stringify([PROMPT_VERSION, n.latest, n.prior?.date, l.latest, l.prior?.date]))
    .digest("hex");
  const cached = await readCache();
  if (!force && cached?.hash === hash) return NextResponse.json({ result: cached.result, cached: true, levels });

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
    return NextResponse.json({ result: cached?.result ?? null, stale: Boolean(cached), error: "Could not summarize the latest notes.", levels });
  }
  try {
    await (await getRedis()).set(CACHE_KEY, JSON.stringify({ hash, result } satisfies Cached));
  } catch (e) {
    log.error("cache write failed:", e);
  }
  return NextResponse.json({ result, cached: false, levels });
}
