import { getRedis } from "@/app/lib/redis";
import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import {
  computeRegimeTransition,
  applyTransitionHysteresis,
  type TransitionHysteresisState,
} from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";

/**
 * GET /api/regime-transition — the forward regime-transition gauge (Phase 02),
 * now hysteresis-smoothed (Phase 05).
 *
 * Derivation of the cached pm:market-regime snapshot, with a ratchet on the
 * likelihood tier so the transition WEIGHT that blends the forward score
 * doesn't flip-flop on boundary noise. The ratchet needs one small persisted
 * state key, pm:regime-transition-state (a regenerable cache — safe to nuke;
 * next GET rebuilds it). Upgrades commit immediately; a downgrade only commits
 * after 2 distinct regime snapshots read weaker. Returns { transition } or
 * { transition: null } when no regime snapshot is cached yet.
 */

const log = createLogger("RegimeTransition");
const STATE_KEY = "pm:regime-transition-state";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:market-regime");
    if (!raw) return NextResponse.json({ transition: null });
    const regime = JSON.parse(raw) as MarketRegimeData;
    if (!regime?.composite) return NextResponse.json({ transition: null });

    const rawTransition = computeRegimeTransition(regime);

    // Load the prior committed tier and apply the ratchet. Tolerate a missing
    // or malformed state (treat as no prior → first reading commits as-is).
    let prior: TransitionHysteresisState | null = null;
    try {
      const priorRaw = await redis.get(STATE_KEY);
      if (priorRaw) prior = JSON.parse(priorRaw) as TransitionHysteresisState;
    } catch {
      prior = null;
    }

    const { transition, state, changed } = applyTransitionHysteresis(rawTransition, prior);
    // Only write when the smoothing state actually advanced, so repeat page
    // loads within one snapshot window don't churn Redis.
    if (changed) {
      await redis.set(STATE_KEY, JSON.stringify(state));
    }

    return NextResponse.json({ transition });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ transition: null });
  }
}
