import { NextRequest, NextResponse } from "next/server";
import { loggedYtd, readFundNavLog, updateFundNavLog } from "@/app/lib/fund-nav-log";
import { fetchFundNav, ytdReturn } from "@/app/lib/fund-nav";
import { createLogger } from "@/app/lib/logger";

/**
 * GET /api/admin/fund-nav-log
 *   (no params)     what is on file per fund, what the next run would ADD, and
 *                   a check: year-to-date total return from OUR log vs the
 *                   price feed's distribution-adjusted series. Writes nothing.
 *   ?confirm=YES    runs the update now (the weekday cron does this daily).
 *                   It only ADDS NAVs and distributions that are not on file;
 *                   nothing on file is changed or removed.
 *
 * There is nothing to stash: an append that adds entries cannot lose data,
 * and an unreadable log is left alone.
 */

const log = createLogger("Fund-nav-log");
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const confirm = new URL(req.url).searchParams.get("confirm") === "YES";
  try {
    const run = await updateFundNavLog({ dryRun: !confirm });
    const stored = await readFundNavLog().catch(() => null);
    const funds = await Promise.all(
      Object.entries(stored?.funds ?? {}).map(async ([code, entry]) => {
        const feed = ytdReturn(await fetchFundNav(code, { records: 300, adjusted: true }));
        const ours = loggedYtd(entry);
        const gap = ours != null && feed != null ? +(ours - feed).toFixed(2) : null;
        return {
          code,
          navDays: entry.nav.length,
          from: entry.nav[0]?.[0] ?? null,
          to: entry.nav.at(-1)?.[0] ?? null,
          latestNav: entry.nav.at(-1)?.[1] ?? null,
          distributionsOnFile: entry.dists.length,
          lastDistributions: entry.dists.slice(-4),
          ytdFromOurLogPct: ours == null ? null : +ours.toFixed(2),
          ytdFromPriceFeedPct: feed == null ? null : +feed.toFixed(2),
          gapPts: gap,
          agrees: gap == null ? null : Math.abs(gap) <= 0.15,
        };
      }),
    );
    return NextResponse.json({
      mode: confirm ? "updated" : "preview (add &confirm=YES to run the update now)",
      wrote: run.wrote,
      error: run.error ?? null,
      thisRun: run.funds,
      onFile: funds.sort((a, b) => a.code.localeCompare(b.code)),
      note: "ytdFromOurLogPct is rebuilt from the plain NAVs and distributions on file; ytdFromPriceFeedPct is the feed's own adjusted series. They should agree to within about 0.15 points.",
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
