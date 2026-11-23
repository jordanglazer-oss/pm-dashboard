import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { parseModelJson } from "@/app/lib/json-repair";
import { SONNET_MODEL, THINKING_OFF } from "@/app/lib/claude-model";
import { loadStrategistHistory, type StrategistEntry } from "@/app/lib/forward-looking";
import { stripReportAppendices } from "@/app/lib/strategist-note-prompt";
import {
  KEEP_DAYS,
  NOTE_PREFIX,
  addDays,
  archiveDates,
  buildPromptInput,
  easternDay,
  estimateUsd,
  isDay,
  noteKey,
  sanitizeSections,
  splitEarnings,
  type EarningsDate,
  type MorningNote,
  type PromptInput,
  type SnapshotLine,
} from "@/app/lib/morning-note-shared";

/**
 * Morning note (Nov 2026) — the team's pre-open read for weekdays, built from
 * what the dashboard already holds plus that morning's news. ADDITIVE: it
 * does not read or change the existing Brief (pm:brief) in any way.
 *
 * What comes from where:
 *   • Pre-market snapshot — Yahoo quotes fetched in code. The model is shown
 *     the figures and told not to restate them; it never supplies one.
 *   • Earnings dates — pm:stocks (Portfolio + Watchlist), holdings first.
 *   • Strategist digest — the Newton + Lee notes in pm:strategist-history.
 *   • News, geopolitics, the calendar, the line on the prior close and the
 *     client talking points — ONE Sonnet call on the MAIN key with at most
 *     MAX_SEARCHES web searches. Every news / geopolitics item must carry a
 *     source link or it is dropped (sanitizeSections); forums and social
 *     sites are never accepted as a source.
 *
 * Redis: reads pm:stocks, pm:strategist-history, pm:street-takeaways
 * READ-ONLY. Writes ONLY `pm:morning-note:<YYYY-MM-DD>` for TODAY (Eastern) —
 * a regenerate replaces today's note; a past day is never rewritten — with a
 * KEEP_DAYS expiry (nothing is deleted by hand), plus a 5-minute run lock
 * `pm:morning-note-lock` so the cron and the button cannot both spend.
 * The notes are BACKED UP (not in the backup exclude list). Losing them
 * loses the archive only.
 */

const log = createLogger("Morning-note");
const LOCK_KEY = "pm:morning-note-lock";
/** Cost bound: searches per run, output tokens, and the size of what we send. */
export const MAX_SEARCHES = 6;
const MAX_TOKENS = 5000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const SNAPSHOT: { key: string; label: string; yahoo: string; unit?: string; note?: string }[] = [
  { key: "es", label: "S&P 500 futures", yahoo: "ES=F" },
  { key: "nq", label: "Nasdaq 100 futures", yahoo: "NQ=F" },
  { key: "tsx", label: "S&P/TSX Composite", yahoo: "^GSPTSE", note: "last close (no TSX futures quote on our feed)" },
  { key: "spx", label: "S&P 500", yahoo: "^GSPC", note: "last close" },
  { key: "us10y", label: "US 10-year yield", yahoo: "^TNX", unit: "%" },
  { key: "us5y", label: "US 5-year yield", yahoo: "^FVX", unit: "%" },
  { key: "oil", label: "WTI crude", yahoo: "CL=F" },
  { key: "gold", label: "Gold", yahoo: "GC=F" },
  { key: "usdcad", label: "USD/CAD", yahoo: "USDCAD=X", unit: "fx" },
  { key: "vix", label: "VIX", yahoo: "^VIX" },
];

async function quote(symbol: string): Promise<{ price: number; prev: number | null } | null> {
  try {
    const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const r = (await res.json())?.chart?.result?.[0];
    const price = r?.meta?.regularMarketPrice;
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    // Prior close = the last daily close BEFORE the bar the live price sits in.
    const closes: number[] = (r?.indicators?.quote?.[0]?.close ?? []).filter((c: unknown): c is number => typeof c === "number" && Number.isFinite(c));
    const metaPrev = r?.meta?.chartPreviousClose;
    const prev = closes.length >= 2 ? closes[closes.length - 2] : typeof metaPrev === "number" ? metaPrev : null;
    return { price, prev };
  } catch {
    return null;
  }
}

