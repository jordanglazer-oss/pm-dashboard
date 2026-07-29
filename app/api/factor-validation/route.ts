import { NextResponse } from "next/server";
import { runValidation } from "@/app/lib/factor-validation";

/**
 * Four-way IC validation read-out (Phase C). Computes on demand from
 * pm:factor-history — the log is small (one row per book name per day), so a
 * live computation is cheap and always current. Cookie-gated like the other
 * authenticated routes. Read-only: writes nothing, touches no score.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return NextResponse.json(await runValidation());
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
