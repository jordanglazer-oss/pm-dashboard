import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { mergeTradeLog, type StateBody } from "@/app/lib/kv-merge";

const KEY = "pm:pim-portfolio-state";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      return NextResponse.json({ groupStates: [], lastUpdated: null });
    }
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (pim-portfolio-state):", e);
    return NextResponse.json({ groupStates: [], lastUpdated: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    // Shape guard: must be an object with a 'groupStates' array. This blob
    // holds per-group transactions and rebalance snapshots — losing it
    // means losing the entire trade history. Reject anything malformed.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.error("[pm:pim-portfolio-state PUT] Rejected non-object body:", typeof data);
      return NextResponse.json(
        { error: "pm:pim-portfolio-state body must be an object with a 'groupStates' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((data as any).groupStates)) {
      console.error("[pm:pim-portfolio-state PUT] Rejected body missing 'groupStates' array");
      return NextResponse.json(
        { error: "pm:pim-portfolio-state body must include a 'groupStates' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    // The trade log only ever GROWS from the browser: a settle replaces a
    // pending entry under the same id, nothing deletes one. So a body that is
    // missing a stored group, or missing stored transactions inside a group,
    // comes from a tab that never loaded them (failed load) or loaded them
    // before a server-side write (a staged rebalance). Keep what is stored
    // rather than let that tab erase it.
    const storedRaw = await redis.get(KEY);
    const { merged, keptGroups, keptTransactions } = mergeTradeLog(storedRaw, data as StateBody);
    if (keptGroups > 0 || keptTransactions > 0) {
      console.warn(`[pm:pim-portfolio-state PUT] kept ${keptGroups} group(s) and ${keptTransactions} transaction(s) missing from the body`);
    }
    await redis.set(KEY, JSON.stringify(merged));
    return NextResponse.json({ ok: true, keptGroups, keptTransactions });
  } catch (e) {
    console.error("Redis write error (pim-portfolio-state):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
