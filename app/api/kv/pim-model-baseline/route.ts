/**
 * GET/PUT /api/kv/pim-model-baseline
 *
 * Reference baseline for the PIM model definitions: per-group profile
 * allocations (FI/equity/alt), cad/usd split, and the SEED holdings list
 * (with their intended weightInClass values). Drives the rebalance math
 * and Alpha-weight restoration — it is the source of truth for "what
 * should this model look like before any drift". The live working copy
 * (with current weights after user edits) lives in `pm:pim-models`.
 *
 * Designed so that callers can fall back to the in-repo `pim-seed.ts`
 * when Redis is unavailable, but the normal path reads here. The
 * migration endpoint /api/admin/migrate-pim-baseline-to-redis writes the
 * initial value from pim-seed.ts.
 *
 * GET returns `{ baseline: null }` if the key is missing — callers should
 * treat null as "use seed fallback" rather than as an error. Never seeds
 * the key automatically: the migration endpoint is the only path that
 * writes from the in-repo seed, by design (per CLAUDE.md persistence rules).
 */

import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

const KEY = "pm:pim-model-baseline";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ baseline: null });
    return NextResponse.json({ baseline: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (pim-model-baseline):", e);
    return NextResponse.json({ baseline: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || !Array.isArray(body.groups)) {
      return NextResponse.json(
        { error: "Body must be an object with a 'groups' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(body));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (pim-model-baseline):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