/** The pre-market snapshot, from Yahoo. A failed quote reads "n/a". */
export async function fetchSnapshot(): Promise<SnapshotLine[]> {
  const quotes = await Promise.all(SNAPSHOT.map((s) => quote(s.yahoo)));
  return SNAPSHOT.map((s, i) => {
    const q = quotes[i];
    if (!q) return { key: s.key, label: s.label, value: null, changePct: null, ...(s.unit ? { unit: s.unit } : {}), ...(s.note ? { note: s.note } : {}) };
    // Yields move in points, everything else in per cent.
    const change = q.prev == null || q.prev === 0 ? null : s.unit === "%" ? q.price - q.prev : (q.price / q.prev - 1) * 100;
    return { key: s.key, label: s.label, value: parseFloat(q.price.toFixed(4)), changePct: change == null ? null : parseFloat(change.toFixed(2)), ...(s.unit ? { unit: s.unit } : {}), ...(s.note ? { note: s.note } : {}) };
  });
}

const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

type StockRow = { ticker?: string; name?: string; bucket?: string; healthData?: { earningsDate?: string } };
type Alert = { ticker?: string; kind?: string; date?: string; event?: string; overview?: string; guidance?: string; headline?: string; results?: unknown };

function latestTwo(entries: StrategistEntry[], today: string) {
  const recent = entries.filter((e) => e.date <= today && e.date >= addDays(today, -10)).sort((a, b) => a.date.localeCompare(b.date));
  const clean = (e?: StrategistEntry) => (e ? { date: e.date, text: stripReportAppendices(e.text).text } : undefined);
  return { latest: clean(recent[recent.length - 1]), prior: clean(recent[recent.length - 2]) };
}

/** Everything the note is built from, gathered READ-ONLY. */
export async function gatherInput(today: string): Promise<PromptInput & { onFileTickers: string[] }> {
  const redis = await getRedis();
  const [stocksRaw, alertsRaw, history, snapshot] = await Promise.all([redis.get("pm:stocks"), redis.get("pm:street-takeaways"), loadStrategistHistory(), fetchSnapshot()]);
  const stocksParsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(stocksParsed) ? stocksParsed : []) as StockRow[];
  const pick = (bucket: string) => stocks.filter((s) => s.bucket === bucket && s.ticker).map((s) => ({ ticker: s.ticker!.toUpperCase(), ...(s.name ? { name: s.name } : {}) }));
  const held = pick("Portfolio");
  const watchlist = pick("Watchlist");

  const dates: EarningsDate[] = stocks
    .filter((s) => (s.bucket === "Portfolio" || s.bucket === "Watchlist") && s.ticker && isDay(s.healthData?.earningsDate?.slice(0, 10)))
    .map((s) => ({ ticker: s.ticker!.toUpperCase(), ...(s.name ? { name: s.name } : {}), date: s.healthData!.earningsDate!.slice(0, 10), held: s.bucket === "Portfolio" }));
  const { today: earningsToday, week: earningsWeek } = splitEarnings(dates, today);

  // FactSet recaps / news filed for our names in the last three days.
  const since = addDays(today, -3);
  const book = new Set([...held, ...watchlist].map((s) => s.ticker));
  const alerts = parse<Record<string, Alert[]>>(alertsRaw, {});
  const onFile: PromptInput["onFile"] = [];
  for (const [tk, list] of Object.entries(alerts && typeof alerts === "object" ? alerts : {})) {
    if (!book.has(tk.toUpperCase()) || !Array.isArray(list)) continue;
    for (const a of list) {
      const date = (a?.date ?? "").slice(0, 10);
      if (!isDay(date) || date < since) continue;
      const text = [a.event, a.headline, a.overview, a.guidance ? `Guidance: ${a.guidance}` : "", a.results ? `Results: ${JSON.stringify(a.results).slice(0, 700)}` : ""].filter(Boolean).join(" ");
      if (text) onFile.push({ ticker: tk.toUpperCase(), date, kind: a.kind ?? "alert", text });
    }
  }
  onFile.sort((a, b) => b.date.localeCompare(a.date));

  return {
    date: today,
    snapshot,
    held,
    watchlist,
    earningsToday,
    earningsWeek,
    onFile,
    onFileTickers: [...new Set(onFile.map((x) => x.ticker))],
    notes: [
      { author: "Mark Newton (Fundstrat, technical strategy)", ...latestTwo(history.newton, today) },
      { author: "Tom Lee (Fundstrat, head of research)", ...latestTwo(history.lee, today) },
    ],
  };
}

