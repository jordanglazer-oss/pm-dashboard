import { NextResponse } from "next/server";
import { buildHoldingHistories } from "@/app/lib/holding-history";

/**
 * GET /api/holding-history — every PIM holding (and every name sold out of
 * it) with its return since first purchase and each later buy / sell
 * decision from the trade log. READ-ONLY: reads pm:pim-portfolio-state /
 * pm:pim-models / pm:stocks and Yahoo / Barchart prices; stores nothing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await buildHoldingHistories());
  } catch (e) {
    return NextResponse.json({ holdings: [], trackingStart: null, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
