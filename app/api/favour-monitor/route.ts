import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { history as priceHistory } from "@/app/lib/holding-history";
import { loadRankedResearch } from "@/app/lib/research-ranked-server";
import { FAVOUR_RULES, favourNote, readFavour, type FavourGroup, type FavourRead, type Series } from "@/app/lib/favour";

/**
 * GET /api/favour-monitor[?refresh=1] — in favour / out of favour for the
 * stocks we own, the watchlist, and names on 2+ research lists we do not
 * track: relative performance vs the S&P 500 over 1 / 3 / 6 / 12 months and
 * distance from the 52-week high (app/lib/favour.ts). Prices only — never
 * the composite score.
 *
 * Reads pm:stocks and pm:research READ-ONLY. The result is cached in
 * pm:favour-monitor for 12 hours (a pure regenerable cache — safe to nuke);
 * on a failed rebuild the stale cache is served, and an empty build never
 * replaces a good one.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Favour-monitor");
const CACHE_KEY = "pm:favour-monitor";
const MAX_AGE_MS = 12 * 3_600_000;
const MAX_RANKED = 80;

type Row = { ticker: string; name: string; group: FavourGroup; lists?: number; note: string } & FavourRead;
type Payload = { at: string; index: string; rules: typeof FAVOUR_RULES; rows: Row[]; error?: string };
type StockRow = { ticker?: string; name?: string; bucket?: string; instrumentType?: string };

const isFundserv = (s: string) => /^[A-Z]{2,4}\d{2,5}$/i.test(s);

async function build(): Promise<Payload> {
  const { rows: ranked, stocks } = await loadRankedResearch();
  const names: { ticker: string; name: string; group: FavourGroup; lists?: number }[] = [];
  for (const s of stocks as StockRow[]) {
    if (!s.ticker || (s.bucket !== "Portfolio" && s.bucket !== "Watchlist")) continue;
    if ((s.instrumentType && s.instrumentType !== "stock") || isFundserv(s.ticker)) continue; // individual stocks only
    names.push({ ticker: s.ticker, name: s.name ?? "", group: s.bucket });
  }
  for (const r of ranked.filter((x) => !x.held && x.listCount >= 2).slice(0, MAX_RANKED)) names.push({ ticker: r.ticker, name: r.name, group: "Ranked", lists: r.listCount });

  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const index: Series = await priceHistory("^GSPC", since);
  if (index.dates.length < 100) throw new Error("could not load S&P 500 history");
  const out: Row[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const part = await Promise.all(
      names.slice(i, i + 10).map(async (n): Promise<Row> => {
        let read: FavourRead;
        try {
          read = readFavour(await priceHistory(n.ticker, since), index);
        } catch {
          read = readFavour({ dates: [], adj: [] }, index);
        }
        return { ...n, ...read, note: favourNote(read.state, n.group) };
      }),
    );
    out.push(...part);
  }
  return { at: new Date().toISOString(), index: "S&P 500 (price index)", rules: FAVOUR_RULES, rows: out };
}

export async function GET(req: NextRequest) {
  const redis = await getRedis();
  let cached: Payload | null = null;
  try {
    const raw = await redis.get(CACHE_KEY);
    cached = raw ? (JSON.parse(raw) as Payload) : null;
  } catch {
    cached = null;
  }
  const fresh = cached && Date.now() - Date.parse(cached.at) < MAX_AGE_MS;
  if (fresh && new URL(req.url).searchParams.get("refresh") !== "1") return NextResponse.json(cached);
  try {
    const next = await build();
    const priced = next.rows.filter((r) => r.state !== "thin").length;
    if (priced === 0 && cached?.rows?.length) return NextResponse.json({ ...cached, error: "rebuild returned no prices — showing the last good read" });
    if (priced > 0) await redis.set(CACHE_KEY, JSON.stringify(next));
    return NextResponse.json(next);
  } catch (e) {
    log.error("rebuild failed:", e);
    const error = e instanceof Error ? e.message : "failed";
    if (cached) return NextResponse.json({ ...cached, error });
    return NextResponse.json({ at: new Date().toISOString(), index: "S&P 500", rules: FAVOUR_RULES, rows: [], error } satisfies Payload);
  }
}
