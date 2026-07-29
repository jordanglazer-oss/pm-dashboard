import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { UNIVERSE_NAMES_KEY, type UniverseNames } from "@/app/lib/factor-universe";

/**
 * Universe screen feed (idea-generation layer). Returns the per-name quant
 * read-outs + distress flags for the whole ~540-name universe, written by the
 * weekly universe finalize. Cookie-gated, read-only, empty on missing key —
 * the client decides how to filter (e.g. exclude owned names).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(UNIVERSE_NAMES_KEY);
    if (!raw) return NextResponse.json({ ok: true, builtAt: null, names: [] });
    const snap = JSON.parse(raw) as UniverseNames;
    return NextResponse.json({ ok: true, builtAt: snap.builtAt ?? null, names: snap.names ?? [] });
  } catch {
    return NextResponse.json({ ok: true, builtAt: null, names: [] });
  }
}
