/**
 * Morning note — types and PURE helpers (no Redis, no network), shared by
 * the server generator (app/lib/morning-note.ts), the Brief panel and the
 * tests. See morning-note.ts for the storage and cost rules.
 */

export const NOTE_PREFIX = "pm:morning-note:";
/** Days of notes kept (the key expires on its own; nothing is deleted by hand). */
export const KEEP_DAYS = 100;

export type Source = { title?: string; url: string };
export type SnapshotLine = { key: string; label: string; value: number | null; changePct: number | null; unit?: string; note?: string };
export type EarningsDate = { ticker: string; name?: string; date: string; held: boolean };

export type MorningNote = {
  date: string; // YYYY-MM-DD, Eastern
  generatedAt: string; // ISO
  /** From code (Yahoo quotes) — never from the model. */
  snapshot: SnapshotLine[];
  /** One line on the prior close and what drove it (model, with sources). */
  closeLine: { text: string; sources: Source[] } | null;
  /** From data on file (pm:stocks earnings dates), holdings first. */
  earningsToday: EarningsDate[];
  earningsWeek: EarningsDate[];
  /** Results already out (model, from the FactSet recaps on file + search). */
  earningsReported: { ticker: string; held: boolean; summary: string; reaction?: string; sources: Source[] }[];
  news: { headline: string; whyItMatters: string; tickers: string[]; source: Source }[];
  geopolitics: { event: string; channel: string; source: Source }[];
  strategists: { author: string; noteDate?: string; points: string[]; changeFromPrior?: string }[];
  calendar: { timeET?: string; event: string; consensus?: string; prior?: string; source?: Source }[];
  talkingPoints: { concern: string; response: string; attribution?: string }[];
  /** What the run cost, measured from the API's own usage figures. */
  usage?: { inputTokens: number; outputTokens: number; searches: number; estUsd: number; model: string };
  /** Why a section is empty, when something upstream failed. */
  warnings?: string[];
};

/** Today's date in Toronto / New York. */
export const easternDay = (d: Date = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
export const noteKey = (date: string) => `${NOTE_PREFIX}${date}`;
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isWeekday = (date: string) => {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Archive dates from a key listing: valid, within the window, newest first. */
export function archiveDates(keys: string[], today: string, keepDays: number = KEEP_DAYS): string[] {
  const cut = addDays(today, -keepDays);
  const out = new Set<string>();
  for (const k of keys) {
    if (!k.startsWith(NOTE_PREFIX)) continue;
    const d = k.slice(NOTE_PREFIX.length);
    if (isDay(d) && d >= cut && d <= today) out.add(d);
  }
  return [...out].sort().reverse();
}

const BANNED_HOSTS = /(^|\.)(reddit\.com|redd\.it|stocktwits\.com|4chan\.org|quora\.com|discord\.com|x\.com|twitter\.com|facebook\.com|tiktok\.com)$/i;
const FORUM_HINT = /(^|\.)(forum|forums|boards)\./i;

/** A usable source: an http(s) link that is not a forum or social site. */
export function cleanSource(s: unknown): Source | null {
  if (!s || typeof s !== "object") return null;
  const url = (s as Source).url;
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./, "");
    if (BANNED_HOSTS.test(host) || FORUM_HINT.test(u.hostname)) return null;
    const rawTitle = (s as Source).title;
    const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 160) : "";
    return title ? { title, url: u.toString() } : { url: u.toString() };
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 600): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sources = (v: unknown): Source[] => arr(v).map(cleanSource).filter((x): x is Source => !!x).slice(0, 4);

export type ModelSections = Pick<MorningNote, "closeLine" | "earningsReported" | "news" | "geopolitics" | "strategists" | "calendar" | "talkingPoints">;

/**
 * Turn the model's raw JSON into the stored sections. Anything that breaks a
 * content rule is DROPPED, not repaired: a news / geopolitics item or a
 * reported-earnings line with no usable source link (a results line may
 * instead rest on a FactSet recap we hold), a geopolitics item with
 * no market channel, an empty line. `held` is decided here from our own list,
 * never taken from the model.
 */
