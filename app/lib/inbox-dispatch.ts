/**
 * Inbox webhook dispatcher. Maps an email's subject prefix to the right
 * handler so the existing Gmail Apps Script can forward FOUR new kinds of
 * emails into the dashboard (in addition to the legacy Analyst Report PDF
 * flow which lives in app/api/inbox/ingest/route.ts):
 *
 *   - "SIA …"            → /api/sia-scrape equivalent, applied to pm:stocks
 *   - "BoostedAI …" or
 *     "Boosted …"        → /api/boosted-ai-scrape equivalent, applied to pm:stocks
 *   - "MarketEdge …" or
 *     "ChartScout …"     → MarketEdge CSV parsed + applied to pm:stocks
 *   - "Strategist …"     → file dropped into the Brief's "Analyst /
 *                          Strategist Reports" attachment dropbox
 *                          (pm:attachments manifest + pm:attachment:<id>)
 *
 * Each handler returns a structured `DispatchResult` the route hands back
 * to the Apps Script and also appends to pm:inbox-log.
 *
 * All shared parsing / matching logic lives in
 *   - app/lib/screenshot-extractors.ts (vision calls + caching)
 *   - app/lib/marketedge-csv.ts        (CSV parser)
 *   - app/lib/stock-patches.ts         (pure helpers that compute
 *                                       StockPatch[] from entries)
 * so the email path follows the EXACT same logic as the manual Inbox UI.
 */

import { getRedis } from "./redis";
import type { Stock, ScoreKey } from "./types";
import { isScoreable } from "./scoring";
import {
  extractSiaFromAttachments,
  extractBoostedFromAttachments,
  type AttachmentInput,
} from "./screenshot-extractors";
import { parseMarketEdgeCsv } from "./marketedge-csv";
import { parseSiaCsv } from "./sia-csv";
import { writeSiaSnapshot, UNIVERSE_MIN_ROWS, isNamedUniverseExport, looksLikeCompleteIndexCut, type SiaRow } from "./sia-universe";
import { appendSiaHistory } from "./sia-history";
import { sameCompanyLoose, tickersEqual } from "./ticker";
import { parseEquateRows, equateResearchRows } from "./equate-parse";
import { writeEquateSheet } from "./equate-store";
import { parseBoostedCsv } from "./boosted-csv";
import { putDataUrl } from "./blob-store";
import { applySiaEntries, applyBoostedEntries, applyMarketEdgeRows, type StockPatch } from "./stock-patches";
import { decodeBase64DataUrl } from "./csv-utils";
import { extractResearchEntries, type SourceKey as ResearchSourceKey } from "@/app/api/research-scrape/route";
import { applyResearchEntries, type ResearchMergeSummary } from "./research-merge";
import { logResearchRemovals } from "./research-removals";
import type { ResearchState } from "./defaults";
import { defaultResearch, defaultMarketData } from "./defaults";
import { appendStrategistNote } from "./forward-looking";
import { easternToday } from "./date-eastern";
import {
  appendStreetTakeaway,
  describeTakeaway,
  factsetIdToTicker,
  type StreetTakeaway,
} from "./street-takeaways";
import { parseStreetTakeaway, extractPrimaryIdentifier } from "./street-takeaways-parse";

// ── Subject → kind ──────────────────────────────────────────────────

/** Research kinds map 1:1 to the source keys the research-scrape route
 *  accepts; subject-prefix routing produces one of these. */
export type ResearchKind =
  | { kind: "research"; source: ResearchSourceKey };

export type InboxKind =
  | "sia"
  | "equate"
  | "boosted"
  | "marketedge"
  | "strategist"
  | "analyst-report"
  | "street-takeaways"
  | "newton-note"
  | "lee-note"
  | "unknown"
  | ResearchKind;

/** Classify the email's subject. Case-insensitive prefix match. The research
 *  prefixes are ordered most-specific first ("Fundstrat SMID Top" before
 *  "Fundstrat Top") so the regex alternation matches correctly. */
