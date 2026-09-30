import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { defaultResearch } from "@/app/lib/defaults";

const KEY = "pm:research";

/** Sector-view fields owned by the stamp in `sectorViewsAt`. */
const SECTOR_FIELDS = ["newtonSectors", "leeSectors", "sectorViewsAt", "sectorViewsMonthlyAt", "sectorViewLog"] as const;

/**
 * The Research page PUTs the WHOLE blob from the state it loaded. Sector views
 * are also written server-side (monthly screenshot + daily-note changes, see
 * app/lib/sector-views.ts), so a tab opened before one of those writes would
 * roll it back on its next unrelated edit. When the stored `sectorViewsAt` is
 * newer than the incoming one, keep the stored sector fields; everything else
 * in the body is written exactly as before.
 */
async function keepNewerSectorViews(
  redis: Awaited<ReturnType<typeof getRedis>>,
  incoming: unknown,
): Promise<unknown> {
  if (!incoming || typeof incoming !== "object") return incoming;
  const raw = await redis.get(KEY);
  if (!raw) return incoming;
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(raw); } catch { return incoming; }
  const storedAt = typeof stored.sectorViewsAt === "string" ? stored.sectorViewsAt : "";
  const inc = incoming as Record<string, unknown>;
  const incAt = typeof inc.sectorViewsAt === "string" ? inc.sectorViewsAt : "";
  if (!storedAt || incAt >= storedAt) return incoming;
  const merged: Record<string, unknown> = { ...inc };
  for (const f of SECTOR_FIELDS) {
    if (f in stored) merged[f] = stored[f];
    else delete merged[f];
  }
  return merged;
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Per CLAUDE.md: NEVER seed Redis on read. If a stale client later PUTs
    // its in-memory defaults, the seed would overwrite whatever was there.
    // Return defaults in-memory only; the first user PUT creates the key.
    if (!raw) return NextResponse.json({ research: defaultResearch });
    return NextResponse.json({ research: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (research):", e);
    return NextResponse.json({ research: defaultResearch });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { research } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(await keepNewerSectorViews(redis, research)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (research):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
