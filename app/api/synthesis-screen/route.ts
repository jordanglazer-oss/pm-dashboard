import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { parseModelJson } from "@/app/lib/json-repair";
import { canonicalTicker } from "@/app/lib/ticker";
import { tallyResearchMentions } from "@/app/lib/research-mentions";
import { loadStreetTakeaways, type StreetTakeaway, type StreetTakeawaysStore } from "@/app/lib/street-takeaways";
import {
  getSnapshotForTicker,
  getReportsForTicker,
  type AnalystSnapshots,
  type AnalystReports,
} from "@/app/lib/analyst-snapshots";
import { resolveFactsetId, isFundservCode } from "@/app/lib/factset-symbols";
import { crossSectional, factsetConfigured, relayRetry, RELAY_HEAVY_TIMEOUT_MS } from "@/app/lib/factset";
import { companySnapshot, formatSnapshotForPrompt } from "@/app/lib/factset-fundamentals";
import { getSectorLeadership } from "@/app/lib/sector-leadership";
import {
  SYNTHESIS_CACHE_KEY,
  SYNTHESIS_HISTORY_KEY,
  SYNTHESIS_PROMPT_VERSION,
  computeInputsHash,
  evaluateStaleness,
  computeTechnicalsFromCloses,
  computeTargets,
  buildSynthesisPrompt,
  normalizeSynthesisResult,
  type SynthesisScreenCache,
  type SynthesisEntry,
  type SynthesisHistory,
  type SynthesisHistoryRow,
  type StaleReason,
  type SynthesisPayload,
  type ThirdPartyTech,
  type Technicals,
} from "@/app/lib/synthesis-screen";

/**
 * Synthesis screen API.
 *
 * GET  — returns one row per Portfolio/Watchlist name: the cached synthesis
 *        (if any) plus computed staleness reasons, and the sector-leadership
 *        table for the page header. Staleness is computed from Redis-only
 *        inputs (no Yahoo/FactSet calls) so the page load stays fast.
 * POST — { tickers: string[], force?: boolean, webFill?: boolean } generates
 *        syntheses (max 5 per call; the client chunks larger refreshes).
 *        Hash-gated: an up-to-date entry is returned from cache unless
 *        force=true.
 *
 * Redis safety:
 *   READS pm:stocks, pm:analyst-snapshots, pm:analyst-reports,
 *   pm:street-takeaways, pm:research (via tallyResearchMentions) — all
 *   read-only here.
 *   WRITES only pm:synthesis-screen-cache (read-modify-write, per-ticker
 *   entry spread over the existing blob) and pm:synthesis-history
 *   (read-modify-write, append-only per (ticker, day) — a same-day
 *   regeneration replaces that day's row, prior days are never touched).
 */

const log = createLogger("Synthesis");
const client = new Anthropic();

export const maxDuration = 300;

type StockLike = {
  ticker?: string;
  name?: string;
  bucket?: string;
  sector?: string;
  currentPrice?: number;
  earningsDate?: string;
  instrumentType?: string;
  marketEdge?: {
    opinion?: "long" | "neutral" | "avoid";
    opinionScore?: number;
    powerRating?: number;
    opinionDate?: string;
  };
  boostedAi?: number;
  boostedAiConsensus?: string;
  boostedLastReadAt?: string;
  sia?: number;
  siaLastReadAt?: string;
};

/** Raw third-party technical opinions off the stock row (never the 41-pt score). */
function thirdPartyTechFor(s: StockLike): ThirdPartyTech | undefined {
  const hasMe = !!s.marketEdge && (s.marketEdge.opinion != null || s.marketEdge.powerRating != null);
  if (!hasMe && s.boostedAi == null && s.sia == null) return undefined;
  return {
    marketEdge: hasMe ? s.marketEdge : undefined,
    boostedAi: s.boostedAi,
    boostedAiConsensus: s.boostedAiConsensus,
    boostedAsOf: s.boostedLastReadAt,
    sia: s.sia,
    siaAsOf: s.siaLastReadAt,
  };
}

