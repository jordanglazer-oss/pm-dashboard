import { NextRequest, NextResponse } from "next/server";
import { computeSiaMovement, listSiaSnapshots, writeSiaSnapshot } from "@/app/lib/sia-universe";

/**
 * SIA universe snapshots.
 *
 *   GET  /api/sia-universe?minDelta=2  → week-over-week SMAX movement
 *   POST /api/sia-universe { rows }    → store today's universe snapshot
 *
 * POST is used by the Inbox page's CSV upload (which parses client-side); the
 * emailed-CSV path calls the lib directly from inbox-dispatch. Both land in
 * the same append-only store, which refuses to overwrite an existing date and
 * refuses sub-universe row counts — see app/lib/sia-universe.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const raw = Number(new URL(req.url).searchParams.get("minDelta"));
    const minDelta = Number.isFinite(raw) && raw > 0 ? raw : 2;
    const [movement, snapshots] = await Promise.all([computeSiaMovement(minDelta), listSiaSnapshots()]);
    return NextResponse.json({ movement, snapshots });
  } catch (e) {
    console.error("sia-universe GET failed:", e);
    // Read-only surface: degrade to empty rather than erroring the page.
    return NextResponse.json({
      movement: { from: null, to: null, risers: [], fallers: [], added: [] },
      snapshots: [],
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw = body?.rows;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "rows object required" }, { status: 400 });
    }
    const rows: Record<string, number> = {};
    for (const [t, v] of Object.entries(raw as Record<string, unknown>)) {
      const smax = typeof v === "number" ? v : Number(v);
      if (t && Number.isFinite(smax)) rows[t.toUpperCase()] = smax;
    }
    return NextResponse.json(await writeSiaSnapshot(rows));
  } catch (e) {
    console.error("sia-universe POST failed:", e);
    return NextResponse.json({ error: "snapshot write failed" }, { status: 500 });
  }
}
