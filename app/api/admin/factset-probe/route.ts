import { NextRequest, NextResponse } from "next/server";
import {
  crossSectional,
  factsetConfigured,
  relayHealthy,
  FACTSET_FORMULAS,
} from "@/app/lib/factset";

/**
 * GET /api/admin/factset-probe?ids=AAPL-US,SPY-US&formulas=P_PRICE,P_BETA
 *
 * Admin-only (gated by the cookie middleware on /api/admin/*). Verifies the
 * dashboard -> relay -> FactSet path end to end WITHOUT wiring FactSet into any
 * user-facing flow. Read-only: touches no Redis and makes no mutations.
 *
 * Returns { configured:false } until FACTSET_RELAY_URL + FACTSET_RELAY_SECRET
 * are set in Vercel (i.e. until the relay is live), so it's safe to deploy now.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;

  if (!factsetConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      hint: "Set FACTSET_RELAY_URL and FACTSET_RELAY_SECRET in Vercel env once the relay is live, then retry.",
    });
  }

  const ids = (sp.get("ids") || "AAPL-US")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Note: this simple probe splits formulas on commas, so pass formulas without
  // inner commas (P_PRICE, P_BETA, FG_PE, ...). For comma-bearing formulas use
  // the lib directly.
  const formulas = (sp.get("formulas") || FACTSET_FORMULAS.price)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const [health, data] = await Promise.all([relayHealthy(), crossSectional(ids, formulas)]);
    return NextResponse.json({ ok: true, configured: true, relayHealthy: health, ids, formulas, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
