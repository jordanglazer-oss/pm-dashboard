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
 * Two-tier rule:
 *   1. Anything dated BEFORE January 1 of the current calendar year is
 *      LOCKED FOREVER. Pre-current-year history is permanent — once an
 *      annual close passes, that year's daily-return ledger never
 *      changes again.
 *   2. Entries within the CURRENT YEAR are allowed to be modified by
 *      admin-controlled recompute endpoints. Client-side PUTs still
 *      cannot modify them unless the recalc window applies (last 5
 *      calendar days, where next-day mutual-fund NAV refinements
 *      legitimately update yesterday's value).
 *
 * Admin recovery / recompute endpoints write directly via redis.set,
 * intentionally bypassing this PUT and this guard. Anything reaching
 * this route is from the client side and must respect the boundary.
 */
const RECALC_WINDOW_DAYS = 5;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentYearStart(today: string): string {
  return `${today.slice(0, 4)}-01-01`;
}

function isLocked(entryDate: string, today: string): boolean {
  // Pre-current-year: permanently locked.
  if (entryDate < currentYearStart(today)) return true;
  // Current-year entries older than the recalc window: locked from
  // client-side writes (admin endpoints bypass via redis.set).
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
    // Reject changes to locked entries.
    for (const incomingEntry of incomingModel.history) {
      if (!isLocked(incomingEntry.date, today)) continue;
      const existingEntry = existingDates.get(incomingEntry.date);
      if (!existingEntry) continue;
      const valueDiff = Math.abs(existingEntry.value - incomingEntry.value);
      const drDiff = Math.abs(existingEntry.dailyReturn - incomingEntry.dailyReturn);
      if (valueDiff > 0.0001 || drDiff > 0.0001) {
        const reason = incomingEntry.date < currentYearStart(today)
          ? `pre-current-year entry (permanently locked)`
          : `entry older than ${RECALC_WINDOW_DAYS} calendar days (current-year recalc window only allows admin writes via redis.set)`;
        return `${incomingModel.groupId}/${incomingModel.profile} on ${incomingEntry.date}: refusing to modify ${reason} (existing=${existingEntry.value}, incoming=${incomingEntry.value})`;
      }
    }
    // Reject deletions of locked entries.
    for (const existingEntry of existingModel.history) {
      if (!isLocked(existingEntry.date, today)) continue;
      const incomingHasIt = incomingModel.history.some((e) => e.date === existingEntry.date);
      if (!incomingHasIt) {
        const reason = existingEntry.date < currentYearStart(today)
          ? `pre-current-year entry (permanently locked)`
          : `entry older than ${RECALC_WINDOW_DAYS} calendar days`;
        return `${incomingModel.groupId}/${incomingModel.profile} on ${existingEntry.date}: incoming write would delete ${reason}`;
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
          { error: "Historical-immutability violation", detail: conflict },
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
