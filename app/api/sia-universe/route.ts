import { NextRequest, NextResponse } from "next/server";
import { latestSiaMovers, writeSiaSnapshot, type SiaRow } from "@/app/lib/sia-universe";

/**
 * SIA universe snapshots.
 *
 *   GET  /api/sia-universe?minWChg=&minSmax=  → this week's rank climbers
 *   POST /api/sia-universe { rows }            → store the newest export
 *
 * POST is used by the Inbox page's CSV upload (which parses client-side); the
 * emailed-CSV path calls the lib directly from inbox-dispatch. Both land in
 * the same single latest-only key — see app/lib/sia-universe.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const n = (k: string, d: number) => { const v = Number(sp.get(k)); return Number.isFinite(v) ? v : d; };
    const movers = await latestSiaMovers({ minWChg: n("minWChg", 20), minSmax: n("minSmax", 7) });
    return NextResponse.json(movers);
  } catch (e) {
    console.error("sia-universe GET failed:", e);
    // Read-only surface: degrade to empty rather than erroring the page.
    return NextResponse.json({ date: null, movers: [], universeSize: 0 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw = body?.rows;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "rows object required" }, { status: 400 });
    }
    const rows: Record<string, SiaRow> = {};
    for (const [t, v] of Object.entries(raw as Record<string, unknown>)) {
      if (t && v && typeof v === "object") rows[t.toUpperCase()] = v as SiaRow;
    }
    return NextResponse.json(await writeSiaSnapshot(rows));
  } catch (e) {
    console.error("sia-universe POST failed:", e);
    return NextResponse.json({ error: "snapshot write failed" }, { status: 500 });
  }
}