/** Output budget for one synthesis.
 *
 *  Sonnet 5 runs ADAPTIVE thinking by default — omitting the `thinking`
 *  parameter does NOT disable it — and thinking tokens come out of
 *  `max_tokens`. At the previous 3000, a long deliberation on a dense name
 *  could consume the whole budget and return a message containing only a
 *  thinking block and NO text block. That reached the user as
 *  "model output unparseable: no JSON object in response" (parseModelJson's
 *  empty-input branch). 16000 leaves ample room for both, and stays under the
 *  SDK's non-streaming HTTP timeout. */
const SYNTHESIS_MAX_TOKENS = 16000;

type SynthesisTools = Array<{ type: "web_search_20250305"; name: "web_search"; max_uses?: number }>;

/** One synthesis generation.
 *
 *  Two failure modes are handled here, both of which previously surfaced as an
 *  unparseable-output error:
 *    - `pause_turn` — the server-side web-search loop hit its iteration cap.
 *      Resume by re-sending the paused assistant turn (no extra user message).
 *    - no text block at all — retry once with thinking off so the entire
 *      budget goes to the JSON.
 *  Returns "" only when both attempts produced nothing; the caller reports it. */
async function callSynthesisModel(
  ticker: string,
  system: string,
  user: string,
  tools: SynthesisTools,
): Promise<string> {
  const attempt = async (thinkingOff: boolean): Promise<string> => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    for (let i = 0; i < 4; i++) {
      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: SYNTHESIS_MAX_TOKENS,
        ...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        tools,
      });
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (!text.trim()) {
        log.warn(
          `${ticker}: empty response (stop_reason=${response.stop_reason}, blocks=[${response.content
            .map((b) => b.type)
            .join(",")}], output_tokens=${response.usage.output_tokens}, thinkingOff=${thinkingOff})`,
        );
      }
      return text;
    }
    log.warn(`${ticker}: pause_turn continuation cap reached`);
    return "";
  };

  const first = await attempt(false);
  if (first.trim()) return first;
  return attempt(true);
}

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    log.warn(`read failed for ${key}:`, e);
    return fallback;
  }
}

async function loadBookStocks(): Promise<StockLike[]> {
  const stocks = await readJson<StockLike[]>("pm:stocks", []);
  return (Array.isArray(stocks) ? stocks : []).filter(
    (s) =>
      s?.ticker &&
      (s.bucket === "Portfolio" || s.bucket === "Watchlist") &&
      // Individual equities only — ETFs and funds are excluded from the
      // synthesis screen (2026-08-26 decision). Unset instrumentType is
      // treated as a stock (same convention as the beta persistence rule),
      // except FUNDSERV codes which are always mutual funds.
      s.instrumentType !== "etf" &&
      s.instrumentType !== "mutual-fund" &&
      !isFundservCode(s.ticker),
  );
}

/** Membership-only fingerprint — changes when a name joins/leaves a list. */
function mentionsFingerprint(mentions: Awaited<ReturnType<typeof tallyResearchMentions>> | null): string {
  if (!mentions) return "none";
  return mentions.mentions
    .map((m) => `${m.source}|${m.direction}`)
    .sort()
    .join(",");
}

function takeawaysFor(store: StreetTakeawaysStore, ticker: string): StreetTakeaway[] {
  return store[canonicalTicker(ticker).toUpperCase()] ?? [];
}

async function cheapInputsHashFor(
  ticker: string,
  stock: StockLike,
  snapshots: AnalystSnapshots,
  reports: AnalystReports,
  takeawayStore: StreetTakeawaysStore,
): Promise<{ hash: string; mentions: Awaited<ReturnType<typeof tallyResearchMentions>> }> {
  const mentions = await tallyResearchMentions(ticker);
  const takeaways = takeawaysFor(takeawayStore, ticker);
  const rep = getReportsForTicker(reports, ticker);
  const hash = computeInputsHash({
    snapshot: getSnapshotForTicker(snapshots, ticker),
    reports: {
      rbc: rep?.rbc ? { extractedAt: rep.rbc.extractedAt, hash: rep.rbc.hash } : undefined,
      jpm: rep?.jpm ? { extractedAt: rep.jpm.extractedAt, hash: rep.jpm.hash } : undefined,
      morningstar: rep?.morningstar ? { extractedAt: rep.morningstar.extractedAt, hash: rep.morningstar.hash } : undefined,
    },
    takeaways: takeaways.map((t) => ({ date: t.date, event: t.event })),
    mentionsFingerprint: mentionsFingerprint(mentions),
    earningsDate: stock.earningsDate,
    thirdPartyTech: thirdPartyTechFor(stock),
  });
  return { hash, mentions };
}

