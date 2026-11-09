import { NextResponse } from "next/server";
import { readSleevePerformance, updateSleevePerformance } from "@/app/lib/sleeve-performance";

/**
 * GET  /api/sleeve-performance — the weights-based sleeve series (Core,
 *      Thematic, Stocks, Stocks + Thematic). Read-only; {} shape on miss.
 * POST /api/sleeve-performance — bring the series up to the last close now
 *      (also run by the weekday daily-value cron). Append-only: adds new
 *      days, never rewrites past ones; the first call starts every sleeve at
 *      100. Reads the PIM model READ-ONLY.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ data: await readSleevePerformance() });
}

export async function POST() {
  const out = await updateSleevePerformance();
  return NextResponse.json({ ...out, data: await readSleevePerformance() }, { status: out.ok ? 200 : 502 });
}