export function classifySubject(subject: string): InboxKind {
  // Strip forwarding prefixes before matching. Almost every pattern below is
  // anchored at the start, so "FW: SIA - 2026-08-17" matched none of them —
  // and forwarding is the normal way these arrive. Handles stacked prefixes
  // ("RE: FW: ...") and the localised forms Gmail emits.
  const s = subject.trim().replace(/^(?:\s*(?:fw|fwd|re|tr|wg|aw|rv)\s*:\s*)+/i, "");
  if (/^analyst report:/i.test(s)) return "analyst-report";
  // RBC EQUATE rank sheets. Matched on the vendor's own wording so the weekly
  // email forwards unedited — its attachments are named
  // "RBC EQUATE Model Ranks - US All Cap - 20260814.xlsx". Separators are
  // stripped before testing rather than trusting \b: the same trap that made
  // "SIA_SP500" and "TSX60" unmatchable.
  if (isEquateLabel(s)) return "equate";
  // ── Research lists (RBC / Fundstrat / Seeking Alpha / RBCCM FEW) ──
  // Fundstrat "Core Ideas" DQM screens first — the "… Core" suffix keeps them
  // distinct from the "… Top/Bottom" idea lists below.
  if (/^fundstrat\s+large[-\s]?cap\s+core\b/i.test(s)) return { kind: "research", source: "fundstrat-largecap-core" };
  if (/^fundstrat\s+smid\s+core\b/i.test(s)) return { kind: "research", source: "fundstrat-smid-core" };
  if (/^fundstrat\s+smid\s+top\b/i.test(s)) return { kind: "research", source: "fundstrat-smid-top" };
  if (/^fundstrat\s+smid\s+bottom\b/i.test(s)) return { kind: "research", source: "fundstrat-smid-bottom" };
  if (/^fundstrat\s+top\b/i.test(s)) return { kind: "research", source: "fundstrat-top" };
  if (/^fundstrat\s+bottom\b/i.test(s)) return { kind: "research", source: "fundstrat-bottom" };
  if (/^rbc\s+canadian\b/i.test(s)) return { kind: "research", source: "rbc-focus" };
  if (/^rbc\s+us\b/i.test(s)) return { kind: "research", source: "rbc-us-focus" };
  if (/^jpm\s+focus\b/i.test(s)) return { kind: "research", source: "jpm-us-analyst-focus" };
  if (/^equate\s+cad\b/i.test(s)) return { kind: "research", source: "rbc-equate-cad" };
  if (/^equate\s+usd\b/i.test(s)) return { kind: "research", source: "rbc-equate-usd" };
  if (/^rbccm\s+few\b/i.test(s)) return { kind: "research", source: "rbccm-few" };
  if (/^(seeking\s+alpha|alpha\s+picks)\b/i.test(s)) return { kind: "research", source: "seeking-alpha-picks" };
  // ── Per-stock external-tool kinds ──
  // Accepts "SIA …" and "SIACharts …" (the vendor's own name), and tolerates
  // any non-alphanumeric separator — \b alone rejected both "SIACharts weekly"
  // and "SIA_SP500" (underscore is a word character), which are exactly what
  // an unedited download or a hand-typed subject looks like. The negative
  // lookahead still refuses genuine words like "Siam".
  if (/^sia(?:charts)?(?![a-z0-9])/i.test(s)) return "sia";
  if (/^(boostedai|boosted)\b/i.test(s)) return "boosted";
  if (/^(marketedge|chartscout)\b/i.test(s)) return "marketedge";
  if (/^strategist\b/i.test(s)) return "strategist";
  // Strategist NOTES — the pasted TEXT of the daily Fundstrat reports, sent as
  // the email BODY (no attachment). Distinct from "Strategist …" above, which
  // files an attached PDF/image into the Brief's dropbox. Same lookahead
  // pattern as SIA so "Newton — Sept 2" and "Lee: weekly" both match while
  // "Newtonville" and "Leeds" don't.
  if (/^(?:mark\s+)?newton(?![a-z0-9])/i.test(s)) return "newton-note";
  if (/^(?:tom\s+)?lee(?![a-z0-9])/i.test(s)) return "lee-note";
  // FactSet earnings alerts — body-text emails, no attachment (see
  // handleStreetTakeaways). Several report formats share one pipeline:
  //   "SA: Street Takeaways - IBM Q2 Earnings"            → analyst reaction
  //   "SA: StreetAccount Metrics Recap - Celestica Q2 …"  → results + guidance
  //   "SA: Transcript Intelligence: … Q&A"                → call Q&A summary
  //   "Celestica reports Q2 EPS $2.54 ex-items vs …"      → plain results
  if (/^(?:sa:\s*)?(?:street\s+takeaways|streetaccount|transcript\s+intelligence)\b/i.test(s)) {
    return "street-takeaways";
  }
  if (/\breports\s+Q[1-4]\b.*\bvs\b/i.test(s)) return "street-takeaways";
  return "unknown";
}

/** True for anything naming itself an RBC EQUATE rank sheet — subject OR
 *  attachment filename, since the files are self-describing and the email
 *  subject is whatever RBC happens to send. */
