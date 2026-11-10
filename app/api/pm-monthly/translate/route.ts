import { NextRequest, NextResponse } from "next/server";
import { translateToFrench } from "@/app/lib/pm-monthly-write";

/**
 * POST /api/pm-monthly/translate { month, en } — re-translate the (edited)
 * English into the house French (main key, Sonnet, no search, ~5¢).
 * Writes nothing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: string; en?: string };
  if (!body.month || !/^\d{4}-\d{2}$/.test(body.month) || !body.en?.trim()) return NextResponse.json({ error: "month and en required" }, { status: 400 });
  try {
    return NextResponse.json({ fr: await translateToFrench(body.en.slice(0, 20000), body.month) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "translation failed" }, { status: 500 });
  }
}
