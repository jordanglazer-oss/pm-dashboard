import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { getRedis } from "@/app/lib/redis";
import {
  UNIVERSE_KEY,
  UNIVERSE_NAMES_KEY,
  type FactorUniverse,
  type UniverseNames,
} from "@/app/lib/factor-universe";
import { FACTOR_WEIGHTS, percentileFromGroups } from "@/app/lib/factors";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import { REGIME_KEY } from "@/app/lib/market-regime-refresh";
import { REGIME_TILTS, type RadarName, type RadarPayload, type RadarSector } from "@/app/lib/radar";

/**
 * GET /api/radar — the proactive screening read: names from OUR OWN factor
 * model (FactSet fundamentals, sector-neutral z-scores) that look attractive
 * under the CURRENT market regime, plus a sector-momentum heat strip.
 *
 * Deliberately separate from the Suggested Watchlist (research-list
 * confluence): Radar is 100% self-computed, so it can nominate a name before
 * any analyst list publishes it. The two surfaces may be merged later once
 * the read has earned trust.
 *
 * Everything is derived on read — READ-ONLY against four existing keys
 * (pm:factor-universe-names, pm:factor-universe, pm:market-regime, pm:stocks).
 * Writes nothing. Zero FactSet / Anthropic spend.
 */

export const dynamic = "force-dynamic";

const log = createLogger("Radar");

/** Same ticker normalization as watchlist-candidates: -T → .TO only. No
 *  bare-symbol stripping — T (AT&T) must never collide with T.TO (Telus). */
const norm = (t: string) => t.toUpperCase().replace(/-T$/, ".TO");

function parse<T>(raw: string | null, fb: T): T {
  if (!raw) return fb;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fb;
  }
}

/** Median of an already-sorted-ascending array (universe distributions are
 *  stored sorted; winsorizing doesn't move the median). */
function median(sorted: number[] | undefined): number | null {
  if (!sorted || sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MAX_NAMES = 50;

export async function GET() {
  try {
    const redis = await getRedis();
    const [namesRaw, uniRaw, regimeRaw, stocksRaw] = await Promise.all([
      redis.get(UNIVERSE_NAMES_KEY),
      redis.get(UNIVERSE_KEY),
      redis.get(REGIME_KEY),
      redis.get("pm:stocks"),
    ]);

    const store = parse<UniverseNames | null>(namesRaw, null);
    if (!store || !Array.isArray(store.names) || store.names.length === 0) {
      const empty: RadarPayload = {
        ok: true,
        regime: null,
        weights: FACTOR_WEIGHTS,
        sectors: [],
        names: [],
        hint: "Factor universe not built yet — it populates after the weekly rebuild.",
      };
      return NextResponse.json(empty);
    }

    const regime = parse<MarketRegimeData | null>(regimeRaw, null);
    const label = regime?.composite?.label ?? "Neutral";
    const weights = REGIME_TILTS[label] ?? FACTOR_WEIGHTS;

    const stocks = parse<{ ticker?: string }[]>(stocksRaw, []);
    const owned = new Set(
      stocks.map((s) => (typeof s.ticker === "string" ? norm(s.ticker) : "")).filter(Boolean),
    );

    // Hard-distress names are excluded outright (a suggestion surface should
    // not nominate balance-sheet traps); grey-zone names stay, badged.
    const names: RadarName[] = store.names
      .filter((n) => !owned.has(norm(n.ticker)) && n.distress !== "distress")
      .map((n) => ({ ...n, regimeFit: percentileFromGroups(n.groups, weights) ?? n.quant }))
      .sort((a, b) => b.regimeFit - a.regimeFit)
      .slice(0, MAX_NAMES);

    const uni = parse<FactorUniverse | null>(uniRaw, null);
    const sectors: RadarSector[] = uni
      ? Object.entries(uni.sectors)
          .map(([sector, s]) => ({
            sector,
            n: s.n,
            medMom12: median(s.metrics.mom12_1),
            medMom6: median(s.metrics.mom6_1),
          }))
          .sort((a, b) => (b.medMom12 ?? -Infinity) - (a.medMom12 ?? -Infinity))
      : [];

    const payload: RadarPayload = {
      ok: true,
      builtAt: store.builtAt,
      regime: regime ? { label, computedAt: regime.computedAt } : null,
      weights,
      sectors,
      names,
    };
    return NextResponse.json(payload);
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "failed" },
      { status: 500 },
    );
  }
}
