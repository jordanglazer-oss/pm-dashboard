import { NextResponse } from "next/server";
import { readEquateSheet } from "@/app/lib/equate-store";

/**
 * GET /api/equate-ranks — the weekly RBC EQUATE composite ranks, both regions,
 * flattened for the Conviction board.
 *
 * Only the top decile is returned. The sheets hold ~1,660 names across the two
 * regions and the board only scores decile 1, so shipping the rest would be a
 * megabyte of payload that changes nothing on screen.
 *
 * Read-only.
 */
export async function GET() {
  const rows: { symbol: string; compositeRank: number; decile: number }[] = [];
  for (const region of ["us", "canada"] as const) {
    const sheet = await readEquateSheet(region, false);
    for (const r of sheet?.rows ?? []) {
      if (r.decile > 1) continue;
      rows.push({
        // Canadian symbols carry .TO everywhere else in the app.
        symbol: region === "canada" ? `${r.symbol}.TO` : r.symbol,
        compositeRank: r.compositeRank,
        decile: r.decile,
      });
    }
  }
  rows.sort((a, b) => a.compositeRank - b.compositeRank);
  return NextResponse.json({ rows, count: rows.length });
}
