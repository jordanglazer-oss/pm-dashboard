import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { loadRankedResearch } from "@/app/lib/research-ranked-server";
import type { RankedRow } from "@/app/lib/research-ranked";
import {
  SUGGESTED_STORE_KEY,
  DECISIONS_KEY,
  emptySuggestedStore,
  mergeSuggestedStore,
  buildSuggestedRows,
  qualifyingRows,
  type SuggestedStore,
  type DecisionStore,
} from "@/app/lib/suggested-watchlist";
import { readSiaHistory, siaPercentileDrift } from "@/app/lib/sia-history";
import { readWatchlistNotifiedMap } from "@/app/lib/mail-outbox";
import { requestCoverage } from "@/app/lib/coverage-request";
import { crossListingRoot } from "@/app/lib/ticker";
import type { CandidateStore } from "@/app/lib/watchlist-candidates";
import { getReportsForTicker, type AnalystReports } from "@/app/lib/analyst-snapshots";

/**
 * Suggested Watchlist (funnel stage 2).
 *
 * GET  — derives the list LIVE from pm:research (names on 2+ bullish lists),
 *        decorated with the store's first-seen dates, the 30-day decision
 *        memory, coverage-request state and "improving" signals. Read-only.
 * POST — refresh: folds the current qualifying names into
 *        pm:suggested-watchlist (first-seen / list-count baselines) and, for
 *        names that entered AFTER the initial build, queues the coverage-
 *        request email to the desk. `?dryRun=1` reports without writing.
 *
 * Redis: reads pm:research, pm:stocks, pm:suggested-watchlist,
 * pm:synthesis-decisions, pm:sia-history, pm:watchlist-candidates,
 * pm:watchlist-notified. POST writes pm:suggested-watchlist (read-merge-
 * write) and, via requestCoverage, pm:mail-outbox + pm:watchlist-notified.
 * Never touches pm:stocks.
 */

const log = createLogger("Suggested");
export const dynamic = "force-dynamic";

/** SIA percentile must rise by at least this much over the window to count. */
const SIA_IMPROVE_PTS = 5;
const SIA_WINDOW_DAYS = 14;

async function readStore(): Promise<SuggestedStore> {
  try {
    const raw = await (await getRedis()).get(SUGGESTED_STORE_KEY);
    if (!raw) return emptySuggestedStore();
    const parsed = JSON.parse(raw) as SuggestedStore;
    return parsed && typeof parsed.entries === "object" ? parsed : emptySuggestedStore();
  } catch {
    return emptySuggestedStore();
  }
}

async function readDecisions(): Promise<DecisionStore> {
  try {
    const raw = await (await getRedis()).get(DECISIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DecisionStore) : {};
  } catch {
    return {};
  }
}

async function readReports(): Promise<AnalystReports> {
  try {
    const raw = await (await getRedis()).get("pm:analyst-reports");
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as AnalystReports) : {};
  } catch {
    return {};
  }
}

/** Filed dates per source for the coverage column — the reply-to-feed loop's
 *  visible end: requested → RBC ✓ date → JPM ✓ date. */
function reportsFor(blob: AnalystReports, row: RankedRow): SuggestedRowReports | undefined {
  const rep = getReportsForTicker(blob, row.ticker) ?? getReportsForTicker(blob, row.key);
  if (!rep) return undefined;
  const d = (m?: { extractedAt?: string; uploadedAt: string }) => (m ? (m.extractedAt ?? m.uploadedAt).slice(0, 10) : undefined);
  const out = { rbc: d(rep.rbc), jpm: d(rep.jpm), morningstar: d(rep.morningstar) };
  return out.rbc || out.jpm || out.morningstar ? out : undefined;
}
type SuggestedRowReports = NonNullable<import("@/app/lib/suggested-watchlist").SuggestedRow["reports"]>;

async function readMovers(): Promise<CandidateStore> {
  try {
    const raw = await (await getRedis()).get("pm:watchlist-candidates");
    const parsed = raw ? (JSON.parse(raw) as CandidateStore) : { candidates: [] };
    return Array.isArray(parsed?.candidates) ? parsed : { candidates: [] };
  } catch {
    return { candidates: [] };
  }
}