export function isEquateLabel(label: string | undefined): boolean {
  const flat = (label ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "equate" plus any rank/cap wording. The vendor is not consistent between
  // the email and the files it carries — the subject reads "RBC EQUATE
  // Quantitative Ranks" while the attachments say "RBC EQUATE Model Ranks -
  // US All Cap" — so matching one exact phrase rejected the very emails this
  // was written for. "FW:" / "RE:" prefixes fall out of the flattening.
  return /equate/.test(flat) && /rank|allcap|largecap|midcap|smallcap/.test(flat);
}

/** FactSet alert emails are recognised by SENDER as well as subject, so a
 *  plain forward works without the user retyping a subject convention. */
export function isFactsetAlertSender(sender: string | undefined): boolean {
  return /factset[_.]?alerts?@factset\.com/i.test(sender ?? "");
}

// ── Shared MIME helpers ────────────────────────────────────────────

const IMAGE_MIME_RE = /^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,/i;
const PDF_MIME_RE = /^data:application\/pdf;base64,/i;
// CSV may arrive as text/csv (Gmail), text/plain, or application/vnd.ms-excel.
const CSV_MIME_RE = /^data:(text\/csv|text\/plain|application\/vnd\.ms-excel);base64,/i;

export function isImageDataUrl(dataUrl: string): boolean { return IMAGE_MIME_RE.test(dataUrl); }
export function isPdfDataUrl(dataUrl: string): boolean { return PDF_MIME_RE.test(dataUrl); }
export function isCsvDataUrl(dataUrl: string): boolean { return CSV_MIME_RE.test(dataUrl); }

// CSV decoder is shared with the manual UI via app/lib/csv-utils.ts.

// ── Server-side pm:stocks read-modify-write ────────────────────────

/** Apply a StockPatch[] to the pm:stocks blob directly (no React). Returns
 *  the count of stocks actually touched. Read-modify-write so no other
 *  fields are dropped. */
async function applyPatchesToRedis(patches: StockPatch[]): Promise<{ touched: number }> {
  if (patches.length === 0) return { touched: 0 };
  const redis = await getRedis();
  const raw = await redis.get("pm:stocks");
  if (!raw) return { touched: 0 };
  const stocks = JSON.parse(raw) as Stock[];
  let touched = 0;
  const byTicker = new Map<string, Stock>();
  for (const s of stocks) byTicker.set(s.ticker, s);
  for (const p of patches) {
    const s = byTicker.get(p.ticker);
    if (!s) continue;
    // Field merge.
    if (Object.keys(p.fields).length > 0) {
      Object.assign(s, p.fields);
      touched += 1;
    }
    // Score updates.
    if (p.scoreUpdates && p.scoreUpdates.length > 0) {
      const nextScores = { ...s.scores };
      for (const su of p.scoreUpdates) {
        nextScores[su.key as ScoreKey] = su.value;
      }
      s.scores = nextScores;
    }
  }
  await redis.set("pm:stocks", JSON.stringify(stocks));
  return { touched };
}

async function readStocks(): Promise<Stock[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:stocks");
    if (!raw) return [];
    return JSON.parse(raw) as Stock[];
  } catch {
    return [];
  }
}

// ── Strategist attachments — direct write to pm:attachments ────────

type AttachmentManifestEntry = {
  id: string;
  label: string;
  section: string;
  addedAt: string;
};

/** Pick the manifest id (and thus Blob path) for a strategist attachment.
 *  Two FIXED author slots — a file naming "Newton" (Mark Newton) or "Lee"
 *  (Tom Lee) reuses a stable id, so a fresh presentation OVERWRITES the prior
 *  one (the dropbox holds at most one of each). Anything else gets a unique
 *  id and appends to the general Strategist dropbox as before. */
