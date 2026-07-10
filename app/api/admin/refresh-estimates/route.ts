import { NextResponse } from "next/server";
import { refreshFactsetEstimates } from "@/app/lib/estimates-refresh";

/**
 * Manual trigger for the daily FactSet analyst-estimate refresh (mean target,
 * analyst count, EPS FY+1 up/down revisions → pm:analyst-snapshots[*].factset).
 * Runs the exact same helper the nightly cron piggybacks on, so hitting this
 * on-demand gives the same result without waiting for 2am. Read-merge-write
 * only; never clobbers reports or other tickers. Returns the run summary.
 *
 *   https://pm-dashboard-7rr9.vercel.app/api/admin/refresh-estimates
 */
export async function GET() {
  try {
    const status = await refreshFactsetEstimates();
    return NextResponse.json({ ok: !status.error, ...status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
