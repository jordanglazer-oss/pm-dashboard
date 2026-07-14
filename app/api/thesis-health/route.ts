import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import {
  THESIS_STALE_MS,
  readThesisCache,
  rebuildThesisHealth,
} from "@/app/lib/thesis-health-refresh";

/**
 * GET /api/thesis-health — automated per-holding thesis verdicts (Phase 03).
 *
 * Reads pm:stocks (Portfolio names + risk level), pm:score-history (composite
 * trend) and pm:analyst-snapshots (FactSet FY+1 revisions) — all READ-ONLY —
 * and rolls them into intact / eroding / broken per name. Caches the result in
 * pm:thesis-health (regenerable cache; safe to nuke). No live data mutated.
 *
 * The rebuild lives in app/lib/thesis-health-refresh.ts so the nightly cron can
 * run it too (the alert digest needs same-day verdicts).
 *
 * ?refresh=1 forces a rebuild (6h freshness otherwise, since the inputs update
 * roughly daily).
 */

const log = createLogger("ThesisHealth");

export async function GET(req: NextRequest) {
  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";

  const cached = await readThesisCache();
  const fresh = cached?.builtAt && Date.now() - new Date(cached.builtAt).getTime() < THESIS_STALE_MS;
  if (fresh && !forceRefresh) return NextResponse.json({ thesisHealth: cached, cached: true });

  try {
    const thesisHealth = await rebuildThesisHealth();
    return NextResponse.json({ thesisHealth, cached: false });
  } catch (e) {
    log.error("rebuild failed:", e);
    if (cached) return NextResponse.json({ thesisHealth: cached, cached: true, stale: true });
    return NextResponse.json({ thesisHealth: null, error: "unavailable" }, { status: 503 });
  }
}