function strategistSlotId(label: string): string {
  const l = label.toLowerCase();
  if (/\bnewton\b/.test(l)) return "strategist-newton";
  if (/\blee\b/.test(l)) return "strategist-lee";
  return `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append (or, for an author slot, OVERWRITE) a strategist attachment in the
 *  Brief's dropbox. Lightweight manifest in pm:attachments (Redis); the
 *  per-file dataUrl is archived in Vercel Blob at attachments/<id> (no longer
 *  Redis — multi-MB base64 was an OOM source). */
async function addStrategistAttachment(dataUrl: string, label: string): Promise<{ id: string }> {
  const redis = await getRedis();
  const id = strategistSlotId(label);
  // 1) per-file payload → Blob. A fixed author-slot id maps to a stable path
  //    (putDataUrl defaults to allowOverwrite), so it replaces the old file.
  await putDataUrl(`attachments/${id}`, dataUrl);
  // 2) manifest: drop any existing entry with this id (the author slot being
  //    replaced), then append the fresh one.
  const raw = await redis.get("pm:attachments");
  const existing: AttachmentManifestEntry[] = raw ? JSON.parse(raw) : [];
  const entry: AttachmentManifestEntry = {
    id,
    label: label.slice(0, 200),
    section: "strategistReports",
    addedAt: new Date().toISOString(),
  };
  await redis.set("pm:attachments", JSON.stringify([...existing.filter((e) => e.id !== id), entry]));
  return { id };
}

// ── Strategist notes (Newton / Lee body-text email) ────────────────

/** The RBC work-email system appends a bilingual compliance footer
 *  (unsubscribe + confidentiality, EN then FR) to EVERY outbound email — it
 *  can't be removed at compose time. Truncate at the first marker so only the
 *  pasted report text is stored; each block gets its own marker so the note
 *  survives even if the mail system reorders or drops one of them. Matching
 *  is case-insensitive on distinctive full phrases — generic separators like
 *  underscore rules are deliberately NOT markers, since a pasted report could
 *  plausibly contain one. */
const EMAIL_FOOTER_MARKERS = [
  "respecting your privacy and preferences for electronic communications",
  "this email may be privileged and/or confidential",
  "le respect de votre vie privée et de vos préférences",
  "ce courrier électronique est confidentiel et protégé",
];

export function stripEmailFooter(text: string): { text: string; stripped: boolean } {
  const lower = text.toLowerCase();
  let cut = text.length;
  for (const marker of EMAIL_FOOTER_MARKERS) {
    const i = lower.indexOf(marker);
    if (i >= 0 && i < cut) cut = i;
  }
  if (cut === text.length) return { text: text.trim(), stripped: false };
  // Drop any separator line ("____", "--", whitespace) left dangling just
  // above the footer.
  return { text: text.slice(0, cut).replace(/[\s_\-–—*]+$/, "").trim(), stripped: true };
}

/**
 * Store the pasted text of a Fundstrat daily note into
 * pm:market.strategistNotes — the exact field the Brief's manual paste UI
 * writes — plus the rolling 30-day history via appendStrategistNote (same
 * pairing as the PUT /api/kv/market path, so the two entry points stay
 * equivalent).
 *
 * Date: an ISO YYYY-MM-DD anywhere in the subject wins ("Lee 2026-09-01"
 * backfills a note sent late); otherwise today's EASTERN date, matching the
 * "done today" check in the Brief UI.
 *
 * Timing tags are preserved if already set and defaulted otherwise to each
 * strategist's documented pattern (Newton → prior-close, Lee → pre-market);
 * the UI selector remains the override.
 */
async function handleStrategistNote(
  strategist: "newton" | "lee",
  bodyText: string,
  subject: string,
): Promise<DispatchResult> {
  const kind: InboxKind = strategist === "newton" ? "newton-note" : "lee-note";
  const who = strategist === "newton" ? "Newton" : "Lee";
  const { text, stripped } = stripEmailFooter((bodyText ?? "").trim());
  // A real note is hundreds of words; a short body means the paste didn't
  // make it into the email. Refuse (4xx = permanent, no Apps Script retry)
  // rather than storing junk the Brief prompt would then reason from.
  if (text.length < 100) {
    return {
      ok: false,
      kind,
      status: 400,
      message: `${who} note body was too short to store (${text.length} chars) — paste the report text into the email BODY, not an attachment.`,
    };
  }
  const date = subject.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? easternToday();

  // Read-modify-write pm:market, merging BOTH levels: the top-level blob and
  // the nested strategistNotes object, so the other strategist's note and
  // every unrelated market field survive. Missing-key fallback mirrors the
  // PUT /api/kv/market route (defaultMarketData), not an empty object.
  const redis = await getRedis();
  const raw = await redis.get("pm:market");
  const market = raw ? (JSON.parse(raw) as Record<string, unknown>) : { ...defaultMarketData } as Record<string, unknown>;
  const prev = (market.strategistNotes ?? {}) as Record<string, unknown>;
  const strategistNotes =
    strategist === "newton"
      ? { ...prev, newton: text, newtonDate: date, newtonTiming: prev.newtonTiming ?? "prior-close" }
      : { ...prev, lee: text, leeDate: date, leeTiming: prev.leeTiming ?? "pre-market" };
  await redis.set("pm:market", JSON.stringify({ ...market, strategistNotes }));

  // Rolling 30-day history — best-effort, same as the kv/market PUT path.
  await appendStrategistNote(strategist, text, date).catch((err) =>
    console.error(`[Inbox] ${who} note history append failed:`, err),
  );

  const words = text.split(/\s+/).length;
  return {
    ok: true,
    kind,
    message: `${who} note stored for ${date} (${words} words${stripped ? ", compliance footer stripped" : ""}). It will feed the next Morning Brief.`,
    detail: { strategist, date, words, chars: text.length, footerStripped: stripped },
  };
}

// ── Street Takeaways (FactSet body-text email) ─────────────────────

/**
 * Parse a FactSet "Street Takeaways" alert and file it against the ticker.
 * Body-text only (these emails carry no attachment). Scoped to the book:
 * a name we don't own or watch is skipped cleanly rather than stored.
 */
async function handleStreetTakeaways(bodyText: string, subject: string): Promise<DispatchResult> {
  if (!bodyText || bodyText.trim().length < 200) {
    return {
      ok: false,
      kind: "street-takeaways",
      status: 400,
      message: "Street Takeaways email had no readable body text (the Apps Script must forward the body, not just attachments).",
    };
  }
  const identifier = extractPrimaryIdentifier(bodyText);
  if (!identifier) {
    return { ok: false, kind: "street-takeaways", status: 400, message: "Couldn't find a FactSet identifier (e.g. 'Primary Identifiers: IBM-US') in the email body." };
  }
  const stocks = await readStocks();
  const bookTickers = stocks
    .filter((s) => s.bucket === "Portfolio" || s.bucket === "Watchlist")
    .map((s) => s.ticker)
    .filter(Boolean);
  const ticker = factsetIdToTicker(identifier, bookTickers);
  if (!ticker) {
    return {
      ok: true,
      kind: "street-takeaways",
      status: 200,
      message: `Skipped ${identifier} — not in the Portfolio or Watchlist.`,
      detail: { identifier, skipped: true },
    };
  }

  const parsed = await parseStreetTakeaway(bodyText, subject);
  const entry: StreetTakeaway = {
    ...parsed,
    id: `st-${ticker.toUpperCase()}-${parsed.date}-${Date.now()}`,
    ticker: ticker.toUpperCase(),
    ingestedAt: new Date().toISOString(),
    subject,
  };
  const { added, count } = await appendStreetTakeaway(entry);
  return {
    ok: true,
    kind: "street-takeaways",
    status: 200,
    message: added
      ? `Street Takeaways filed: ${describeTakeaway(entry)}`
      : `Street Takeaways for ${entry.ticker} (${entry.date}) already on file — skipped duplicate.`,
    detail: { ticker: entry.ticker, added, count, firms: entry.firms.length },
  };
}

// ── Public dispatch result ─────────────────────────────────────────

export type DispatchResult = {
  ok: boolean;
  kind: InboxKind;
  /** One-line summary for the inbox-log + the route response. */
  message: string;
  /** When ok=true and we touched user data, this carries the bookkeeping. */
  detail?: Record<string, unknown>;
  /** HTTP status the route should return. */
  status?: number;
};

// ── Handlers ───────────────────────────────────────────────────────

/**
 * Record one reading per HELD name into pm:sia-history.
 *
 * Held names only: the point of the log is "is one of MY names rolling
 * over?", and logging all 566 universe rows weekly would grow the key without
 * serving that. Failures are swallowed — a monitoring log must never fail an
 * ingest that has already written the scores.
 */
async function logSiaHistory(
  ranked: Array<{ ticker: string; smax?: number; percentile?: number; rank?: number; universeSize?: number }>,
  stocks: Stock[],
  universeMode: boolean,
): Promise<string> {
  try {
    // SAME match rule as applySiaEntries: an index export must use exact
    // ticker identity, or the S&P's Loews (L) is logged as Loblaw (L.TO).
    const matches = universeMode ? tickersEqual : sameCompanyLoose;
    const readings: Record<string, { smax?: number; percentile?: number; rank?: number; universeSize?: number }> = {};
    for (const r of ranked) {
      const held = stocks.find((s) => matches(s.ticker, r.ticker));
      if (!held) continue;
      readings[held.ticker.toUpperCase()] = {
        smax: r.smax,
        percentile: r.percentile,
        rank: r.rank,
        universeSize: r.universeSize,
      };
    }
    const res = await appendSiaHistory(readings);
    return res.appended > 0 ? ` · logged ${res.appended} history readings` : "";
  } catch (e) {
    console.error("[Inbox] sia-history append failed (continuing):", e);
    return "";
  }
}

async function handleSia(att: AttachmentInput, label: string): Promise<DispatchResult> {
  // Routing by content, NOT by MIME label: image/PDF → vision path;
  // ANYTHING ELSE → attempt CSV. We don't trust the MIME type because
  // mail clients tag a .csv inconsistently (text/csv, text/plain,
  // application/vnd.ms-excel, or — very common from Outlook —
  // application/octet-stream). CSV is the preferred path anyway (instant,
  // $0, 100% reliable); if the bytes genuinely aren't a SIA CSV, the
  // parser reports a clear error.
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    const text = decodeBase64DataUrl(att.dataUrl);
    const parsed = parseSiaCsv(text);
    if (parsed.errors.length > 0) {
      return { ok: false, kind: "sia", status: 400, message: `SIA attachment isn't a readable CSV (${parsed.errors.join("; ")}). Expecting a SIA CSV export, a screenshot (PNG/JPG), or a PDF.` };
    }
    const stocks = await readStocks();
    const expected = stocks.filter(isScoreable);
    // A full-index export (S&P 500 / TSX) also feeds the universe snapshot
    // store, which is the ONLY place the non-held rows survive — applySiaEntries
    // drops them by design. Held names keep patching exactly as before.
    // Either big enough to be self-evidently an index, or it says which index
    // it is. The TSX 60 is only the latter.
    const named = isNamedUniverseExport(label);
    // Third form of evidence. An unedited SIA download is called
    // "tableExport-7.csv", so it names no index, and the TSX 60 sits far under
    // the row gate — the two existing tests both miss it and its non-held rows
    // were being discarded in silence. A complete 1..N ranked block is an
    // index cut; a holdings report carries scattered universe ranks instead.
    const completeCut = looksLikeCompleteIndexCut(parsed.ranked.map((r) => r.rank));
    const isUniverse = parsed.rows.length >= UNIVERSE_MIN_ROWS || named || completeCut;
    const { patches, summary } = applySiaEntries(expected, parsed.rows, new Date().toISOString(), stocks, isUniverse);
    const { touched } = await applyPatchesToRedis(patches);
    let snapshotNote = "";
    if (isUniverse) {
      const rows: Record<string, SiaRow> = {};
      for (const r of parsed.ranked) {
        const { ticker, ...rest } = r;
        rows[ticker.toUpperCase()] = rest;
      }
      const snap = await writeSiaSnapshot(rows, { named: named || completeCut });
      snapshotNote = snap.written
        ? ` · universe snapshot ${snap.date} (${snap.tickers} tickers${snap.merged ? ", merged" : ""})`
        : ` · snapshot skipped (${snap.reason})`;
    } else {
      // Say so out loud. These rows are dropped by design, but a silent drop
      // is how a whole index went missing from the suggested watchlist.
      const dropped = summary.rowsParsed - summary.matched;
      if (dropped > 0) snapshotNote = ` · held names only — ${dropped} other rows not stored (not recognised as an index export)`;
    }
    // Log this week's reading for the names the PM holds. Monitoring only —
    // nothing here touches a score. First reading of the day wins, so the
    // holdings exports (which carry SIA's percentile) take precedence over the
    // index exports (which carry rank) when both cover the same name.
    const histNote = await logSiaHistory(parsed.ranked, stocks, isUniverse);
    return {
      ok: true,
      kind: "sia",
      message: `SIA CSV: ${summary.matched} matched / ${summary.rowsParsed} rows · ${summary.updated} updated${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}${snapshotNote}${histNote}.`,
      detail: { label, source: "csv", summary, touched },
    };
  }
  const { entries, cached } = await extractSiaFromAttachments([att]);
  const stocks = await readStocks();
  const expected = stocks.filter(isScoreable);
  // Pass full pm:stocks pool so held ETFs/funds in the screenshot drop
  // out of "unmatched" silently (they don't feed relativeStrength).
  const { patches, summary } = applySiaEntries(expected, entries, new Date().toISOString(), stocks);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "sia",
    message: `SIA${cached ? " (cached)" : ""}: ${summary.matched} matched · ${summary.updated} updated${summary.inScreenshotButUnreadable.length ? ` · ${summary.inScreenshotButUnreadable.length} unreadable` : ""}${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}.`,
    detail: { label, source: "vision", cached, summary, touched },
  };
}

