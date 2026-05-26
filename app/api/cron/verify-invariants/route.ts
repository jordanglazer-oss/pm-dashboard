/**
 * Daily Redis invariant check.
 *
 * Runs at 06:30 UTC via Vercel cron (~30 min after the morning backup), so
 * each day's snapshot is verified shortly after it's written. Catches the
 * kind of silent corruption that started the 2026-05-25 incident — the
 * `pm:stocks` array→object swap — within hours instead of waiting for the
 * user to notice broken UI surfaces.
 *
 * Invariants checked (each is a hard structural assertion that should
 * NEVER be violated in normal operation):
 *
 *   pm:stocks               — must be an array
 *   pm:pim-models           — must be an object with a `groups` array of length ≥ 1
 *   pm:pim-models.groups[*] — each group's equity holdings must sum to 1.0 (±0.005)
 *   pm:pim-positions        — must be an object with a `portfolios` array
 *   pm:pim-portfolio-state  — must be an object with a `groupStates` array
 *   pm:client-portfolio     — if present, must be an object with a `positions` array
 *   pm:pim-model-baseline   — if present, must be an object with a `groups` array
 *
 * On failure: writes the violations to `pm:invariant-alerts:YYYY-MM-DD`
 * (overwrites any prior same-day alerts blob, so re-runs reset the state).
 * On success: deletes any existing same-day alerts blob (so a self-healing
 * issue doesn't leave a stale alert sitting around). Either way returns
 * the violations array in the response so you can hit the endpoint
 * manually and see results immediately.
 *
 * UI surfacing: a follow-up commit will read `pm:invariant-alerts:*` and
 * show a small banner in the nav if any same-day alerts exist. For now
 * this route is the source of truth — check it via:
 *   curl https://pm-dashboard-7rr9.vercel.app/api/cron/verify-invariants
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Security: same CRON_SECRET pattern as the backup route. /api/cron/* is
 * exempted from the auth-cookie middleware.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type Violation = {
  key: string;
  rule: string;
  detail: string;
};

async function checkInvariants(
  redis: Awaited<ReturnType<typeof getRedis>>,
): Promise<Violation[]> {
  const violations: Violation[] = [];

  // Helper: read & parse a key; returns null on missing or parse error.
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

  // pm:pim-models — must be { groups: [≥1 group] }, each equity class summing to 1.0
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
          // Per-group equity weight sum check
          for (const g of groups) {
            const group = g as {
              id?: string;
              holdings?: Array<{ assetClass?: string; weightInClass?: number }>;
            };
            if (!Array.isArray(group?.holdings)) continue;
            const equitySum = group.holdings
              .filter((h) => h.assetClass === "equity")
              .reduce((s, h) => s + (typeof h.weightInClass === "number" ? h.weightInClass : 0), 0);
            // Allow ±0.005 tolerance for rounding noise from rebalance writes
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

  // pm:pim-positions — must be { portfolios: [...] }
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

  // pm:pim-portfolio-state — must be { groupStates: [...] }
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

  // pm:client-portfolio — if present, must be { positions: [...] }
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

  // pm:pim-model-baseline — if present, must be { groups: [...] }
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

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET env var not configured" },
      { status: 500 },
    );
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const redis = await getRedis();
    const violations = await checkInvariants(redis);
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
      return NextResponse.json({ ok: true, status: "violations-found", count: violations.length, alertKey, violations });
    }

    // Healthy — clear any prior same-day alert blob so a self-resolving issue
    // doesn't leave a stale alert sitting around.
    await redis.del(alertKey);
    return NextResponse.json({ ok: true, status: "healthy", count: 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invariant check failed" },
      { status: 500 },
    );
  }
}