// ── Business profile (FactSet FF_BUS_DESC_EXT, Yahoo fallback) ────────
// FactSet's extended business description names the operating segments and
// what sits in each (probe-confirmed Aug 2026), so it is the PRIMARY source;
// Yahoo assetProfile.longBusinessSummary is the fallback for names FactSet
// can't resolve. Near-static text, so cached in pm:business-profile-cache
// (nukeable, matches the `-cache$` backup exclude) with a 30-day lazy
// refresh. Fetched only at generation time — never on GET.

const BUSINESS_CACHE_KEY = "pm:business-profile-cache";
const BUSINESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type BusinessProfileCache = Record<string, { summary: string; fetchedAt: string; source?: string }>;

async function writeBusinessCache(key: string, summary: string, source: string): Promise<void> {
  // Read-modify-write: re-read so concurrent generations of other tickers
  // aren't clobbered, spread, write back.
  const redis = await getRedis();
  const fresh = await readJson<BusinessProfileCache>(BUSINESS_CACHE_KEY, {});
  await redis.set(
    BUSINESS_CACHE_KEY,
    JSON.stringify({ ...fresh, [key]: { summary, fetchedAt: new Date().toISOString(), source } }),
  );
}

async function fetchBusinessSummary(ticker: string): Promise<string | undefined> {
  const key = canonicalTicker(ticker);
  const cache = await readJson<BusinessProfileCache>(BUSINESS_CACHE_KEY, {});
  const hit = cache[key];
  if (hit?.summary && Date.now() - new Date(hit.fetchedAt).getTime() < BUSINESS_MAX_AGE_MS) {
    return hit.summary;
  }

  // Primary: FactSet extended business description.
  if (factsetConfigured()) {
    try {
      const resolution = resolveFactsetId(ticker);
      if (resolution.source === "factset") {
        const data = await crossSectional([resolution.id], ["FF_BUS_DESC_EXT"]);
        const desc = data[resolution.id]?.["FF_BUS_DESC_EXT"];
        if (typeof desc === "string" && desc.trim().length > 40) {
          await writeBusinessCache(key, desc.trim(), "factset");
          return desc.trim();
        }
      }
    } catch (e) {
      log.warn(`FactSet business description failed for ${ticker}:`, e);
    }
  }

  try {
    // Yahoo quoteSummary needs the cookie+crumb dance (same pattern as
    // refresh-data). On any failure fall back to the stale cache entry.
    const cookieRes = await fetch("https://fc.yahoo.com", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const cookie = cookieRes.headers.get("set-cookie") || "";
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
    });
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("error")) return hit?.summary;
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(toYahoo(ticker))}?modules=assetProfile&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie } });
    if (!res.ok) return hit?.summary;
    const data = (await res.json()) as {
      quoteSummary?: { result?: Array<{ assetProfile?: { longBusinessSummary?: string } }> };
    };
    const summary = data?.quoteSummary?.result?.[0]?.assetProfile?.longBusinessSummary;
    if (!summary) return hit?.summary;
    await writeBusinessCache(key, summary, "yahoo");
    return summary;
  } catch (e) {
    log.warn(`business summary fetch failed for ${ticker}:`, e);
    return hit?.summary;
  }
}

// ───────────────────────── GET ─────────────────────────