async function handleBoosted(att: AttachmentInput, label: string): Promise<DispatchResult> {
  // Route by content: image/PDF → vision; anything else → CSV (preferred:
  // the Boosted.ai unified-data export is more reliable than a screenshot).
  // MIME is untrusted (mail clients tag a .csv inconsistently).
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    const text = decodeBase64DataUrl(att.dataUrl);
    const parsed = parseBoostedCsv(text);
    if (parsed.errors.length > 0) {
      return { ok: false, kind: "boosted", status: 400, message: `BoostedAI attachment isn't a readable CSV (${parsed.errors.join("; ")}). Expecting the Boosted.ai unified-data CSV export, a screenshot (PNG/JPG), or a PDF.` };
    }
    const stocks = await readStocks();
    const expected = stocks.filter(isScoreable);
    const { patches, summary } = applyBoostedEntries(expected, parsed.rows, new Date().toISOString(), stocks);
    const { touched } = await applyPatchesToRedis(patches);
    return {
      ok: true,
      kind: "boosted",
      message: `BoostedAI CSV: ${summary.matched} matched / ${summary.rowsParsed} rows · ${summary.updated} updated${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}.`,
      detail: { label, source: "csv", summary, touched },
    };
  }
  const { entries, cached } = await extractBoostedFromAttachments([att]);
  const stocks = await readStocks();
  const expected = stocks.filter(isScoreable);
  const { patches, summary } = applyBoostedEntries(expected, entries, new Date().toISOString(), stocks);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "boosted",
    message: `BoostedAI${cached ? " (cached)" : ""}: ${summary.matched} matched · ${summary.updated} updated${summary.inScreenshotButUnreadable.length ? ` · ${summary.inScreenshotButUnreadable.length} unreadable` : ""}${summary.expectedButMissing.length ? ` · ${summary.expectedButMissing.length} expected names missing` : ""}.`,
    detail: { label, source: "vision", cached, summary, touched },
  };
}

