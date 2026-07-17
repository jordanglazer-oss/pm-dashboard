import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { FACTOR_SCORES_KEY, type FactorScoreEntry } from "@/app/lib/factor-scores";

/**
 * Read-only accessor for the shadow factor scores (Phase B UI feed).
 *
 * Returns the latest per-ticker read-outs the nightly job wrote to
 * pm:factor-scores. Cookie-gated like every other authenticated route.
 * Pure GET — never computes, never writes, never touches the 41-pt score.
 *
 *   GET /api/factor-scores  → { ok, builtAt, entries: { TICKER: {...} } }
 *
 * Missing key → empty payload (never seeds defaults), same contract as the
 * pm:* KV GET routes.
 */

export const dynamic = "force-dynamic";

type Snapshot = { builtAt?: string; entries?: Record<string, FactorScoreEntry> };

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(FACTOR_SCORES_KEY);
    if (!raw) return NextResponse.json({ ok: true, builtAt: null, entries: {} });
    const snap = JSON.parse(raw) as Snapshot;
    return NextResponse.json({ ok: true, builtAt: snap.builtAt ?? null, entries: snap.entries ?? {} });
  } catch {
    return NextResponse.json({ ok: true, builtAt: null, entries: {} });
  }
}
