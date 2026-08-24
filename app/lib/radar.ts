import { FACTOR_WEIGHTS } from "./factors";
import type { UniverseName } from "./factor-universe";

/**
 * Radar — shared shapes + regime-tilt weights for the proactive screening
 * surface (/api/radar + RadarScreen). Pure constants/types, no I/O.
 *
 * The tilts re-blend each universe name's stored factor-GROUP z's under
 * regime-dependent weights: Risk-On leans momentum/growth (ride what works),
 * Risk-Off leans quality/valuation (own what survives), Neutral is the v1
 * baseline. The label comes from the ONE canonical regime source
 * (pm:market-regime composite) — no divergent regime calc here.
 */

/** Regime label → factor-group weights. Neutral = the v1 baseline weights. */
export const REGIME_TILTS: Record<string, Record<string, number>> = {
  "Risk-On": { quality: 0.25, growth: 0.25, valuation: 0.1, momentum: 0.4 },
  Neutral: FACTOR_WEIGHTS,
  "Risk-Off": { quality: 0.4, growth: 0.1, valuation: 0.3, momentum: 0.2 },
};

export type RadarName = UniverseName & { regimeFit: number };

export type RadarSector = {
  sector: string;
  n: number;
  medMom12: number | null;
  medMom6: number | null;
};

export type RadarPayload = {
  ok: boolean;
  builtAt?: string;
  regime: { label: string; computedAt: string } | null;
  weights: Record<string, number>;
  sectors: RadarSector[];
  names: RadarName[];
  hint?: string;
};