async function handleMarketEdge(att: AttachmentInput, label: string): Promise<DispatchResult> {
  // MarketEdge is CSV-only. Attempt to parse regardless of MIME label —
  // mail clients tag a .csv inconsistently (often application/octet-stream
  // from Outlook). If it's an image or other non-CSV, the parser reports a
  // clear "missing Symbol column" error.
  if (isImageDataUrl(att.dataUrl) || isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "marketedge", status: 400, message: "MarketEdge expects the ChartScout Likes CSV export — got an image/PDF instead." };
  }
  const text = decodeBase64DataUrl(att.dataUrl);
  const parsed = parseMarketEdgeCsv(text);
  if (parsed.errors.length > 0) {
    return { ok: false, kind: "marketedge", status: 400, message: `MarketEdge attachment isn't a readable CSV (${parsed.errors.join("; ")}). Expecting the ChartScout Likes CSV export.` };
  }
  const stocks = await readStocks();
  const { patches, summary } = applyMarketEdgeRows(stocks, parsed.rows);
  const { touched } = await applyPatchesToRedis(patches);
  return {
    ok: true,
    kind: "marketedge",
    message: `MarketEdge CSV: ${summary.matched} matched / ${summary.rowsParsed} rows · ${summary.updated} updated.`,
    detail: { label, summary, touched },
  };
}

