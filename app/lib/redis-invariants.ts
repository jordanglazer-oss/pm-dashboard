/**
 * Shared invariant-check logic for the daily Redis structural assertions.
 *
 * Used by:
 *   - /api/cron/backup-redis     runs inline after each backup completes
 *   - /api/cron/verify-invariants standalone callable endpoint (also handy
 *                                   for manual ad-hoc checks via curl)
 *
 * Each Violation describes one rule that didn't hold. An empty array means
 * every key passed every check. The check is READ-ONLY — never mutates
 * any user-data key.
 */

import type { getRedis } from "./redis";

export type Violation = {
  key: string;
  rule: string;
  detail: string;
};

export async function checkInvariants(
  redis: Awaited<ReturnType<typeof getRedis>>,
): Promise<Violation[]> {
  const violations: Violation[] = [];

  const readJson = async (k: string): Promise<unknown | null> => {
    try {
      const raw = await redis.get(k);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      violations.push({
        key: k,
        rule: "parseable",
        detail: `JSON.parse threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      return null;
    }
  };

  // pm:stocks — must be an array
  {
    const v = await readJson("pm:stocks");
    if (v !== null && !Array.isArray(v)) {
      violations.push({
        key: "pm:stocks",
        rule: "must be an array",
        detail: `actual type: ${typeof v}${v === null ? " (null)" : ""}`,
      });
    }
  }

  // pm:pim-models — { groups: [non-empty] }, each group's equity weights sum to 1.0 (±0.005)
  {
    const v = await readJson("pm:pim-models");
    if (v !== null) {
      if (typeof v !== "object" || Array.isArray(v)) {
        violations.push({
          key: "pm:pim-models",
          rule: "must be an object",
          detail: `actual type: ${Array.isArray(v) ? "array" : typeof v}`,
        });
      } else {
        const groups = (v as { groups?: unknown }).groups;
        if (!Array.isArray(groups)) {
          violations.push({
            key: "pm:pim-models",
            rule: "must have a 'groups' array",
            detail: `groups type: ${typeof groups}`,
          });
        } else if (groups.length === 0) {
          violations.push({
            key: "pm:pim-models",
            rule: "groups array must be non-empty",
            detail: "groups.length === 0",
          });
        } else {
          for (const g of groups) {
            const group = g as {
              id?: string;
              holdings?: Array<{ assetClass?: string; weightInClass?: number }>;
            };
            if (!Array.isArray(group?.holdings)) continue;
            const equitySum = group.holdings
              .filter((h) => h.assetClass === "equity")
              .reduce((s, h) => s + (typeof h.weightInClass === "number" ? h.weightInClass : 0), 0);
            if (equitySum > 0 && Math.abs(equitySum - 1.0) > 0.005) {
              violations.push({
                key: "pm:pim-models",
                rule: `group '${group.id ?? "(no id)"}' equity weights must sum to 1.0 (±0.005)`,
                detail: `actual sum: ${equitySum.toFixed(6)}`,
              });
            }
          }
        }
      }
    }
  }

  // pm:pim-positions — { portfolios: [...] }
  {
    const v = await readJson("pm:pim-positions");
    if (v !== null) {
      if (typeof v !== "object" || Array.isArray(v)) {
        violations.push({
          key: "pm:pim-positions",
          rule: "must be an object",
          detail: `actual type: ${Array.isArray(v) ? "array" : typeof v}`,
        });
      } else if (!Array.isArray((v as { portfolios?: unknown }).portfolios)) {
        violations.push({
          key: "pm:pim-positions",
          rule: "must have a 'portfolios' array",
          detail: `portfolios type: ${typeof (v as { portfolios?: unknown }).portfolios}`,
        });
      }
    }
  }

  // pm:pim-portfolio-state — { groupStates: [...] }
  {
    const v = await readJson("pm:pim-portfolio-state");
    if (v !== null) {
      if (typeof v !== "object" || Array.isArray(v)) {
        violations.push({
          key: "pm:pim-portfolio-state",
          rule: "must be an object",
          detail: `actual type: ${Array.isArray(v) ? "array" : typeof v}`,
        });
      } else if (!Array.isArray((v as { groupStates?: unknown }).groupStates)) {
        violations.push({
          key: "pm:pim-portfolio-state",
          rule: "must have a 'groupStates' array",
          detail: `groupStates type: ${typeof (v as { groupStates?: unknown }).groupStates}`,
        });
      }
    }
  }

  // pm:client-portfolio — if present, { positions: [...] }
  {
    const v = await readJson("pm:client-portfolio");
    if (v !== null) {
      if (typeof v !== "object" || Array.isArray(v)) {
        violations.push({
          key: "pm:client-portfolio",
          rule: "must be an object",
          detail: `actual type: ${Array.isArray(v) ? "array" : typeof v}`,
        });
      } else if (!Array.isArray((v as { positions?: unknown }).positions)) {
        violations.push({
          key: "pm:client-portfolio",
          rule: "must have a 'positions' array",
          detail: `positions type: ${typeof (v as { positions?: unknown }).positions}`,
        });
      }
    }
  }

  // pm:pim-model-baseline — if present, { groups: [...] }
  {
    const v = await readJson("pm:pim-model-baseline");
    if (v !== null) {
      if (typeof v !== "object" || Array.isArray(v)) {
        violations.push({
          key: "pm:pim-model-baseline",
          rule: "must be an object",
          detail: `actual type: ${Array.isArray(v) ? "array" : typeof v}`,
        });
      } else if (!Array.isArray((v as { groups?: unknown }).groups)) {
        violations.push({
          key: "pm:pim-model-baseline",
          rule: "must have a 'groups' array",
          detail: `groups type: ${typeof (v as { groups?: unknown }).groups}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Write violations to pm:invariant-alerts:{date}, or clear that key if
 * the run was healthy. Returns the alert key for response/log reference.
 */
export async function persistInvariantResult(
  redis: Awaited<ReturnType<typeof getRedis>>,
  violations: Violation[],
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const alertKey = `pm:invariant-alerts:${today}`;
  if (violations.length > 0) {
    await redis.set(
      alertKey,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        violations,
      }),
    );
  } else {
    await redis.del(alertKey);
  }
  return alertKey;
}