export const SYSTEM_PROMPT = `You write the "Morning note" for a Canadian portfolio management team: a quick read before the open, plus talking points for client conversations. You are given what the team already holds on file. Use web search (you have at most ${MAX_SEARCHES} searches — spend them on this morning's market news, results out this morning for the listed names, today's US and Canadian data calendar, and geopolitics) to fill in the rest.

HARD RULES
- Every figure you write must come from the material you are given or from a page you retrieved in this conversation. If you cannot confirm a figure, leave it out. Never estimate, never recall from memory.
- Do NOT restate or alter the pre-market snapshot figures; the reader already sees them.
- Every news item, every geopolitics item and the line on the prior close must carry the link of the page it came from. An item without a link will be discarded.
- Never use Reddit, forums or social media as a source. Prefer wire services, major financial press, company releases, central banks and statistics agencies.
- No quotes longer than a short phrase, and use them rarely.
- Geopolitics: only events with a real market channel, and name that channel (oil, rates, the Canadian dollar, a sector, a supply chain).
- Strategists: use ONLY the notes provided. Attribute each point to its author. If the latest note differs from the prior one, say what changed in "changeFromPrior"; if nothing changed, omit that field. If no note is on file for an author, leave them out.
- Client talking points: 2 to 4 concerns a client is likely to raise today. Each response is 2 or 3 calm, plain-English sentences, anchored to the strategists' views where relevant (with attribution). No predictions, no guarantees, no recommendation to buy or sell any security.
- Earnings: "earningsReported" is ONLY for names in our holdings or watchlist whose results are already out (use the FactSet alerts on file first, then search). One or two sentences each: results against consensus, the key figure, guidance, management's main message; "reaction" is the pre-market or after-hours move if you retrieved it.
- Plain English, Canadian spelling, no jargon left unexplained.

Answer with ONE JSON object and nothing else:
{
  "closeLine": { "text": "one sentence on the last close and what drove it", "sources": [{ "title": "...", "url": "https://..." }] },
  "earningsReported": [{ "ticker": "ABC", "summary": "...", "reaction": "...", "sources": [{ "title": "...", "url": "https://..." }] }],
  "news": [{ "headline": "...", "whyItMatters": "one line on why it matters to this portfolio", "tickers": ["ABC"], "source": { "title": "...", "url": "https://..." } }],
  "geopolitics": [{ "event": "...", "channel": "...", "source": { "title": "...", "url": "https://..." } }],
  "strategists": [{ "author": "...", "noteDate": "YYYY-MM-DD", "points": ["..."], "changeFromPrior": "..." }],
  "calendar": [{ "timeET": "8:30", "event": "...", "consensus": "...", "prior": "...", "source": { "title": "...", "url": "https://..." } }],
  "talkingPoints": [{ "concern": "...", "response": "...", "attribution": "..." }]
}
"news" holds 4 to 7 items, with items touching our holdings first. Use empty arrays where there is nothing to report.`;

export type ModelCall = (system: string, user: string) => Promise<{ text: string; inputTokens: number; outputTokens: number; searches: number }>;

/** The one paid call: Sonnet on the main key with capped web search. */
const callSonnet: ModelCall = async (system, user) => {
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: SONNET_MODEL,
    thinking: THINKING_OFF,
    max_tokens: MAX_TOKENS,
    system,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage = resp.usage as Anthropic.Usage & { server_tool_use?: { web_search_requests?: number } };
  return { text, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, searches: usage.server_tool_use?.web_search_requests ?? 0 };
};

