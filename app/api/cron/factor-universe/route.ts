import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { buildUniverseStep, readUniverse } from "@/app/lib/factor-universe";

/**
 * Factor-universe build pacer (Phase A2). Pinged by the Gmail Apps Script's
 * 5-minute trigger; runs only when the snapshot is due (Sunday, or stale >6d,
 * or a build is already mid-flight), one time-budgeted chunk-resumable step
 * per ping. ?force=1 (with the bearer) starts a build immediately — used for
 * the first-ever build so we don't wait for Sunday.
 *
 * Auth: Bearer CRON_SECRET or INBOX_SECRET. Writes only the two regenerable
 * factor-universe caches. Strictly additive.
 */

const log = createLogger("FactorUniverseCron");
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const okSecrets = [process.env.CRON_SECRET, process.env.INBOX_SECRET].filter(Boolean).map((s) => `Bearer ${s}`);
  if (okSecrets.length === 0) return NextResponse.json({ error: "no secret configured" }, { status: 503 });
  if (!okSecrets.includes(auth)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const existing = await readUniverse();
    const ageDays = existing ? (Date.now() - Date.parse(existing.builtAt)) / 86_400_000 : Infinity;
    const isSunday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date()) === "Sun";
    // Due when: forced, never built, stale beyond a week, or Sunday refresh.
    const due = force || !existing || ageDays > 6.5 || (isSunday && ageDays > 0.5);
    if (!due) return NextResponse.json({ skipped: true, ageDays: Math.round(ageDays * 10) / 10 });

    const result = await buildUniverseStep();
    return NextResponse.json(result);
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ status: "error", detail: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