export function sanitizeSections(raw: unknown, heldTickers: string[], onFileTickers: string[] = []): ModelSections {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const held = new Set(heldTickers.map((t) => t.toUpperCase()));
  // A results line needs a link, unless we hold a FactSet recap for that name.
  const onFile = new Set(onFileTickers.map((t) => t.toUpperCase()));
  const tick = (v: unknown) => str(v, 12).toUpperCase();
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  const close = obj(r.closeLine);
  const closeSources = sources(close.sources);
  const closeLine = str(close.text) && closeSources.length ? { text: str(close.text), sources: closeSources } : null;

  const earningsReported = arr(r.earningsReported)
    .map(obj)
    .map((e) => ({ ticker: tick(e.ticker), held: held.has(tick(e.ticker)), summary: str(e.summary, 700), ...(str(e.reaction, 200) ? { reaction: str(e.reaction, 200) } : {}), sources: sources(e.sources) }))
    .filter((e) => e.ticker && e.summary && (e.sources.length > 0 || onFile.has(e.ticker)))
    .sort((a, b) => Number(b.held) - Number(a.held))
    .slice(0, 10);

  const news = arr(r.news)
    .map(obj)
    .map((n) => ({ headline: str(n.headline, 240), whyItMatters: str(n.whyItMatters, 400), tickers: arr(n.tickers).map(tick).filter(Boolean).slice(0, 6), source: cleanSource(n.source) }))
    .filter((n): n is { headline: string; whyItMatters: string; tickers: string[]; source: Source } => !!n.headline && !!n.whyItMatters && !!n.source)
    .slice(0, 7);

  const geopolitics = arr(r.geopolitics)
    .map(obj)
    .map((g) => ({ event: str(g.event, 300), channel: str(g.channel, 300), source: cleanSource(g.source) }))
    .filter((g): g is { event: string; channel: string; source: Source } => !!g.event && !!g.channel && !!g.source)
    .slice(0, 4);

  const strategists = arr(r.strategists)
    .map(obj)
    .map((s) => ({
      author: str(s.author, 60),
      ...(isDay(s.noteDate) ? { noteDate: s.noteDate } : {}),
      points: arr(s.points).map((p) => str(p, 320)).filter(Boolean).slice(0, 5),
      ...(str(s.changeFromPrior, 320) ? { changeFromPrior: str(s.changeFromPrior, 320) } : {}),
    }))
    .filter((s) => s.author && s.points.length)
    .slice(0, 4);

  const calendar = arr(r.calendar)
    .map(obj)
    .map((c) => {
      const src = cleanSource(c.source);
      return {
        ...(str(c.timeET, 20) ? { timeET: str(c.timeET, 20) } : {}),
        event: str(c.event, 200),
        // A consensus / prior figure is only kept when the row carries a source.
        ...(src && str(c.consensus, 40) ? { consensus: str(c.consensus, 40) } : {}),
        ...(src && str(c.prior, 40) ? { prior: str(c.prior, 40) } : {}),
        ...(src ? { source: src } : {}),
      };
    })
    .filter((c) => c.event)
    .slice(0, 12);

  const talkingPoints = arr(r.talkingPoints)
    .map(obj)
    .map((t) => ({ concern: str(t.concern, 200), response: str(t.response, 700), ...(str(t.attribution, 120) ? { attribution: str(t.attribution, 120) } : {}) }))
    .filter((t) => t.concern && t.response)
    .slice(0, 4);

  return { closeLine, earningsReported, news, geopolitics, strategists, calendar, talkingPoints };
}

/** Holdings first, then by date, then ticker. One row per ticker. */
export function splitEarnings(rows: EarningsDate[], today: string): { today: EarningsDate[]; week: EarningsDate[] } {
  const end = addDays(today, 7);
  const order = (a: EarningsDate, b: EarningsDate) => Number(b.held) - Number(a.held) || a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker);
  const seen = new Set<string>();
  const uniq: EarningsDate[] = [];
  for (const r of rows) {
    if (!isDay(r.date) || seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    uniq.push(r);
  }
  return { today: uniq.filter((r) => r.date === today).sort(order), week: uniq.filter((r) => r.date > today && r.date <= end).sort(order) };
}

const fmtNum = (v: number, unit?: string) => (unit === "%" ? `${v.toFixed(2)}%` : unit === "fx" ? v.toFixed(4) : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2));
export const snapshotText = (l: SnapshotLine) =>
  l.value == null
    ? `${l.label}: n/a`
    : `${l.label}: ${fmtNum(l.value, l.unit)}${l.changePct != null ? ` (${l.changePct >= 0 ? "+" : ""}${l.changePct.toFixed(2)}${l.unit === "%" ? " pts" : "%"})` : ""}${l.note ? ` — ${l.note}` : ""}`;

const link = (s: Source) => (s.title ? `${s.title} — ${s.url}` : s.url);
const earnLine = (e: EarningsDate) => `${e.ticker}${e.held ? " (held)" : " (watchlist)"}${e.name ? ` — ${e.name}` : ""}, ${e.date}`;

/** Only the client talking points, as plain text. */
export function talkingPointsText(n: MorningNote): string {
  return n.talkingPoints.map((t, i) => `${i + 1}. ${t.concern}\n${t.response}${t.attribution ? ` (${t.attribution})` : ""}`).join("\n\n");
}