/** Build today's note. Pure apart from the injected model call. */
export async function composeNote(input: PromptInput & { onFileTickers: string[] }, call: ModelCall = callSonnet, now: Date = new Date()): Promise<MorningNote> {
  const base: MorningNote = {
    date: input.date,
    generatedAt: now.toISOString(),
    snapshot: input.snapshot,
    closeLine: null,
    earningsToday: input.earningsToday,
    earningsWeek: input.earningsWeek,
    earningsReported: [],
    news: [],
    geopolitics: [],
    strategists: [],
    calendar: [],
    talkingPoints: [],
  };
  const warnings: string[] = [];
  if (input.snapshot.every((l) => l.value == null)) warnings.push("The price feed returned nothing, so the snapshot is empty.");
  try {
    const res = await call(SYSTEM_PROMPT, buildPromptInput(input));
    const parsed = parseModelJson<unknown>(res.text);
    const usage = { inputTokens: res.inputTokens, outputTokens: res.outputTokens, searches: res.searches, estUsd: estimateUsd(res.inputTokens, res.outputTokens, res.searches), model: SONNET_MODEL };
    if (!parsed.ok) {
      warnings.push("The written sections could not be read this run; press Regenerate to try again.");
      log.warn("model answer was not JSON:", parsed.error);
      return { ...base, usage, warnings };
    }
    const sections = sanitizeSections(parsed.value, input.held.map((h) => h.ticker), input.onFileTickers);
    return { ...base, ...sections, usage, ...(warnings.length ? { warnings } : {}) };
  } catch (e) {
    log.error("model call failed:", e);
    warnings.push("The news and talking-point sections could not be written this run (the AI call failed); the snapshot and earnings dates are from our own data.");
    return { ...base, warnings };
  }
}

async function scanKeys(): Promise<string[]> {
  const redis = await getRedis();
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: `${NOTE_PREFIX}*`, COUNT: 200 })) {
    if (Array.isArray(k)) keys.push(...k);
    else keys.push(k);
  }
  return keys;
}

/** Dates with a note on file, newest first. [] on a read error — never seeds. */
export async function listNoteDates(today: string = easternDay()): Promise<string[]> {
  try {
    return archiveDates(await scanKeys(), today);
  } catch (e) {
    log.error("list failed:", e);
    return [];
  }
}

export async function readNote(date: string): Promise<MorningNote | null> {
  if (!isDay(date)) return null;
  try {
    return parse<MorningNote | null>(await (await getRedis()).get(noteKey(date)), null);
  } catch (e) {
    log.error("read failed:", e);
    return null;
  }
}

export type GenerateResult = { ok: boolean; note?: MorningNote; skipped?: string; error?: string };

/**
 * Generate TODAY's note and store it. `ifMissing` (the cron) returns the note
 * already on file instead of spending again. A run in progress refuses a
 * second one for five minutes.
 */
export async function generateMorningNote(opts: { ifMissing?: boolean } = {}): Promise<GenerateResult> {
  const today = easternDay();
  const redis = await getRedis();
  if (opts.ifMissing) {
    const existing = await readNote(today);
    if (existing) return { ok: true, note: existing, skipped: "today's note is already on file" };
  }
  const locked = await redis.set(LOCK_KEY, new Date().toISOString(), { NX: true, EX: 300 });
  if (!locked) return { ok: false, skipped: "a morning note is already being written — try again in a few minutes" };
  try {
    const note = await composeNote(await gatherInput(today));
    // Never replace a good note with one whose written sections failed.
    const wrote = note.news.length + note.talkingPoints.length + note.strategists.length > 0;
    const existing = await readNote(today);
    if (!wrote && existing && existing.news.length + existing.talkingPoints.length > 0) return { ok: false, note: existing, error: note.warnings?.[0] ?? "the new note came back empty; the earlier one was kept" };
    await redis.set(noteKey(today), JSON.stringify(note), { EX: KEEP_DAYS * 86_400 });
    log.info(`written for ${today}: ${note.news.length} news, ${note.talkingPoints.length} talking points, est $${note.usage?.estUsd ?? 0}`);
    return { ok: true, note };
  } catch (e) {
    log.error("generate failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    // Release the lock by letting it lapse (no delete call anywhere in here).
    await redis.expire(LOCK_KEY, 1).catch(() => {});
  }
}
