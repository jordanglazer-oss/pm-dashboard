import { NextResponse } from "next/server";
import { captureLiveHedgingSnapshot } from "@/app/lib/hedging";
import { createLogger } from "@/app/lib/logger";

/**
 * POST → fetch live SPY hedging costs and append today's snapshot to
 * `pm:hedging-history` (read-modify-write; replaces same-day, never touches
 * prior days). Lets the nav "Refresh prices" button build the hedging ledger
 * without the user opening the Hedging tab, so week-over-week populates even
 * on days the tab is never visited. Same write the tab does on refresh.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const log = createLogger("Hedging-snapshot");

export async function POST() {
  try {
    const res = await captureLiveHedgingSnapshot();
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("capture failed:", message);
    // 502 for known upstream (CBOE) trouble, 500 otherwise
    const status = /CBOE|parse|quote|empty/i.test(message) ? 502 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
