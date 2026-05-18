import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:analyst-snapshots";

// Force-dynamic ensures the Inbox tab's Coverage Checklist sees fresh
// FactSet target data on every Refresh — without this, Next's default
// route caching could serve a stale snapshot.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ snapshots: {} });
    return NextResponse.json({ snapshots: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (analyst-snapshots):", e);
    return NextResponse.json({ snapshots: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { snapshots } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(snapshots));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (analyst-snapshots):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
