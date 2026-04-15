import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Persistence for the Manager Commentary block on the Client Report
 * one-pager. Stored as a single JSON blob keyed by group+profile so a
 * commentary written for PIM Balanced doesn't leak into PIM Growth.
 *
 * Shape on disk:
 *   { "pim::balanced": "Q2 highlighted rotation into ..." }
 *
 * Commentary is intentionally short-lived — overwritten on every save,
 * no history kept — because the user flagged this section as rarely
 * used and we don't want to waste Redis space on a feature used <1×
 * per month.
 */

const KEY = "pm:client-report-notes";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ notes: {} });
    return NextResponse.json({ notes: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (client-report-notes):", e);
    return NextResponse.json({ notes: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const notes = body?.notes;
    if (!notes || typeof notes !== "object") {
      return NextResponse.json({ error: "notes object required" }, { status: 400 });
    }
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(notes));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (client-report-notes):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
