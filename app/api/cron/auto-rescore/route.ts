import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { autoRescoreStep } from "@/app/lib/auto-rescore";

/**
 * Event-driven auto-rescore ping — the Gmail Apps Script's 5-minute trigger
 * doubles as the pacer. Each invocation processes AT MOST ONE rescore (a full
 * rescore takes 30–90s, so one per call fits Vercel's 60s limit); the evening
 * window gives up to ~48 pings, the daily cap (5) and per-name cooldown (7d)
 * inside autoRescoreStep bound the actual work.
 *
 * Window: 19:00–23:00 ET (America/New_York, DST-correct), any day — after the
 * close, before the nightly backup cron, so the morning digest reports on
 * already-updated composites.
 *
 * Auth: Bearer CRON_SECRET or INBOX_SECRET (the Apps Script holds the latter).
 * /api/cron/* is cookie-middleware-exempt; this handler enforces the bearer.
 */

const log = createLogger("AutoRescoreCron");
export const maxDuration = 60;

function nyHourMin(): { minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { minutes: get("hour") * 60 + get("minute") };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const okSecrets = [process.env.CRON_SECRET, process.env.INBOX_SECRET].filter(Boolean).map((s) => `Bearer ${s}`);
  if (okSecrets.length === 0) return NextResponse.json({ error: "no secret configured" }, { status: 503 });
  if (!okSecrets.includes(auth)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { minutes } = nyHourMin();
  const windowStart = 19 * 60;
  const windowEnd = 23 * 60;
  if (minutes < windowStart || minutes > windowEnd) {
    return NextResponse.json({ skipped: true, reason: "outside 19:00–23:00 ET window" });
  }

  try {
    const result = await autoRescoreStep();
    return NextResponse.json(result);
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ status: "aborted", detail: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
