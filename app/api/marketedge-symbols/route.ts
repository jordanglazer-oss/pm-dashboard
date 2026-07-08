import { NextRequest, NextResponse } from "next/server";
import { crossSectional, factsetConfigured } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { canonicalTicker } from "@/app/lib/ticker";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * POST { tickers: string[] } → { symbols: string[], source } — the US symbol
 * list for a MarketEdge (ChartScout) matrix. MarketEdge is US-only:
 *
 *   - Bare (US) tickers pass through as-is.
 *   - Canadian listings (".TO"/".V"/".NE"/".CN"/legacy "-T") are INCLUDED only
 *     when they're genuinely interlisted — i.e. the same company also trades in
 *     the US. We can't infer that from the ticker alone (a stripped Canadian
 *     root can collide with an unrelated US ticker, e.g. AC.TO=Air Canada vs
 *     US AC=Associated Capital), so we verify against FactSet: the US listing
 *     of the stripped root must exist (live P_PRICE) AND its company name must
 *     match the Canadian listing's company name.
 *
 * Results are cached in `pm:interlisting-cache` (canonical CA ticker → { us,
 * checkedAt }) for INTERLISTING_TTL_DAYS so repeat exports don't re-spend
 * FactSet calls — interlisting status is very stable. Pure cache: safe to nuke.
 *
 * Degrades gracefully: if FactSet isn't configured or errors, US names still
 * return, plus any interlistings already in cache.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const log = createLogger("MarketEdge-symbols");

const CACHE_KEY = "pm:interlisting-cache";
const INTERLISTING_TTL_DAYS = 30;
const CA_SUFFIX = /\.(TO|V|NE|CN)$/;

type CacheEntry = { us: string | null; checkedAt: string };
type Cache = Record<string, CacheEntry>;

/** Normalize a company name for same-entity comparison: uppercase, drop
 *  punctuation + common corporate suffixes/qualifiers, collapse whitespace. */
function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,'"()/\-]/g, " ")
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LLP|LP|HOLDINGS|HOLDING|GROUP|CLASS|CL|SERIES|COMMON|SHARES|SHARE|THE|SA|AG|NV|SE|TRUST|REIT|UN|UNITS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two company names refer to the same entity (exact after
 *  normalization, or one is a clear prefix/containment of the other). */
function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function isCanadian(ticker: string): boolean {
  return CA_SUFFIX.test(canonicalTicker(ticker));
}

function freshEnough(iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < INTERLISTING_TTL_DAYS * 86400000;
}

export async function POST(req: NextRequest) {
  let tickers: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    tickers = Array.isArray(body?.tickers)
      ? [...new Set((body.tickers as unknown[]).map((t) => canonicalTicker(String(t || ""))).filter(Boolean))]
      : [];
  } catch {
    tickers = [];
  }

  // US names go straight in; Canadian names need interlisting verification.
  const usDirect: string[] = [];
  const caTickers: string[] = [];
  for (const t of tickers) {
    if (isCanadian(t)) caTickers.push(t);
    else usDirect.push(t);
  }

  const verified: string[] = [];

  if (caTickers.length > 0) {
    // Load cache; reuse fresh entries, only FactSet-check the rest.
    let cache: Cache = {};
    try {
      const raw = await getRedis().then((r) => r.get(CACHE_KEY));
      if (raw) cache = JSON.parse(raw) as Cache;
    } catch {
      cache = {};
    }

    const toCheck: string[] = [];
    for (const ca of caTickers) {
      const hit = cache[ca];
      if (hit && freshEnough(hit.checkedAt)) {
        if (hit.us) verified.push(hit.us);
      } else {
        toCheck.push(ca);
      }
    }

    if (toCheck.length > 0 && factsetConfigured()) {
      try {
        // For each CA ticker, resolve its US-root id and its own CA id, then
        // pull company name (+ price to confirm the US listing is active) for
        // all of them in one batched cross-sectional call.
        const usIdByCa = new Map<string, string>();
        const caIdByCa = new Map<string, string>();
        const usRootByCa = new Map<string, string>();
        const idSet = new Set<string>();
        for (const ca of toCheck) {
          const root = canonicalTicker(ca).replace(CA_SUFFIX, "");
          const usRes = resolveFactsetId(root); // bare → "<root>-US"
          const caRes = resolveFactsetId(ca); // ".TO" → "<root>-CA"
          if (usRes.source === "factset") { usIdByCa.set(ca, usRes.id); idSet.add(usRes.id); usRootByCa.set(ca, root); }
          if (caRes.source === "factset") { caIdByCa.set(ca, caRes.id); idSet.add(caRes.id); }
        }

        const data = idSet.size > 0
          ? await crossSectional([...idSet], ["P_PRICE", "FG_COMPANY_NAME"])
          : {};

        const now = new Date().toISOString();
        for (const ca of toCheck) {
          const usId = usIdByCa.get(ca);
          const caId = caIdByCa.get(ca);
          const usRow = usId ? data[usId] : undefined;
          const caRow = caId ? data[caId] : undefined;
          const usPrice = typeof usRow?.["P_PRICE"] === "number" ? (usRow["P_PRICE"] as number) : null;
          const usName = typeof usRow?.["FG_COMPANY_NAME"] === "string" ? (usRow["FG_COMPANY_NAME"] as string) : null;
          const caName = typeof caRow?.["FG_COMPANY_NAME"] === "string" ? (caRow["FG_COMPANY_NAME"] as string) : null;

          // Interlisted ⇔ the US root is a live listing of the SAME company.
          const isInterlisted = usPrice != null && usPrice > 0 && sameCompany(usName, caName);
          const us = isInterlisted ? (usRootByCa.get(ca) as string) : null;
          cache[ca] = { us, checkedAt: now };
          if (us) verified.push(us);
        }

        // Merge-write the cache (never drops other tickers' entries).
        try {
          await getRedis().then((r) => r.set(CACHE_KEY, JSON.stringify(cache)));
        } catch (e) {
          log.warn("cache write failed:", e instanceof Error ? e.message : e);
        }
      } catch (e) {
        log.error("FactSet verification failed:", e instanceof Error ? e.message : e);
        // Fall through: US names + any cached interlistings still return.
      }
    } else if (toCheck.length > 0) {
      log.info("FactSet not configured — skipping interlisting check for", toCheck.length, "CA names");
    }
  }

  // Combine, dedupe, preserve US-first order.
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const s of [...usDirect, ...verified]) {
    if (s && !seen.has(s)) { seen.add(s); symbols.push(s); }
  }

  return NextResponse.json({ symbols, source: "factset" });
}