export async function GET() {
  try {
    const [stocks, snapshots, reports, cache, leadership, takeawayStore, history] = await Promise.all([
      loadBookStocks(),
      readJson<AnalystSnapshots>("pm:analyst-snapshots", {}),
      readJson<AnalystReports>("pm:analyst-reports", {}),
      readJson<SynthesisScreenCache>(SYNTHESIS_CACHE_KEY, {}),
      getSectorLeadership(),
      loadStreetTakeaways(),
      readJson<SynthesisHistory>(SYNTHESIS_HISTORY_KEY, {}),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = await Promise.all(
      stocks.map(async (s) => {
        const ticker = canonicalTicker(s.ticker!);
        const entry = cache[ticker];
        let stale: StaleReason[];
        let mentionCount = 0;
        try {
          const { hash, mentions } = await cheapInputsHashFor(ticker, s, snapshots, reports, takeawayStore);
          mentionCount = mentions.mentions.length;
          stale = evaluateStaleness(entry, hash, s.currentPrice, today);
        } catch (e) {
          log.warn(`staleness check failed for ${ticker}:`, e);
          stale = entry ? [] : ["never-generated"];
        }

        // Evidence-coverage summary for the pre-generation icons. "Reports"
        // means an uploaded PDF extract (what the PM cares about most) —
        // a snapshot target entered by hand still counts for targets but
        // not as a report.
        const rep = getReportsForTicker(reports, ticker);
        const snap = getSnapshotForTicker(snapshots, ticker);
        const tech = thirdPartyTechFor(s);
        const evidence = {
          rbcReport: !!rep?.rbc,
          jpmReport: !!rep?.jpm,
          morningstarReport: !!rep?.morningstar,
          streetConsensus: snap?.factset?.averageTarget != null,
          takeaways: takeawaysFor(takeawayStore, ticker).length,
          mentions: mentionCount,
          marketEdge: !!tech?.marketEdge,
          boosted: tech?.boostedAi != null || !!tech?.boostedAiConsensus,
          sia: tech?.sia != null,
        };

        // Previous different-day verdict for the change marker: the latest
        // history row strictly before the current entry's generation day.
        let previous: SynthesisHistoryRow | null = null;
        if (entry) {
          const entryDay = entry.generatedAt.slice(0, 10);
          const rowsFor = Array.isArray(history[ticker]) ? history[ticker] : [];
          const prior = rowsFor.filter((r) => r.date < entryDay).sort((a, b) => a.date.localeCompare(b.date));
          previous = prior.length > 0 ? prior[prior.length - 1] : null;
        }

        return {
          ticker,
          displayTicker: s.ticker,
          name: s.name ?? ticker,
          bucket: s.bucket as "Portfolio" | "Watchlist",
          sector: s.sector ?? "",
          currentPrice: s.currentPrice,
          earningsDate: s.earningsDate,
          entry: entry ?? null,
          stale,
          evidence,
          previous,
        };
      }),
    );

    return NextResponse.json({ rows, leadership });
  } catch (e) {
    log.error("GET failed:", e);
    return NextResponse.json({ error: "synthesis screen load failed" }, { status: 500 });
  }
}

// ───────────────────────── POST ─────────────────────────

/** Yahoo daily closes for this name -> technicals AND the live quote.
 *
 *  The quote comes from the SAME chart response the technicals already need
 *  (`meta.regularMarketPrice ?? meta.previousClose`) — byte-for-byte what
 *  /api/prices uses, so the synthesis price matches the rest of the site and
 *  carries no extra fetch and no FactSet dependency. */
async function fetchTechnicals(ticker: string): Promise<{ technicals: Technicals | null; marketPrice?: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { technicals: null };
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; previousClose?: number };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = data?.chart?.result?.[0];
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => typeof c === "number" && isFinite(c),
    );
    const meta = result?.meta;
    const quote = meta?.regularMarketPrice ?? meta?.previousClose;
    return {
      technicals: computeTechnicalsFromCloses(closes),
      marketPrice: typeof quote === "number" && isFinite(quote) && quote > 0 ? quote : undefined,
    };
  } catch (e) {
    log.warn(`technicals fetch failed for ${ticker}:`, e);
    return { technicals: null };
  }
}

/** FactSet fundamentals for one name.
 *
 *  `ok: false` means the block is genuinely absent and the caller must gate on
 *  it — a synthesis built without fundamentals reads as authoritative while
 *  having had no financials at all (observed: AVGO 2026-08-29, where a single
 *  7s relay abort produced a full-looking card with an empty FactSet block).
 *  Retries first, and at the heavy timeout, so the gate rarely trips: the
 *  55-formula snapshot is the largest FactSet call in the app. */
