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
import { resolveFactsetId } from "@/app/lib/factset-symbols";
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
};

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
    (s) => s?.ticker && (s.bucket === "Portfolio" || s.bucket === "Watchlist"),
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
  });
  return { hash, mentions };
}

// ───────────────────────── GET ─────────────────────────

export async function GET() {
  try {
    const [stocks, snapshots, reports, cache, leadership, takeawayStore] = await Promise.all([
      loadBookStocks(),
      readJson<AnalystSnapshots>("pm:analyst-snapshots", {}),
      readJson<AnalystReports>("pm:analyst-reports", {}),
      readJson<SynthesisScreenCache>(SYNTHESIS_CACHE_KEY, {}),
      getSectorLeadership(),
      loadStreetTakeaways(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = await Promise.all(
      stocks.map(async (s) => {
        const ticker = canonicalTicker(s.ticker!);
        const entry = cache[ticker];
        let stale: StaleReason[];
        try {
          const { hash } = await cheapInputsHashFor(ticker, s, snapshots, reports, takeawayStore);
          stale = evaluateStaleness(entry, hash, s.currentPrice, today);
        } catch (e) {
          log.warn(`staleness check failed for ${ticker}:`, e);
          stale = entry ? [] : ["never-generated"];
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

async function fetchTechnicals(ticker: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => typeof c === "number" && isFinite(c),
    );
    return computeTechnicalsFromCloses(closes);
  } catch (e) {
    log.warn(`technicals fetch failed for ${ticker}:`, e);
    return null;
  }
}

async function factsetBlockFor(ticker: string): Promise<string> {
  try {
    const resolution = resolveFactsetId(ticker);
    if (resolution.source !== "factset") {
      return `=== FACTSET FUNDAMENTALS ===\nDATA GAP — not resolvable in FactSet (${resolution.reason}).`;
    }
    const snap = await companySnapshot(resolution.id);
    return formatSnapshotForPrompt(snap);
  } catch (e) {
    log.warn(`FactSet snapshot failed for ${ticker}:`, e);
    return "=== FACTSET FUNDAMENTALS ===\nDATA GAP — FactSet fetch failed for this run.";
  }
}

export async function POST(request: NextRequest) {
  let body: { tickers?: unknown; force?: unknown; webFill?: unknown };
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

  const [stocks, snapshots, reports, leadership, takeawayStore] = await Promise.all([
    loadBookStocks(),
    readJson<AnalystSnapshots>("pm:analyst-snapshots", {}),
    readJson<AnalystReports>("pm:analyst-reports", {}),
    getSectorLeadership(),
    loadStreetTakeaways(),
  ]);
  const byTicker = new Map(stocks.map((s) => [canonicalTicker(s.ticker!), s]));
  const today = new Date().toISOString().slice(0, 10);

  const results: Array<{ ticker: string; status: "generated" | "cached" | "error"; entry?: SynthesisEntry; error?: string }> = [];

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

      const [factsetBlock, technicals] = await Promise.all([
        factsetBlockFor(ticker),
        fetchTechnicals(stock.ticker!),
      ]);
      const takeaways = takeawaysFor(takeawayStore, ticker);

      const payload: SynthesisPayload = {
        ticker,
        name: stock.name ?? ticker,
        bucket: stock.bucket as "Portfolio" | "Watchlist",
        sector: stock.sector ?? "",
        currentPrice: stock.currentPrice,
        earningsDate: stock.earningsDate,
        factsetBlock,
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
      };

      const { system, user } = buildSynthesisPrompt(payload);
      type WebSearchTool = { type: "web_search_20250305"; name: "web_search"; max_uses?: number };
      const tools: WebSearchTool[] = webFill ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] : [];

      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 3000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        tools,
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
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
        priceAtGeneration: stock.currentPrice,
        earningsDateAtGeneration: stock.earningsDate,
        webFillUsed: webFill,
        targets: computeTargets(payload.snapshot, stock.currentPrice),
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
          price: stock.currentPrice,
        };
        const prior = Array.isArray(history[ticker]) ? history[ticker] : [];
        const next = [...prior.filter((r) => r.date !== today), row];
        await redis.set(SYNTHESIS_HISTORY_KEY, JSON.stringify({ ...history, [ticker]: next }));
      }

      results.push({ ticker, status: "generated", entry });
    } catch (e) {
      log.error(`generation failed for ${ticker}:`, e);
      results.push({ ticker, status: "error", error: e instanceof Error ? e.message : "unknown error" });
    }
  }

  return NextResponse.json({ results });
}
