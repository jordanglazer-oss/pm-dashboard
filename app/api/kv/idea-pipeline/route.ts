import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { IDEA_PIPELINE_KEY, type IdeaPipelineStore, type IdeaPipelineEntry } from "@/app/lib/idea-pipeline";

/**
 * Idea-pipeline store. GET returns the whole map ({} on miss/error — never seed
 * defaults). PUT { entries } MERGES: each incoming entry upserts by key, but the
 * original firstSurfaced / priceAtSurface are preserved once set, so re-surfacing
 * an idea never resets its surfacing point. Nothing is ever removed here.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(IDEA_PIPELINE_KEY);
    return NextResponse.json(raw ? (JSON.parse(raw) as IdeaPipelineStore) : {});
  } catch {
    return NextResponse.json({});
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const incoming = (body?.entries ?? {}) as Record<string, Partial<IdeaPipelineEntry>>;
    if (!incoming || typeof incoming !== "object") {
      return NextResponse.json({ ok: false, error: "entries object required" }, { status: 400 });
    }

    const redis = await getRedis();
    const raw = await redis.get(IDEA_PIPELINE_KEY);
    const store: IdeaPipelineStore = raw ? JSON.parse(raw) : {};

    let changed = 0;
    for (const [key, e] of Object.entries(incoming)) {
      const k = key.toUpperCase().trim();
      if (!k || !e || typeof e !== "object" || !e.ticker || !e.status) continue;
      const prev = store[k];
      store[k] = {
        ticker: e.ticker,
        status: e.status,
        sources: Array.isArray(e.sources) ? e.sources : (prev?.sources ?? []),
        updatedAt: new Date().toISOString(),
        // Immutable once set — the surfacing point can't be rewritten.
        firstSurfaced: prev?.firstSurfaced ?? e.firstSurfaced ?? new Date().toISOString().slice(0, 10),
        priceAtSurface: prev?.priceAtSurface ?? e.priceAtSurface,
      };
      changed += 1;
    }
    await redis.set(IDEA_PIPELINE_KEY, JSON.stringify(store));
    return NextResponse.json({ ok: true, changed });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
