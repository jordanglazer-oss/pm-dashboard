import { NextRequest, NextResponse } from "next/server";
import { runCustomConditionChecks } from "@/app/lib/custom-condition-check";

/**
 * POST /api/custom-condition-check { ticker, force? } — the ThesisTile's
 * "verify now" button for AI-checked custom kill conditions. One web-search
 * Sonnet call per due condition (see app/lib/custom-condition-check for the
 * due/skip rules; force re-verifies regardless of staleness).
 *
 * The nightly chain calls the lib directly (backup-redis step, pre-digest) —
 * this route exists for the on-demand click. Behind the auth middleware.
 */

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const result = await runCustomConditionChecks({ ticker, force: body?.force === true });
    return NextResponse.json(result);
  } catch (e) {
    console.error("custom-condition-check error:", e);
    return NextResponse.json({ error: "check failed" }, { status: 500 });
  }
}
