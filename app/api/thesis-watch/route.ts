import { NextResponse } from "next/server";
import { loadAlertInputs } from "@/app/lib/alert-inputs";

/**
 * GET /api/thesis-watch — fleet-wide kill-condition sweep, read-only.
 *
 * Returns every underwritten holding with its conditions evaluated by the
 * same pure checker the stock-page tile uses (app/lib/kill-conditions),
 * from the same loadAlertInputs() data the alerts tile and morning digest
 * read — one loader, three surfaces, no drift.
 *
 * Deterministic; zero Anthropic spend. No Redis writes.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { killWatch } = await loadAlertInputs();
    return NextResponse.json({ holdings: killWatch });
  } catch (e) {
    console.error("thesis-watch failed:", e);
    // Read-only surface: degrade to empty rather than erroring the page.
    return NextResponse.json({ holdings: [] });
  }
}
