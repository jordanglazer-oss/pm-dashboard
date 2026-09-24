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
    // Shape guard: pm:pim-models MUST be an object with a `groups` array.
    // The whole PIM rebalance pipeline assumes this — silently writing a
    // wrong shape would corrupt every model.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.error("[pm:pim-models PUT] Rejected non-object body:", typeof data);
      return NextResponse.json(
        { error: "pm:pim-models body must be an object with a 'groups' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((data as any).groups)) {
      console.error("[pm:pim-models PUT] Rejected body missing 'groups' array");
      return NextResponse.json(
        { error: "pm:pim-models body must include a 'groups' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    // Optimistic concurrency: every write stamps `revision`; a PUT carrying a
    // revision older than the stored one comes from a tab that has not seen a
    // newer model (a Review commit, a restore, another tab's trade) and would
    // silently roll it back. Refuse it and hand back the current model.
    const storedRaw = await redis.get(KEY);
    const stored = storedRaw ? (JSON.parse(storedRaw) as { revision?: number }) : null;
    const storedRev = typeof stored?.revision === "number" ? stored.revision : 0;
    const bodyRev = typeof (data as { revision?: unknown }).revision === "number" ? (data as { revision: number }).revision : null;
    if (storedRev > 0 && bodyRev !== null && bodyRev < storedRev) {
      console.warn(`[pm:pim-models PUT] stale revision ${bodyRev} < ${storedRev} — refused`);
      return NextResponse.json({ error: "stale", revision: storedRev, current: JSON.parse(storedRaw as string) }, { status: 409 });
    }
    const next = { ...(data as Record<string, unknown>), revision: storedRev + 1, lastUpdated: new Date().toISOString() };
    await redis.set(KEY, JSON.stringify(next));
    return NextResponse.json({ ok: true, revision: storedRev + 1 });
  } catch (e) {
    console.error("Redis write error (pim-models):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
