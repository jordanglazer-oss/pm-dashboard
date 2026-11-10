import { NextRequest, NextResponse } from "next/server";
import { loadMonthlyDraft, saveMonthlyDraft } from "@/app/lib/pm-monthly-drafts";

/**
 * GET  /api/pm-monthly?month=YYYY-MM — that month's saved draft (or null).
 * POST /api/pm-monthly { month, en?, fr?, notes?, aiDrafted?, sources? } —
 *      save ONE month (read-merge-write; previous text kept in its history).
 */

export const dynamic = "force-dynamic";
const MONTH = /^\d{4}-\d{2}$/;

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return NextResponse.json({ error: "month required" }, { status: 400 });
  return NextResponse.json({ draft: await loadMonthlyDraft(month) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { month?: string; en?: string; fr?: string; notes?: string; aiDrafted?: boolean; sources?: { url: string; title?: string }[] };
  if (!body.month || !MONTH.test(body.month)) return NextResponse.json({ error: "month required" }, { status: 400 });
  try {
    const sources = Array.isArray(body.sources) ? body.sources.filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url)).slice(0, 20) : undefined;
    return NextResponse.json({ draft: await saveMonthlyDraft(body.month, { en: body.en, fr: body.fr, notes: body.notes, aiDrafted: typeof body.aiDrafted === "boolean" ? body.aiDrafted : undefined, sources }) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}