async function factsetBlockFor(ticker: string): Promise<{ ok: boolean; block: string; reason?: string }> {
  const resolution = resolveFactsetId(ticker);
  if (resolution.source !== "factset") {
    // Not a failure: funds / dual listings are deliberately off FactSet, and
    // gating on them would make those names permanently un-generatable.
    return {
      ok: true,
      block: `=== FACTSET FUNDAMENTALS ===\nDATA GAP — not resolvable in FactSet (${resolution.reason}).`,
    };
  }
  try {
    // 2 attempts, not the default 3: the gate runs per ticker inside a batch
    // of up to 5, and 3 x 15s of retries per name would risk the route's 300s
    // budget when the relay is genuinely down — exactly when we want to fail
    // fast and gate rather than time the whole batch out.
    const snap = await relayRetry(
      () => companySnapshot(resolution.id, { timeoutMs: RELAY_HEAVY_TIMEOUT_MS }),
      2,
    );
    if (!snap.hasData) {
      return { ok: false, block: "", reason: `FactSet returned no financials for ${resolution.id}` };
    }
    return { ok: true, block: formatSnapshotForPrompt(snap) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`FactSet snapshot failed for ${ticker} (${resolution.id}) after retries:`, msg);
    return { ok: false, block: "", reason: `FactSet fundamentals unavailable — ${msg}` };
  }
}

