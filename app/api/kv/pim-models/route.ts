import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { pimModelSeed } from "@/app/lib/pim-seed";

const KEY = "pm:pim-models";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      const seed = { groups: pimModelSeed, lastUpdated: new Date().toISOString() };
      await redis.set(KEY, JSON.stringify(seed));
      return NextResponse.json(seed);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(raw) as any;
    // Migrate: rename "Base" → "PIM" in cached data
    let migrated = false;
    if (parsed.groups) {
      for (const g of parsed.groups) {
        if (g.id === "base" || (g.id === "pim" && g.name === "Base")) {
          g.id = "pim";
          g.name = "PIM";
          migrated = true;
        }
      }
    }
    if (migrated) {
      await redis.set(KEY, JSON.stringify(parsed));
    }
    return NextResponse.json(parsed);
  } catch (e) {
    console.error("Redis read error (pim-models):", e);
    return NextResponse.json({ groups: pimModelSeed, lastUpdated: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const data = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-models):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
