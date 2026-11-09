import { NextRequest, NextResponse } from "next/server";
import { buildMonthFacts } from "@/app/lib/pm-monthly-data";

/**
 * GET /api/pm-monthly/facts?month=YYYY-MM — the facts behind the PM Monthly
 * (model + index returns, contributors / detractors, activity, outlook
 * inputs). READ-ONLY; stores nothing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? "";
  try {
    return NextResponse.json({ facts: await buildMonthFacts(month) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
