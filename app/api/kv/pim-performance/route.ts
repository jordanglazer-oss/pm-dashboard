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
 * STRICT IMMUTABILITY GUARD on PUT.
 *
 * Once an entry's (date, value, dailyReturn) is committed for a given
 * (groupId, profile), it can NEVER change. The guard compares the
 * incoming payload against what's already in Redis and rejects writes
 * that would modify any historical entry (date < today). Today's
 * entry can change (intraday refinement). New future-dated entries
 * can be appended freely. New (groupId, profile) series can be added
 * without restriction.
 *
 * Admin recovery endpoints write directly via redis.set, bypassing
 * this PUT and this guard. Anything reaching this route is from the
 * client side and must respect immutability.
 */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
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
    for (const incomingEntry of incomingModel.history) {
      if (incomingEntry.date >= today) continue;
      const existingEntry = existingDates.get(incomingEntry.date);
      if (!existingEntry) continue;
      const valueDiff = Math.abs(existingEntry.value - incomingEntry.value);
      const drDiff = Math.abs(existingEntry.dailyReturn - incomingEntry.dailyReturn);
      if (valueDiff > 0.0001 || drDiff > 0.0001) {
        return `${incomingModel.groupId}/${incomingModel.profile} on ${incomingEntry.date}: existing value=${existingEntry.value}, incoming=${incomingEntry.value}`;
      }
    }
    for (const existingEntry of existingModel.history) {
      if (existingEntry.date >= today) continue;
      const incomingHasIt = incomingModel.history.some((e) => e.date === existingEntry.date);
      if (!incomingHasIt) {
        return `${incomingModel.groupId}/${incomingModel.profile} on ${existingEntry.date}: incoming write would delete an existing historical entry`;
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
          { error: "Historical-immutability violation: refusing to modify or delete past entries", detail: conflict },
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
