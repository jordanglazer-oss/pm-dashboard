import { NextRequest, NextResponse } from "next/server";
import { buildMonthFacts } from "@/app/lib/pm-monthly-data";
import { draftEnglish, translateToFrench } from "@/app/lib/pm-monthly-write";

/**
 * POST /api/pm-monthly/draft { month, notes? } — Draft with AI: English from
 * the month's facts + the PM's notes + a short web check of the backdrop
 * (main key, Sonnet, ≤ 5 searches), then the French translation. ~20-30¢.
 * Writes NOTHING — the page saves once the PM has read it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: string; notes?: string };
  const month = body.month ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "month required" }, { status: 400 });
  try {
    const facts = await buildMonthFacts(month);
    const en = await draftEnglish(facts, typeof body.notes === "string" ? body.notes.slice(0, 6000) : "");
    if (!en.text) return NextResponse.json({ error: "the draft came back empty" }, { status: 502 });
    const fr = await translateToFrench(en.text, month);
    return NextResponse.json({ en: en.text, fr, sources: en.sources });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "draft failed" }, { status: 500 });
  }
}
