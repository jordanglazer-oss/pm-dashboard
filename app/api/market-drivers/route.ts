import { NextRequest, NextResponse } from "next/server";
import { getMarketDrivers } from "@/app/lib/market-drivers";

/**
 * GET /api/market-drivers            → cached pm:market-drivers (rebuilt when
 *                                      older than 20h)
 * GET /api/market-drivers?refresh=1  → force a FactSet rebuild (~15-30s)
 *
 * Pure regenerable cache — see app/lib/market-drivers.ts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const drivers = await getMarketDrivers({ refresh });
  return NextResponse.json({ drivers });
}