/**
 * RBC EQUATE rank sheet → pm:equate:{region} (+ the Research list).
 *
 * Stores the parsed rows rather than folding them straight into the CANDIDATE
 * list. The three sheets arrive as separate emails/attachments, and the
 * candidate merge needs to know which sources reported in one pass — merging
 * per-file would make each arrival look like a week where only that source
 * reported, and every other source's names would appear to have fallen off.
 * The weekly refresh reads these stores and merges once.
 *
 * The RESEARCH list is different and IS written here. equateCad / equateUsd
 * are per-source lists with no cross-source pass to wait for, and the merge
 * already carries its own replace/additive safety, so the top decile lands as
 * soon as the sheet does. This replaced a vision parse of the Equate PDF's
 * CORE 40 model portfolio: same two lists, deterministic source, no tokens.
 */
async function handleEquate(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (isImageDataUrl(att.dataUrl) || isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "equate", status: 400, message: "EQUATE expects the .xlsx rank sheet — got an image/PDF instead." };
  }
  try {
    const XLSX = await import("xlsx");
    const b64 = att.dataUrl.includes(",") ? att.dataUrl.split(",")[1] : att.dataUrl;
    const wb = XLSX.read(Buffer.from(b64, "base64"), { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    // Sheet name is the most reliable descriptor ("RBC EQUATE US All Cap");
    // fall back to the filename/subject.
    const sheet = parseEquateRows(rows, `${wb.SheetNames[0]} ${label}`);
    if (sheet.errors.length > 0) {
      return { ok: false, kind: "equate", status: 400, message: `EQUATE sheet unreadable (${sheet.errors.join("; ")}).` };
    }
    const stored = await writeEquateSheet(sheet);

    // ── Research list: the top decile becomes equateCad / equateUsd ──
    // Read-modify-write through the SAME merge the scrape path used, so the
    // rest of pm:research is preserved verbatim and the replace/additive
    // safety threshold still applies. Removals are deliberately NOT logged to
    // the Change Monitor: a name leaving the top decile is ordinary weekly
    // churn (~10% of the list), and the Conviction board already tracks each
    // name's rank directly. Large Cap is a subset of All Cap — it must never
    // overwrite the list.
    let researchSummary: ResearchMergeSummary | undefined;
    if (!sheet.largeCapOnly) {
      try {
        const researchRows = equateResearchRows(sheet);
        const source: ResearchSourceKey = sheet.region === "canada" ? "rbc-equate-cad" : "rbc-equate-usd";
        const state = await readResearch();
        const { nextState, summary } = applyResearchEntries(state, source, researchRows);
        await writeResearch(nextState);
        researchSummary = summary;
      } catch (e) {
        // The ranks are already stored; a research-merge failure must not fail
        // the ingest or lose the sheet.
        console.error("[Inbox] EQUATE research merge failed (ranks still stored):", e);
      }
    }

    const researchLabel = researchSummary
      ? ` · Research list: ${researchSummary.rowsParsed} top-decile names (${researchSummary.matched} held, ${researchSummary.added} new${researchSummary.mode === "additive" ? `, ⚠ additive: ${researchSummary.fallbackReason ?? "same-day re-ingest"}` : ""})`
      : "";
    return {
      ok: true,
      kind: "equate",
      message: `EQUATE ${sheet.region === "canada" ? "Canada" : "US"}${sheet.largeCapOnly ? " Large Cap" : " All Cap"}: ${sheet.rows.length} ranks stored${sheet.largeCapOnly ? " (Large Cap is a subset of All Cap — kept for reference, not scored)" : ""}.${researchLabel}`,
      detail: { label, region: sheet.region, largeCapOnly: sheet.largeCapOnly, rows: sheet.rows.length, stored, research: researchSummary },
    };
  } catch (e) {
    return { ok: false, kind: "equate", status: 400, message: `EQUATE sheet could not be read: ${String(e)}` };
  }
}

async function handleStrategist(att: AttachmentInput, label: string): Promise<DispatchResult> {
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    return { ok: false, kind: "strategist", status: 400, message: "Strategist email expects a PDF or image attachment." };
  }
  const { id } = await addStrategistAttachment(att.dataUrl, label);
  return {
    ok: true,
    kind: "strategist",
    message: `Strategist report stored in the Brief's Analyst / Strategist Reports dropbox (id=${id}).`,
    detail: { label, id },
  };
}

// ── Research list handler (Fundstrat / RBC / Alpha Picks / FEW) ─────