export async function POST(request: NextRequest) {
  let body: { tickers?: unknown; force?: unknown; webFill?: unknown; allowIncomplete?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const requested = Array.isArray(body.tickers) ? body.tickers.map((t) => canonicalTicker(String(t))) : [];
  if (requested.length === 0) return NextResponse.json({ error: "tickers[] required" }, { status: 400 });
  if (requested.length > 5) return NextResponse.json({ error: "max 5 tickers per call — chunk the request" }, { status: 400 });
  const force = body.force === true;
  const webFill = body.webFill === true;
  // Explicit, per-click override for the completeness gate below. Never
  // defaults on — the caller has to ask for a knowingly-partial read, and the
  // entry it produces is permanently badged `incomplete`.
  const allowIncomplete = body.allowIncomplete === true;

  const [stocks, snapshots, reports, leadership, takeawayStore] = await Promise.all([
    loadBookStocks(),
    readJson<AnalystSnapshots>("pm:analyst-snapshots", {}),
    readJson<AnalystReports>("pm:analyst-reports", {}),
    getSectorLeadership(),
    loadStreetTakeaways(),
  ]);
  const byTicker = new Map(stocks.map((s) => [canonicalTicker(s.ticker!), s]));
  const today = new Date().toISOString().slice(0, 10);

  const results: Array<{
    ticker: string;
    status: "generated" | "cached" | "error" | "incomplete";
    entry?: SynthesisEntry;
    error?: string;
    /** Required inputs that were unavailable this run (status "incomplete", or
     *  present on a "generated" row when the override was used). */
    missing?: string[];
  }> = [];

  for (const ticker of requested) {
    const stock = byTicker.get(ticker);
    if (!stock) {
      results.push({ ticker, status: "error", error: "not in Portfolio/Watchlist" });
      continue;
    }
    try {
      const { hash, mentions } = await cheapInputsHashFor(ticker, stock, snapshots, reports, takeawayStore);

      // Hash gate: skip the Anthropic spend when nothing changed.
      if (!force) {
        const cache = await readJson<SynthesisScreenCache>(SYNTHESIS_CACHE_KEY, {});
        const existing = cache[ticker];
        const stale = evaluateStaleness(existing, hash, stock.currentPrice, today);
        if (existing && stale.length === 0) {
          results.push({ ticker, status: "cached", entry: existing });
          continue;
        }
      }

      const [factset, yahoo, businessSummary] = await Promise.all([
        factsetBlockFor(ticker),
        fetchTechnicals(stock.ticker!),
        fetchBusinessSummary(stock.ticker!),
      ]);
      const technicals = yahoo.technicals;
      const takeaways = takeawaysFor(takeawayStore, ticker);

      // Price: Yahoo first (same source and same precedence as /api/prices),
      // then the stored pm:stocks value, then the last daily close. FactSet is
      // deliberately NOT a price source here — it isn't one anywhere else on
      // the site, and keeping it out means a relay hiccup can't blank the
      // price the way it blanked AVGO's on 2026-08-29.
      const currentPrice = yahoo.marketPrice ?? stock.currentPrice ?? technicals?.last;

      // ── Completeness gate ───────────────────────────────────────────────
      // A synthesis missing a REQUIRED input still reads as authoritative, so
      // it is not generated at all: no Anthropic spend, no cache write, no
      // history row. The caller gets the specific reasons and a retry. Inputs
      // that legitimately vary by name (RBC/JPM/Morningstar extracts, street
      // takeaways, research mentions, vendor technicals) are NOT gated — the
      // header coverage chips already show those, and gating on them would
      // make most names permanently un-generatable.
      const missing: string[] = [];
      if (!factset.ok) missing.push(factset.reason ?? "FactSet fundamentals unavailable");
      if (currentPrice == null) missing.push("Live price unavailable (Yahoo quote + stored price both empty)");
      if (!technicals) missing.push("Price history unavailable — no technicals or sector-relative read");
      if (missing.length > 0 && !allowIncomplete) {
        log.warn(`${ticker}: gated, required inputs missing — ${missing.join("; ")}`);
        results.push({ ticker, status: "incomplete", missing });
        continue;
      }

      const payload: SynthesisPayload = {
        ticker,
        name: stock.name ?? ticker,
        bucket: stock.bucket as "Portfolio" | "Watchlist",
        sector: stock.sector ?? "",
        currentPrice,
        earningsDate: stock.earningsDate,
        factsetBlock: factset.ok
          ? factset.block
          : `=== FACTSET FUNDAMENTALS ===\nDATA GAP — ${factset.reason ?? "unavailable"}.`,
        snapshot: getSnapshotForTicker(snapshots, ticker),
        reports: (() => {
          const rep = getReportsForTicker(reports, ticker);
          return {
            rbc: rep?.rbc?.extracted,
            jpm: rep?.jpm?.extracted,
            morningstar: rep?.morningstar?.extracted,
          };
        })(),
        takeaways,
        mentions,
        technicals,
        leadership,
        thirdPartyTech: thirdPartyTechFor(stock),
        businessSummary,
      };

      const { system, user } = buildSynthesisPrompt(payload);
      const tools: SynthesisTools = webFill ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] : [];

      const text = await callSynthesisModel(ticker, system, user, tools);
      const parsed = parseModelJson<Record<string, unknown>>(text);
      if (!parsed.ok) {
        results.push({ ticker, status: "error", error: `model output unparseable: ${parsed.error}` });
        continue;
      }
      const result = normalizeSynthesisResult(parsed.value, payload.bucket);
      if (!result) {
        results.push({ ticker, status: "error", error: "model output failed validation" });
        continue;
      }

      const entry: SynthesisEntry = {
        ticker,
        bucket: payload.bucket,
        generatedAt: new Date().toISOString(),
        promptVersion: SYNTHESIS_PROMPT_VERSION,
        inputsHash: hash,
        priceAtGeneration: currentPrice,
        earningsDateAtGeneration: stock.earningsDate,
        webFillUsed: webFill,
        // Only set when the override was used — a normal run is gated above,
        // so a present `incomplete` always means "knowingly generated partial".
        incomplete: missing.length > 0 ? missing : undefined,
        targets: computeTargets(payload.snapshot, currentPrice),
        result,
      };

      // Read-modify-write the cache: re-read right before writing and spread,
      // so concurrent generations of OTHER tickers aren't clobbered.
      {
        const redis = await getRedis();
        const cache = await readJson<SynthesisScreenCache>(SYNTHESIS_CACHE_KEY, {});
        await redis.set(SYNTHESIS_CACHE_KEY, JSON.stringify({ ...cache, [ticker]: entry }));
      }

      // Append-only history: one row per (ticker, day). Writes are always
      // stamped with TODAY (server UTC) by construction; a same-day
      // regeneration replaces today's row, prior days are never modified.
      {
        const redis = await getRedis();
        const history = await readJson<SynthesisHistory>(SYNTHESIS_HISTORY_KEY, {});
        const row: SynthesisHistoryRow = {
          date: today,
          generatedAt: entry.generatedAt,
          bucket: entry.bucket,
          verdict: result.verdict,
          skew: result.skew,
          price: currentPrice,
        };
        const prior = Array.isArray(history[ticker]) ? history[ticker] : [];
        const next = [...prior.filter((r) => r.date !== today), row];
        await redis.set(SYNTHESIS_HISTORY_KEY, JSON.stringify({ ...history, [ticker]: next }));
      }

      results.push({ ticker, status: "generated", entry, missing: missing.length > 0 ? missing : undefined });
    } catch (e) {
      log.error(`generation failed for ${ticker}:`, e);
      results.push({ ticker, status: "error", error: e instanceof Error ? e.message : "unknown error" });
    }
  }

  return NextResponse.json({ results });
}
