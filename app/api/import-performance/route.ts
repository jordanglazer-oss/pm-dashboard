import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

import type { PimPerformanceData, PimModelPerformance, PimDailyReturn, PimProfileType } from "@/app/lib/pim-types";

const PERF_KEY = "pm:pim-performance";
const STATE_KEY = "pm:pim-portfolio-state";

/**
 * POST /api/import-performance
 *
 * Import daily values from client-side parsed xlsx data.
 * Body: {
 *   groupId: string,
 *   profile: PimProfileType,
 *   dailyValues: Array<{ date: string (YYYY-MM-DD), cash: number, total: number }>
 * }
 *
 * Converts raw daily values into index-based PimDailyReturn[] (starting at 100)
 * and stores in Redis.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { groupId, profile, dailyValues } = body as {
      groupId: string;
      profile: PimProfileType;
      dailyValues: Array<{ date: string; cash: number; total: number }>;
    };

    if (!groupId || !profile || !dailyValues?.length) {
      return NextResponse.json({ error: "Missing groupId, profile, or dailyValues" }, { status: 400 });
    }

    // Sort chronologically
    const sorted = [...dailyValues].sort((a, b) => a.date.localeCompare(b.date));

    // Filter out invalid entries
    const valid = sorted.filter((v) => v.total > 0 && v.date);

    if (valid.length === 0) {
      return NextResponse.json({ error: "No valid daily values" }, { status: 400 });
    }

    // Build index-based returns (starting at 100)
    const baseValue = valid[0].total;
    const history: PimDailyReturn[] = [];

    for (let i = 0; i < valid.length; i++) {
      const indexValue = (valid[i].total / baseValue) * 100;
      const dailyReturn = i === 0 ? 0 : ((valid[i].total - valid[i - 1].total) / valid[i - 1].total) * 100;

      history.push({
        date: valid[i].date,
        value: parseFloat(indexValue.toFixed(4)),
        dailyReturn: parseFloat(dailyReturn.toFixed(4)),
      });
    }

    const redis = await getRedis();

    // Load existing performance data to merge with
    let existingData: PimPerformanceData = { models: [], lastUpdated: "" };
    const raw = await redis.get(PERF_KEY);
    if (raw) {
      try { existingData = JSON.parse(raw); } catch { /* fresh start */ }
    }

    const modelPerf: PimModelPerformance = {
      groupId,
      profile,
      history,
      lastUpdated: new Date().toISOString(),
    };

    // Replace existing entry for same groupId + profile, or add new
    existingData.models = existingData.models.filter(
      (m) => !(m.groupId === groupId && m.profile === profile)
    );
    existingData.models.push(modelPerf);
    existingData.lastUpdated = new Date().toISOString();

    await redis.set(PERF_KEY, JSON.stringify(existingData));

    // Set tracking start in portfolio state
    const stateRaw = await redis.get(STATE_KEY);
    let state: { groupStates: Array<{ groupId: string; trackingStart: unknown; lastRebalance: unknown; transactions: unknown[] }>; lastUpdated: string } = {
      groupStates: [],
      lastUpdated: "",
    };
    if (stateRaw) {
      try { state = JSON.parse(stateRaw); } catch { /* fresh */ }
    }

    const inceptionDate = valid[0].date;
    let gs = state.groupStates.find((g) => g.groupId === groupId);
    if (!gs) {
      gs = { groupId, trackingStart: null, lastRebalance: null, transactions: [] };
      state.groupStates.push(gs);
    }
    if (!gs.trackingStart || (gs.trackingStart as { date: string }).date > inceptionDate) {
      gs.trackingStart = { date: inceptionDate, prices: {} };
    }
    state.lastUpdated = new Date().toISOString();
    await redis.set(STATE_KEY, JSON.stringify(state));

    return NextResponse.json({
      ok: true,
      imported: {
        groupId,
        profile,
        days: history.length,
        startDate: history[0].date,
        endDate: history[history.length - 1].date,
        startValue: valid[0].total,
        endValue: valid[valid.length - 1].total,
        totalReturn: ((valid[valid.length - 1].total - valid[0].total) / valid[0].total * 100).toFixed(2) + "%",
      },
      totalModels: existingData.models.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Import performance error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
