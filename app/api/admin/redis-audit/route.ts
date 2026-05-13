import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimPerformanceData,
  AppendixData,
  PimPortfolioState,
  PimPortfolioPositions,
  PimProfileType,
} from "@/app/lib/pim-types";
import type { Stock } from "@/app/lib/types";

/**
 * GET /api/admin/redis-audit
 *
 * Read-only spot-check that all the recent feature work is persisted
 * to Redis (vs. being device-local, in-memory, or otherwise transient).
 * Returns a structured report of every relevant pm:* key:
 *
 *   - Existence (key found vs missing)
 *   - Approximate size
 *   - Expected-shape spot-checks (e.g., does the Alpha series have
 *     anchored:true flags after the SIA import? Does (pim, core)
 *     exist in both pm:pim-performance and pm:pim-positions?)
 *   - Count of stash keys (pre-import, pre-anchor, pre-rollback)
 *
 * Anything missing or unexpected gets a "flag" in the response so it's
 * easy to spot. All read-only — no writes.
 */

type AuditEntry = {
  key: string;
  exists: boolean;
  approxSizeBytes: number;
  checks: Array<{ name: string; pass: boolean; note?: string }>;
};

export async function GET() {
  try {
    const redis = await getRedis();

    const entries: AuditEntry[] = [];

    // ── pm:pim-performance ────────────────────────────────────────
    {
      const raw = await redis.get("pm:pim-performance");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const perf = JSON.parse(raw) as PimPerformanceData;
          checks.push({ name: "valid JSON", pass: true });
          const profiles = ["balanced", "growth", "allEquity", "alpha", "core"] as PimProfileType[];
          for (const p of profiles) {
            const m = perf.models.find((m) => m.groupId === "pim" && m.profile === p);
            if (!m) {
              checks.push({ name: `(pim, ${p}) series present`, pass: false, note: "missing" });
            } else {
              const len = m.history.length;
              const last = m.history[len - 1];
              const anchoredCount = m.history.filter((h) => h.anchored).length;
              checks.push({
                name: `(pim, ${p}) series present`,
                pass: true,
                note: `${len} entries, last=${last?.date} val=${last?.value}, anchored=${anchoredCount}`,
              });
            }
          }
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:pim-performance",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── pm:appendix-daily-values ──────────────────────────────────
    {
      const raw = await redis.get("pm:appendix-daily-values");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const app = JSON.parse(raw) as AppendixData;
          checks.push({ name: "valid JSON", pass: true });
          for (const p of ["balanced", "growth", "allEquity", "alpha"] as PimProfileType[]) {
            const l = app.ledgers.find((l) => l.profile === p);
            if (!l) {
              checks.push({ name: `${p} ledger present`, pass: false, note: "missing" });
            } else {
              const len = l.entries.length;
              const last = l.entries[len - 1];
              const anchoredCount = l.entries.filter((e) => (e as { anchored?: boolean }).anchored).length;
              checks.push({
                name: `${p} ledger present`,
                pass: true,
                note: `${len} entries, last=${last?.date} val=${last?.value}, anchored=${anchoredCount}`,
              });
            }
          }
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:appendix-daily-values",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── pm:pim-positions (look for (pim, core) specifically) ─────
    {
      const raw = await redis.get("pm:pim-positions");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const blob = JSON.parse(raw) as { portfolios: PimPortfolioPositions[] };
          checks.push({ name: "valid JSON", pass: true });
          for (const p of ["balanced", "growth", "allEquity", "alpha", "core"] as PimProfileType[]) {
            const port = blob.portfolios.find((port) => port.groupId === "pim" && port.profile === p);
            if (!port) {
              const ok = p !== "core"; // pre-Core models always exist; core only after seed
              checks.push({ name: `(pim, ${p}) positions present`, pass: ok, note: ok ? "(optional)" : "missing" });
            } else {
              checks.push({
                name: `(pim, ${p}) positions present`,
                pass: true,
                note: `${port.positions.length} positions, cash=${port.cashBalance}`,
              });
            }
          }
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:pim-positions",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── pm:stocks (designation tagging) ───────────────────────────
    {
      const raw = await redis.get("pm:stocks");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const stocks = JSON.parse(raw) as Stock[];
          checks.push({ name: "valid JSON", pass: true });
          const coreCount = stocks.filter((s) => s.designation === "core").length;
          const alphaCount = stocks.filter((s) => s.designation === "alpha").length;
          const unsetCount = stocks.filter((s) => !s.designation).length;
          checks.push({
            name: "designations tallied",
            pass: true,
            note: `total=${stocks.length}, core=${coreCount}, alpha=${alphaCount}, unset=${unsetCount}`,
          });
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:stocks",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── pm:pim-models (Core profile presence) ────────────────────
    {
      const raw = await redis.get("pm:pim-models");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const data = JSON.parse(raw) as { groups: Array<{ id: string; holdings: unknown[] }> };
          checks.push({ name: "valid JSON", pass: true });
          const pimGroup = data.groups.find((g) => g.id === "pim");
          checks.push({
            name: "PIM group present",
            pass: !!pimGroup,
            note: pimGroup ? `${pimGroup.holdings.length} holdings` : "missing",
          });
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:pim-models",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── pm:pim-portfolio-state (rebalance dates) ─────────────────
    {
      const raw = await redis.get("pm:pim-portfolio-state");
      const checks: AuditEntry["checks"] = [];
      if (raw) {
        try {
          const state = JSON.parse(raw) as PimPortfolioState;
          checks.push({ name: "valid JSON", pass: true });
          const pim = state.groupStates.find((gs) => gs.groupId === "pim");
          checks.push({
            name: "PIM group state present",
            pass: !!pim,
            note: pim?.lastRebalance ? `lastRebalance=${pim.lastRebalance.date.slice(0, 10)}` : "no lastRebalance",
          });
        } catch {
          checks.push({ name: "valid JSON", pass: false, note: "JSON parse failed" });
        }
      }
      entries.push({
        key: "pm:pim-portfolio-state",
        exists: !!raw,
        approxSizeBytes: raw?.length ?? 0,
        checks,
      });
    }

    // ── Stash keys (rollback safety net) ─────────────────────────
    const stashKeys = await redis.keys("pm:*.pre-*");
    const stashSummary = {
      total: stashKeys.length,
      preImport: stashKeys.filter((k) => k.includes(".pre-import-")).length,
      preAnchor: stashKeys.filter((k) => k.includes(".pre-anchor-")).length,
      preRecompute: stashKeys.filter((k) => k.includes(".pre-recompute-")).length,
      preRollback: stashKeys.filter((k) => k.includes(".pre-rollback-")).length,
      preSeedCore: stashKeys.filter((k) => k.includes(".pre-seed-core-")).length,
    };

    // Overall verdict.
    const failedChecks = entries.flatMap((e) => e.checks.filter((c) => !c.pass).map((c) => `${e.key} · ${c.name}: ${c.note ?? "fail"}`));

    return NextResponse.json({
      ok: failedChecks.length === 0,
      generatedAt: new Date().toISOString(),
      summary: {
        keysAudited: entries.length,
        failedChecks: failedChecks.length,
        flags: failedChecks,
      },
      entries,
      stashSummary,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
