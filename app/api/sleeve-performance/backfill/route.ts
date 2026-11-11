import { NextRequest, NextResponse } from "next/server";
import { backfillSleeveHistory, readSleevePerformance } from "@/app/lib/sleeve-performance";

/**
 * GET  /api/sleeve-performance/backfill — dry run: what each sleeve would
 *      receive from the existing pm:pim-performance series. Read-only.
 * POST /api/sleeve-performance/backfill { confirm: "BACKFILL" } — apply it.
 *      Stashes pm:sleeve-performance at .pre-backfill-<ts> first; only adds
 *      history BEFORE tracking start; pm:pim-performance is read-only.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await backfillSleeveHistory(false));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "BACKFILL") return NextResponse.json({ error: 'send { confirm: "BACKFILL" }' }, { status: 400 });
  const out = await backfillSleeveHistory(true);
  return NextResponse.json({ ...out, data: await readSleevePerformance() }, { status: out.ok ? 200 : 422 });
}
