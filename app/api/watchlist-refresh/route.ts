import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { readEquateSheet } from "@/app/lib/equate-store";
import { equateHits } from "@/app/lib/equate-parse";
import { siaHits } from "@/app/lib/sia-hits";
import { mergeCandidates, type CandidateStore, type SourceHit } from "@/app/lib/watchlist-candidates";
import type { SiaSnapshot } from "@/app/lib/sia-universe-shared";

export const maxDuration = 60;

const CANDIDATES_KEY = "pm:watchlist-candidates";
const SIA_KEY = "pm:sia-universe";

/**
 * POST /api/watchlist-refresh — rebuild the Suggested Watchlist.
 *
 * Assembles hits from every discovery source in ONE pass and merges once. That
 * is the whole reason the sheets are stored on arrival rather than folded in as
 * they land: the merge must know which sources reported, and a per-file merge
 * would make each arrival look like a week where only that source delivered,
 * marking every other source's names as fallen off.
 *
 * A source only enters `sourcesSeen` when it actually produced a reading, so a
 * week where the Equate email is late leaves its names untouched instead of
 * reporting a mass drop-off.
 *
 * Discovery sources only. MarketEdge upgrades/downgrades and the SIA
 * portfolio/watchlist exports cover names already tracked and can never
 * nominate anything new, so they are monitoring feeds and stay out of this.
 *
 * `?dryRun=1` returns what would change without writing.
 */