/** Read pm:research, falling back to the default empty state. */
async function readResearch(): Promise<ResearchState> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:research");
    if (!raw) return defaultResearch;
    return JSON.parse(raw) as ResearchState;
  } catch {
    return defaultResearch;
  }
}

/** Read-modify-write helper for pm:research. The dispatcher's research
 *  handler reads the current state, calls applyResearchEntries, and writes
 *  back — so unrelated lists on the blob are preserved verbatim. */
async function writeResearch(state: ResearchState): Promise<void> {
  const redis = await getRedis();
  await redis.set("pm:research", JSON.stringify(state));
}

async function handleResearch(
  source: ResearchSourceKey,
  att: AttachmentInput,
  label: string,
): Promise<DispatchResult> {
  if (!isImageDataUrl(att.dataUrl) && !isPdfDataUrl(att.dataUrl)) {
    return {
      ok: false,
      kind: { kind: "research", source },
      status: 400,
      message: "Research email expects a screenshot (PNG/JPG) or PDF attachment.",
    };
  }
  // The Equate lists are built from the weekly xlsx rank sheets now, so an
  // "Equate CAD / USD" PDF email would clobber a 166-name top-decile list with
  // a 40-name CORE 40 vision read. Refused with a 4xx (not the 5xx the
  // extractResearchEntries backstop would throw) so the Apps Script treats it
  // as a permanent verdict and stops retrying the thread.
  if (source === "rbc-equate-cad" || source === "rbc-equate-usd") {
    return {
      ok: false,
      kind: { kind: "research", source },
      status: 410,
      message: "RBC Equate lists are no longer built from the PDF — they come from the weekly EQUATE xlsx rank sheets (top decile). Forward the 'RBC EQUATE Quantitative Ranks' spreadsheets instead; this PDF was ignored.",
    };
  }
  // Reuse the SAME vision + hash-gated cache the manual /api/research-scrape
  // route uses — re-uploading an unchanged screenshot costs $0.
  const { entries, cached } = await extractResearchEntries(source, [att]);
  const state = await readResearch();
  const { nextState, summary } = applyResearchEntries(state, source, entries);
  await writeResearch(nextState);
  // Record tickers dropped by the replace merge so the Dashboard Change
  // Monitor can surface "dropped from <list>" events. Best-effort.
  if (summary.removedTickers.length > 0) {
    await logResearchRemovals(await getRedis(), summary.removedTickers, source);
  }
  const cachedLabel = cached ? " (cached)" : "";
  const modeLabel = summary.mode === "additive"
    ? (summary.sameDayAccumulate ? " · same-day (accumulated)" : " · ADDITIVE FALLBACK")
    : "";
  const removedLabel = summary.mode === "replace" && summary.removed > 0 ? ` · ${summary.removed} removed` : "";
  const reasonLabel = summary.fallbackReason ? ` ⚠ ${summary.fallbackReason}` : "";
  return {
    ok: true,
    kind: { kind: "research", source },
    message: `${source}${cachedLabel}${modeLabel}: ${summary.matched} matched · ${summary.added} added${removedLabel} / ${summary.rowsParsed} rows.${reasonLabel}`,
    detail: { label, source, cached, summary },
  };
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Dispatch one inbound email attachment to the appropriate handler. Returns
 * a DispatchResult the route uses for both the HTTP response and the
 * pm:inbox-log entry. Returns `kind: "analyst-report"` UNHANDLED so the
 * caller falls through to the existing analyst-report routing logic.
 *
 * The route is responsible for auth + body parsing; this function is pure
 * dispatch given (kind, attachment).
 */
export async function dispatchInbox(args: {
  kind: InboxKind;
  subject: string;
  filename?: string;
  dataUrl: string;
  /** Plain-text email body. Only body-text kinds (street-takeaways) use it;
   *  every other kind is attachment-driven and ignores it. */
  bodyText?: string;
}): Promise<DispatchResult | null> {
  const label = args.filename || args.subject;
  const att: AttachmentInput = { id: "inbox", label, dataUrl: args.dataUrl };
  // Research kinds arrive as an object — handle them first.
  if (typeof args.kind === "object" && args.kind.kind === "research") {
    return await handleResearch(args.kind.source, att, label);
  }
  switch (args.kind) {
    case "sia":          return await handleSia(att, label);
    case "boosted":      return await handleBoosted(att, label);
    case "marketedge":   return await handleMarketEdge(att, label);
    case "equate":       return await handleEquate(att, label);
    case "strategist":   return await handleStrategist(att, label);
    case "street-takeaways": return await handleStreetTakeaways(args.bodyText ?? "", args.subject);
    case "newton-note":  return await handleStrategistNote("newton", args.bodyText ?? "", args.subject);
    case "lee-note":     return await handleStrategistNote("lee", args.bodyText ?? "", args.subject);
    case "analyst-report": return null;  // existing flow handles this
    case "unknown":      return null;    // existing route returns its "couldn't determine source" error
  }
  // TS-exhaustiveness fallback (the ResearchKind branch was handled above).
  return null;
}
