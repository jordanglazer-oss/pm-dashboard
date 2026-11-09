import { NextRequest, NextResponse } from "next/server";
import { loadFundRows, loadOnePagers, saveOnePager } from "@/app/lib/fund-one-pagers";

/**
 * GET  /api/fund-one-pagers — every fund / ETF in the PIM model with its
 *      stored facts, plus the signed one-pagers. Read-only.
 * POST /api/fund-one-pagers { symbol, pager } — the PM signs ONE fund's page
 *      (read-merge-write of that symbol in pm:fund-one-pagers; prior version
 *      kept in its history). Nothing else is touched.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const [funds, store] = await Promise.all([loadFundRows(), loadOnePagers()]);
  return NextResponse.json({ funds, pagers: store.pagers });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { symbol?: unknown; pager?: unknown };
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9.\-]{1,16}$/.test(symbol)) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!body.pager || typeof body.pager !== "object") return NextResponse.json({ error: "pager required" }, { status: 400 });
  try {
    return NextResponse.json({ pager: await saveOnePager(symbol, body.pager as Record<string, unknown>) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}
