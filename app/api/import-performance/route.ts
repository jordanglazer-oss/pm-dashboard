import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

import type { PimPerformanceData, PimModelPerformance, PimDailyReturn, PimProfileType } from "@/app/lib/pim-types";

const PERF_KEY = "pm:pim-performance";
const STATE_KEY = "pm:pim-portfolio-state";

type DailyValueRow = {
  date: string; // MM/DD/YYYY from xlsx
  cash: number;
  total: number;
};

/**
 * Parse the Daily Value xlsx into daily value rows.
 * Columns: [null, "Edit", "Date", "Trades", "Corp. Act.", "Cash", "Total"]
 */
function parseDailyValueXlsx(filePath: string): DailyValueRow[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  const values: DailyValueRow[] = [];
  // Skip header rows (row 0 = title, row 1 = column headers)
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const dateStr = row[2];
    const cash = row[5];
    const total = row[6];
    if (!dateStr || typeof total !== "number" || total <= 0) continue;
    values.push({
      date: String(dateStr),
      cash: typeof cash === "number" ? cash : 0,
      total,
    });
  }

  // Sort chronologically (data comes in reverse chronological order)
  values.sort((a, b) => {
    const da = parseDateStr(a.date);
    const db = parseDateStr(b.date);
    return da.getTime() - db.getTime();
  });

  return values;
}

/** Parse MM/DD/YYYY → Date */
function parseDateStr(s: string): Date {
  const parts = s.split("/");
  return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
}

/** Convert MM/DD/YYYY → YYYY-MM-DD */
function toISODate(s: string): string {
  const parts = s.split("/");
  return `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

/**
 * Convert daily portfolio values to PimDailyReturn[] with index starting at 100.
 */
function buildDailyReturns(values: DailyValueRow[]): PimDailyReturn[] {
  if (values.length === 0) return [];

  const baseValue = values[0].total;
  const returns: PimDailyReturn[] = [];

  for (let i = 0; i < values.length; i++) {
    const indexValue = (values[i].total / baseValue) * 100;
    const dailyReturn = i === 0 ? 0 : ((values[i].total - values[i - 1].total) / values[i - 1].total) * 100;

    returns.push({
      date: toISODate(values[i].date),
      value: parseFloat(indexValue.toFixed(4)),
      dailyReturn: parseFloat(dailyReturn.toFixed(4)),
    });
  }

  return returns;
}

/**
 * POST /api/import-performance
 *
 * Import historical daily values from xlsx files in the project root.
 * Body: { models: [{ file: "All-Equity Daily Value.xlsx", groupId: "pim", profile: "allEquity" }] }
 *
 * Each entry maps an xlsx file to a PIM model group + profile.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const imports: Array<{ file: string; groupId: string; profile: PimProfileType }> = body.models || [];

    if (imports.length === 0) {
      return NextResponse.json({ error: "No models specified" }, { status: 400 });
    }

    const redis = await getRedis();

    // Load existing performance data to merge with
    let existingData: PimPerformanceData = { models: [], lastUpdated: "" };
    const raw = await redis.get(PERF_KEY);
    if (raw) {
      try { existingData = JSON.parse(raw); } catch { /* fresh start */ }
    }

    const results: Array<{ groupId: string; profile: string; days: number; startDate: string; endDate: string }> = [];

    for (const imp of imports) {
      const filePath = path.join(process.cwd(), imp.file);
      if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: `File not found: ${imp.file}` }, { status: 404 });
      }

      const values = parseDailyValueXlsx(filePath);
      if (values.length === 0) {
        return NextResponse.json({ error: `No valid data in ${imp.file}` }, { status: 400 });
      }

      const history = buildDailyReturns(values);

      const modelPerf: PimModelPerformance = {
        groupId: imp.groupId,
        profile: imp.profile,
        history,
        lastUpdated: new Date().toISOString(),
      };

      // Replace existing entry for same groupId + profile, or add new
      existingData.models = existingData.models.filter(
        (m) => !(m.groupId === imp.groupId && m.profile === imp.profile)
      );
      existingData.models.push(modelPerf);

      // Set tracking start in portfolio state
      const stateRaw = await redis.get(STATE_KEY);
      let state: { groupStates: Array<{ groupId: string; trackingStart: unknown; lastRebalance: unknown; transactions: unknown[] }>; lastUpdated: string } = {
        groupStates: [],
        lastUpdated: "",
      };
      if (stateRaw) {
        try { state = JSON.parse(stateRaw); } catch { /* fresh */ }
      }

      const inceptionDate = toISODate(values[0].date);
      let gs = state.groupStates.find((g) => g.groupId === imp.groupId);
      if (!gs) {
        gs = { groupId: imp.groupId, trackingStart: null, lastRebalance: null, transactions: [] };
        state.groupStates.push(gs);
      }
      // Set tracking start to inception if not already earlier
      if (!gs.trackingStart || (gs.trackingStart as { date: string }).date > inceptionDate) {
        gs.trackingStart = { date: inceptionDate, prices: {} };
      }
      state.lastUpdated = new Date().toISOString();
      await redis.set(STATE_KEY, JSON.stringify(state));

      results.push({
        groupId: imp.groupId,
        profile: imp.profile,
        days: history.length,
        startDate: history[0].date,
        endDate: history[history.length - 1].date,
      });
    }

    existingData.lastUpdated = new Date().toISOString();
    await redis.set(PERF_KEY, JSON.stringify(existingData));

    return NextResponse.json({
      ok: true,
      imported: results,
      totalModels: existingData.models.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Import performance error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
