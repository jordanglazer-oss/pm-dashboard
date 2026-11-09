import { NextRequest, NextResponse } from "next/server";
import { reviewTheme } from "@/app/lib/agents/theme-review";

/**
 * POST /api/agents/theme-review { themeId } — review one theme now (the
 * Themes page's "Review now"). Agents key, budget-checked; writes only a
 * conversation flag. Never touches the book, the models or the theme.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { themeId?: unknown };
  const themeId = typeof body.themeId === "string" ? body.themeId.trim() : "";
  if (!themeId) return NextResponse.json({ error: "themeId required" }, { status: 400 });
  const out = await reviewTheme(themeId, "Review requested by the PM");
  return NextResponse.json(out, { status: out.ok ? 200 : 422 });
}
