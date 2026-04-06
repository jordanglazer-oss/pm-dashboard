import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { AppendixData, AppendixDailyValue, AppendixProfileType } from "@/app/lib/pim-types";

const KEY = "pm:appendix-daily-values";

const VALID_PROFILES: AppendixProfileType[] = ["balanced", "growth", "allEquity", "alpha"];

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ ledgers: [] });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (appendix-daily-values):", e);
    return NextResponse.json({ ledgers: [] });
  }
}

/**
 * POST: Append-only — adds new entries to a profile's ledger.
 * Existing entries are NEVER modified or removed.
 * Body: { profile: string, entries: AppendixDailyValue[] }
 *
 * Can also bulk-seed: { profile: string, entries: [...], seed: true }
 * seed=true will only write if the profile ledger is currently empty.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { profile, entries, seed } = body as {
      profile: AppendixProfileType;
      entries: AppendixDailyValue[];
      seed?: boolean;
    };

    if (!profile || !VALID_PROFILES.includes(profile)) {
      return NextResponse.json({ error: `Invalid profile. Must be one of: ${VALID_PROFILES.join(", ")}` }, { status: 400 });
    }
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: "entries must be a non-empty array" }, { status: 400 });
    }

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const data: AppendixData = raw ? JSON.parse(raw) : { ledgers: [] };

    let ledger = data.ledgers.find((l) => l.profile === profile);
    if (!ledger) {
      ledger = { profile, entries: [] };
      data.ledgers.push(ledger);
    }

    // If seed mode, only write if ledger is empty
    if (seed && ledger.entries.length > 0) {
      return NextResponse.json({
        ok: false,
        message: `Profile "${profile}" already has ${ledger.entries.length} entries. Seed skipped to protect existing data.`,
        entryCount: ledger.entries.length,
      });
    }

    // Build a set of existing dates to prevent duplicates
    const existingDates = new Set(ledger.entries.map((e) => e.date));
    const now = new Date().toISOString();

    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.date || entry.value == null) {
        skipped++;
        continue;
      }
      if (existingDates.has(entry.date)) {
        skipped++;
        continue;
      }
      ledger.entries.push({
        date: entry.date,
        value: entry.value,
        dailyReturn: entry.dailyReturn ?? 0,
        addedAt: entry.addedAt || now,
      });
      existingDates.add(entry.date);
      added++;
    }

    // Sort entries by date
    ledger.entries.sort((a, b) => a.date.localeCompare(b.date));

    await redis.set(KEY, JSON.stringify(data));

    return NextResponse.json({
      ok: true,
      profile,
      added,
      skipped,
      totalEntries: ledger.entries.length,
    });
  } catch (e) {
    console.error("Redis write error (appendix-daily-values):", e);
    return NextResponse.json({ error: "Failed to append" }, { status: 500 });
  }
}
