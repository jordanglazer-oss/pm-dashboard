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
  const report: Record<string, number | string> = {};

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

  if (sourcesSeen.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No source reported — refusing to merge, since that would mark every candidate as fallen off.", report },
      { status: 409 },
    );
  }

  const redis = await getRedis();
  const prevRaw = await redis.get(CANDIDATES_KEY);
  const prev: CandidateStore = prevRaw ? (JSON.parse(prevRaw) as CandidateStore) : { candidates: [] };
  const next = mergeCandidates(prev, hits, asOf, sourcesSeen);

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

  await redis.set(CANDIDATES_KEY, JSON.stringify(next));
  return NextResponse.json(summary);
}

/** Same assembly, read-only — handy for checking what a refresh would do. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.searchParams.set("dryRun", "1");
  return POST(new NextRequest(url, { method: "POST" }));
}