/** The whole note as plain text, for pasting into an email. */
export function noteToText(n: MorningNote): string {
  const out: string[] = [`Morning note — ${n.date}`, ""];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(title.toUpperCase(), ...lines, "");
  };
  section("Pre-market snapshot", [...n.snapshot.filter((l) => l.value != null).map(snapshotText), ...(n.closeLine ? [n.closeLine.text] : [])]);
  section("Earnings today", n.earningsToday.map(earnLine));
  section("Earnings already out", n.earningsReported.map((e) => `${e.ticker}${e.held ? " (held)" : ""}: ${e.summary}${e.reaction ? ` Reaction: ${e.reaction}` : ""}`));
  section("Earnings in the next week", n.earningsWeek.map(earnLine));
  section("News that matters", n.news.flatMap((x) => [`- ${x.headline}`, `  Why it matters: ${x.whyItMatters}`, `  ${link(x.source)}`]));
  section("Geopolitics", n.geopolitics.flatMap((g) => [`- ${g.event}`, `  Market channel: ${g.channel}`, `  ${link(g.source)}`]));
  section("What our strategists are saying", n.strategists.flatMap((s) => [`${s.author}${s.noteDate ? ` (note of ${s.noteDate})` : ""}`, ...s.points.map((p) => `- ${p}`), ...(s.changeFromPrior ? [`  Change from prior: ${s.changeFromPrior}`] : [])]));
  section("Today's calendar", n.calendar.map((c) => `- ${c.timeET ? `${c.timeET} ET  ` : ""}${c.event}${c.consensus ? ` · consensus ${c.consensus}` : ""}${c.prior ? ` · prior ${c.prior}` : ""}`));
  section("Client talking points", [talkingPointsText(n)].filter(Boolean));
  return out.join("\n").trim();
}

export type PromptInput = {
  date: string;
  snapshot: SnapshotLine[];
  held: { ticker: string; name?: string }[];
  watchlist: { ticker: string; name?: string }[];
  earningsToday: EarningsDate[];
  earningsWeek: EarningsDate[];
  /** FactSet recaps / news already on file for our names (last few days). */
  onFile: { ticker: string; date: string; kind: string; text: string }[];
  notes: { author: string; latest?: { date: string; text: string }; prior?: { date: string; text: string } }[];
};

export const MAX_NOTE_CHARS = 7000;
export const MAX_PRIOR_CHARS = 2500;
export const MAX_ONFILE_ITEMS = 12;
export const MAX_ONFILE_CHARS = 1200;

/** The user message: every fact we already hold, bounded in size. Pure. */
export function buildPromptInput(i: PromptInput): string {
  const names = (l: { ticker: string; name?: string }[]) => l.map((s) => (s.name ? `${s.ticker} (${s.name})` : s.ticker)).join(", ") || "none";
  const lines: string[] = [
    `TODAY: ${i.date} (Eastern). Write the morning note for this date.`,
    "",
    "=== PRE-MARKET SNAPSHOT (from our price feed — already shown to the reader; do NOT restate or change these figures) ===",
    ...i.snapshot.map(snapshotText),
    "",
    `=== WHAT WE HOLD (${i.held.length}) ===`,
    names(i.held),
    "",
    `=== WATCHLIST (${i.watchlist.length}) ===`,
    names(i.watchlist),
    "",
    "=== EARNINGS DATES ON FILE ===",
    `Today: ${i.earningsToday.map(earnLine).join("; ") || "none of our names"}`,
    `Next 7 days: ${i.earningsWeek.map(earnLine).join("; ") || "none of our names"}`,
    "",
    "=== FACTSET ALERTS ON FILE FOR OUR NAMES (last few days) ===",
    ...(i.onFile.length ? i.onFile.slice(0, MAX_ONFILE_ITEMS).map((x) => `[${x.ticker} · ${x.date} · ${x.kind}] ${x.text.slice(0, MAX_ONFILE_CHARS)}`) : ["none"]),
    "",
    "=== STRATEGIST / TECHNICIAN NOTES ON FILE ===",
  ];
  for (const n of i.notes) {
    lines.push(`--- ${n.author} ---`);
    if (!n.latest) {
      lines.push("No recent note on file.");
      continue;
    }
    lines.push(`LATEST (${n.latest.date}):`, n.latest.text.slice(0, MAX_NOTE_CHARS));
    if (n.prior) lines.push(`PRIOR (${n.prior.date}) — for spotting a change of view only:`, n.prior.text.slice(0, MAX_PRIOR_CHARS));
  }
  return lines.join("\n");
}

/** Sonnet list price per million tokens, and per web search — an ESTIMATE of
 *  what a run cost, from the API's own usage counts. */
export const PRICE = { inPerM: 3, outPerM: 15, perSearch: 0.01 };
export const estimateUsd = (inputTokens: number, outputTokens: number, searches: number) =>
  parseFloat(((inputTokens * PRICE.inPerM + outputTokens * PRICE.outPerM) / 1_000_000 + searches * PRICE.perSearch).toFixed(4));