export async function POST(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const asOf = new Date().toISOString();
  const hits: SourceHit[] = [];
  const sourcesSeen: string[] = [];
  const report: Record<string, number | string | string[]> = {};

  // ── RBC EQUATE ─────────────────────────────────────────────────────────
  for (const region of ["us", "canada"] as const) {
    const sheet = await readEquateSheet(region, false);
    const key = region === "canada" ? "rbc-equate-cad" : "rbc-equate-usd";
    if (!sheet || sheet.rows.length === 0) {
      report[key] = "no sheet stored";
      continue;
    }
    const h = equateHits({ region, largeCapOnly: false, rows: sheet.rows, errors: [] });
    hits.push(...h);
    sourcesSeen.push(key);
    report[key] = h.length;
  }

  // ── SIA universe ───────────────────────────────────────────────────────
  try {
    const raw = await (await getRedis()).get(SIA_KEY);
    const snap = raw ? (JSON.parse(raw) as SiaSnapshot) : null;
    const h = siaHits(snap);
    if (snap) {
      hits.push(...h);
      sourcesSeen.push("sia");
      report.sia = h.length;
    } else {
      report.sia = "no snapshot";
    }
  } catch (e) {
    report.sia = `error: ${String(e)}`;
  }

  const redisEarly = await getRedis();

  if (sourcesSeen.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No source reported — refusing to merge, since that would mark every candidate as fallen off.", report },
      { status: 409 },
    );
  }

  const prevRaw = await redisEarly.get(CANDIDATES_KEY);
  const prev: CandidateStore = prevRaw ? (JSON.parse(prevRaw) as CandidateStore) : { candidates: [] };
  const next = mergeCandidates(prev, hits, asOf, sourcesSeen);

  // ── Fill in names and NORMALISE sectors ────────────────────────────────
  // Two different problems, one lookup.
  //
  // NAMES: the Equate sheets carry NAME, but the SIA universe stores only
  // ticker, rank and sector — so a SIA-only candidate rendered its ticker in
  // both columns.
  //
  // SECTORS: each source labels sectors its own way. Equate publishes GICS
  // wording ("Information Technology", "Health Care") while the rest of the
  // app stores whatever Yahoo returns ("Technology", "Healthcare"). Left
  // alone, the Suggested tab would sort and group differently from Portfolio
  // and Watchlist for the same company — so a source-supplied sector is
  // treated as a fallback and OVERWRITTEN by the app's own value wherever one
  // can be had.
  //
  // pm:stocks is checked first: for a name already tracked it is free, exact,
  // and guaranteed to match what the other tabs display.
  try {
    const rawStocks = await redisEarly.get("pm:stocks");
    const known = rawStocks ? (JSON.parse(rawStocks) as { ticker: string; name?: string; sector?: string }[]) : [];
    const bySym = new Map(known.map((k) => [k.ticker.toUpperCase().replace(/-T$/, ".TO"), k]));
    let fromStocks = 0;
    for (const c of next.candidates) {
      const hit = bySym.get(c.ticker.toUpperCase().replace(/-T$/, ".TO"));
      if (!hit) continue;
      if (hit.sector) { c.sector = hit.sector; fromStocks++; }
      if (hit.name && (!c.name || c.name === c.ticker)) c.name = hit.name;
    }
    report.sectorsFromStocks = fromStocks;
  } catch (e) {
    report.sectorsFromStocks = `pm:stocks read failed: ${String(e)}`;
  }

  // Anything still missing a name, or still carrying only a source-supplied
  // sector, goes to the same resolver the rest of the app uses.
  const trackedSet = new Set<string>();
  try {
    const rawStocks = await redisEarly.get("pm:stocks");
    for (const k of (rawStocks ? JSON.parse(rawStocks) : []) as { ticker: string }[]) {
      trackedSet.add(k.ticker.toUpperCase().replace(/-T$/, ".TO"));
    }
  } catch { /* fall through — worst case we look a few extra tickers up */ }

  const needLookup = next.candidates
    .filter((c) => !trackedSet.has(c.ticker.toUpperCase().replace(/-T$/, ".TO")))
    .map((c) => c.ticker);

  if (needLookup.length > 0) {
    try {
      const origin = new URL(req.url).origin;
      const nameByTicker = new Map<string, string>();
      const sectorByTicker = new Map<string, string>();
      // Chunked: a few hundred tickers in one query string is a 414 waiting to
      // happen, and one failed chunk should not cost every name.
      for (let i = 0; i < needLookup.length; i += 50) {
        const chunk = needLookup.slice(i, i + 50);
        const r = await fetch(`${origin}/api/company-name?tickers=${encodeURIComponent(chunk.join(","))}`, {
          headers: { cookie: req.headers.get("cookie") ?? "" },
        });
        if (!r.ok) continue;
        const data = (await r.json()) as { names?: Record<string, string>; sectors?: Record<string, string> };
        for (const [k, v] of Object.entries(data.names ?? {})) if (v?.trim()) nameByTicker.set(k, v.trim());
        for (const [k, v] of Object.entries(data.sectors ?? {})) if (v?.trim()) sectorByTicker.set(k, v.trim());
      }
      for (const c of next.candidates) {
        const n = nameByTicker.get(c.ticker);
        if (n) c.name = n;
        const sec = sectorByTicker.get(c.ticker);
        if (sec) c.sector = sec; // app taxonomy wins over the source's wording
      }
      report.namesResolved = next.candidates.filter((c) => c.name && c.name !== c.ticker).length;
      report.sectorsResolved = next.candidates.filter((c) => !!c.sector).length;
      report.missingSector = next.candidates.filter((c) => !c.sector).map((c) => c.ticker).slice(0, 20);
    } catch (e) {
      report.namesResolved = `lookup failed: ${String(e)}`;
    }
  }

  const summary = {
    ok: true,
    dryRun,
    asOf,
    sourcesSeen,
    report,
    totalHits: hits.length,
    candidates: next.candidates.length,
    live: next.candidates.filter((c) => !c.fallenOffAt).length,
    newThisWeek: next.candidates.filter((c) => !c.fallenOffAt && c.firstSeenAt === asOf).length,
    fellOff: next.candidates.filter((c) => c.fallenOffAt === asOf).length,
  };
  if (dryRun) return NextResponse.json(summary);

  await redisEarly.set(CANDIDATES_KEY, JSON.stringify(next));
  return NextResponse.json(summary);
}

/** Same assembly, read-only — handy for checking what a refresh would do. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.searchParams.set("dryRun", "1");
  return POST(new NextRequest(url, { method: "POST" }));
}
