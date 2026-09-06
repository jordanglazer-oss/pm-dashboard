import { NextResponse } from "next/server";
import { readRegimeHistory } from "@/app/lib/regime-history";

/**
 * GET /api/kv/regime-history → { rows: RegimeHistoryRow[] } ascending by date.
 *
 * READ-ONLY. The engine (app/lib/market-regime-refresh.ts) is the only writer
 * of `pm:regime-history`; there is deliberately no PUT/POST/DELETE here — the
 * store is append-only + date-guarded and clients must not be able to rewrite
 * it. Returns { rows: [] } on miss or read error (never seeds).
 */
export async function GET() {
  const rows = await readRegimeHistory();
  return NextResponse.json({ rows });
}
