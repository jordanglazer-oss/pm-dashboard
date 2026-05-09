import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { PimPerformanceData, PimModelPerformance, PimDailyReturn } from "@/app/lib/pim-types";

const KEY = "pm:pim-performance";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      return NextResponse.json({ models: [], lastUpdated: null });
    }
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-performance):", e);
    return NextResponse.json({ models: [], lastUpdated: null });
  }
}

/**
 * IMMUTABILITY GUARD on PUT.
 *
 * Entries within the recalc window (last 5 calendar days) can still
 * be modified — that's the period where mutual-fund NAVs published
 * the next morning legitimately refine the prior day's value, and
 * matches the 5-day safety net in /api/update-daily-value's pop loop.
 *
 * Anything OLDER than 5 calendar days is sealed forever. The guard
 * compares incoming entries against existing data and rejects writes
 * that would modify any entry with a date older than the window, OR
 * delete an existing historical entry beyond the window.
 *
 * Admin recovery endpoints write directly via redis.set, bypassing
 * this PUT and this guard. Anything reaching this route is from the
 * client side and must respect the immutability boundary.
 */
const RECALC_WINDOW_DAYS = 5;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function isOlderThanWindow(entryDate: string, today: string): boolean {
  const days = (new Date(today).getTime() - new Date(entryDate).getTime()) / (1000 * 60 * 60 * 24);
  return days > RECALC_WINDOW_DAYS;
}

function findHistoricalConflict(
  existing: PimPerformanceData,
  incoming: PimPerformanceData,
  today: string,
): string | null {
  const existingMap = new Map<string, PimModelPerformance>();
  for (const m of existing.models) existingMap.set(`${m.groupId}|${m.profile}`, m);
  for (const incomingModel of incoming.models) {
    const existingModel = existingMap.get(`${incomingModel.groupId}|${incomingModel.profile}`);
    if (!existingModel) continue;
    const existingDates = new Map<string, PimDailyReturn>();
    for (const e of existingModel.history) existingDates.set(e.date, e);
    // Reject changes to entries older than the recalc window.
    for (const incomingEntry of incomingModel.history) {
      if (!isOlderThanWindow(incomingEntry.date, today)) continue;
      const existingEntry = existingDates.get(incomingEntry.date);
      if (!existingEntry) continue;
      const valueDiff = Math.abs(existingEntry.value - incomingEntry.value);
      const drDiff = Math.abs(existingEntry.dailyReturn - incomingEntry.dailyReturn);
      if (valueDiff > 0.0001 || drDiff > 0.0001) {
        return `${incomingModel.groupId}/${incomingModel.profile} on ${incomingEntry.date}: refusing to modify entry older than ${RECALC_WINDOW_DAYS} calendar days (existing=${existingEntry.value}, incoming=${incomingEntry.value})`;
      }
    }
    // Reject deletions of entries older than the recalc window.
    for (const existingEntry of existingModel.history) {
      if (!isOlderThanWindow(existingEntry.date, today)) continue;
      const incomingHasIt = incomingModel.history.some((e) => e.date === existingEntry.date);
      if (!incomingHasIt) {
        return `${incomingModel.groupId}/${incomingModel.profile} on ${existingEntry.date}: incoming write would delete a historical entry older than ${RECALC_WINDOW_DAYS} calendar days`;
      }
    }
  }
  return null;
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json() as PimPerformanceData;
    const redis = await getRedis();
    const existingRaw = await redis.get(KEY);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as PimPerformanceData;
      const conflict = findHistoricalConflict(existing, data, todayUTC());
      if (conflict) {
        return NextResponse.json(
          { error: "Historical-immutability violation: refusing to modify or delete past entries beyond recalc window", detail: conflict },
          { status: 409 },
        );
      }
    }
    await redis.set(KEY, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-performance):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