/** Build the "improving" decorator from SIA drift + the Movers confluence score. */
async function improvingFn(): Promise<(row: RankedRow) => string[]> {
  const [sia, movers] = await Promise.all([readSiaHistory(), readMovers()]);
  const windowStart = Date.now() - SIA_WINDOW_DAYS * 86_400_000;
  const moversByRoot = new Map(movers.candidates.map((c) => [crossListingRoot(c.ticker), c]));
  return (row) => {
    const out: string[] = [];
    const entries = sia[row.ticker.toUpperCase()] ?? sia[row.key.toUpperCase()] ?? sia[`${row.key}.TO`];
    const drift = siaPercentileDrift(entries, row.ticker, windowStart);
    if (drift && drift.delta >= SIA_IMPROVE_PTS) out.push(`SIA percentile ${drift.from}→${drift.to}`);
    const m = moversByRoot.get(row.key);
    if (m && !m.fallenOffAt && m.previousScore != null && m.score > m.previousScore) {
      const srcs = Object.keys(m.sources).map((s) => s.replace("rbc-equate-", "Equate ").toUpperCase()).join("/");
      out.push(`Movers ${m.previousScore}→${m.score} (${srcs})`);
    }
    return out;
  };
}

export async function GET() {
  try {
    const [{ rows: ranked }, store, decisions, notified, improving, reports] = await Promise.all([
      loadRankedResearch(),
      readStore(),
      readDecisions(),
      readWatchlistNotifiedMap(),
      improvingFn(),
      readReports(),
    ]);
    const { rows, passed } = buildSuggestedRows(ranked, store, decisions, improving);
    const withCoverage = (r: (typeof rows)[number]) => ({
      ...r,
      coverageRequestedAt: r.coverageRequestedAt ?? notified[r.ticker.toUpperCase()] ?? notified[r.key.toUpperCase()],
      reports: reportsFor(reports, r),
    });
    return NextResponse.json({
      rows: rows.map(withCoverage),
      passed: passed.map(withCoverage),
      initialBuildAt: store.initialBuildAt ?? null,
      updatedAt: store.updatedAt ?? null,
    });
  } catch (e) {
    log.error("GET failed:", e);
    return NextResponse.json({ rows: [], passed: [], initialBuildAt: null, updatedAt: null, error: "load failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  try {
    const [{ rows: ranked }, prev] = await Promise.all([loadRankedResearch(), readStore()]);
    const qualifying = qualifyingRows(ranked);
    const nowIso = new Date().toISOString();
    const { next, newTickers, isInitialBuild } = mergeSuggestedStore(prev, qualifying, nowIso);

    // Coverage requests: only for names entering AFTER the first build (the
    // initial batch is requested by hand, row by row, so the desk isn't
    // flooded), and only for names the book doesn't already track (a
    // Watchlist add already asked). requestCoverage dedupes per ticker forever.
    const toRequest = isInitialBuild ? [] : newTickers.filter((t) => !qualifying.find((r) => r.ticker === t)?.held);
    const emailed: string[] = [];
    if (!dryRun) {
      for (const t of toRequest) {
        try {
          const r = await requestCoverage(t, "suggested");
          if (r.queued) emailed.push(t);
          const key = t.toUpperCase();
          if (next.entries[key] && (r.queued || r.reason === "already-notified" || r.reason === "already-queued")) {
            next.entries[key] = { ...next.entries[key], coverageRequestedAt: next.entries[key].coverageRequestedAt ?? nowIso };
          }
        } catch (e) {
          log.warn(`coverage request failed for ${t}:`, e);
        }
      }
      await (await getRedis()).set(SUGGESTED_STORE_KEY, JSON.stringify(next));
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      isInitialBuild,
      qualifying: qualifying.length,
      newTickers,
      coverageRequested: emailed,
      updatedAt: next.updatedAt,
    });
  } catch (e) {
    log.error("POST failed:", e);
    return NextResponse.json({ error: "refresh failed" }, { status: 500 });
  }
}
