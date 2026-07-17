import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * Data-health sentinel — verifies that every input the morning digest (and the
 * dashboard) depends on is actually FRESH, and says so in one compact section
 * of the email. The failure mode this kills: something upstream silently stops
 * updating (a Yahoo change, a relay outage, a misconfigured cron) and you find
 * out days later from a wrong number. Now you find out from the next email.
 *
 * READ-ONLY over the freshness markers + core caches; writes only its own
 * pm:data-health marker (derived, safe to nuke). Runs in the cron AFTER the
 * refresh chain, immediately BEFORE the digest.
 */

const log = createLogger("DataHealth");

export const DATA_HEALTH_KEY = "pm:data-health";

export type DataHealthReport = {
  checkedAt: string;
  ok: boolean;
  /** Human lines, problems first. Rendered verbatim in the email. */
  lines: string[];
  problemCount: number;
};

type Check = { label: string; ok: boolean; detail: string };

function hoursAgo(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function fmtAge(h: number | null): string {
  if (h == null) return "never";
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function computeDataHealth(): Promise<DataHealthReport> {
  const checks: Check[] = [];
  try {
    const redis = await getRedis();
    const [estRaw, techRaw, regimeRaw, thesisRaw, outboxRaw, stocksRaw] = await Promise.all([
      redis.get("pm:estimates-refresh-status"),
      redis.get("pm:technicals-refresh-status"),
      redis.get("pm:market-regime"),
      redis.get("pm:thesis-health"),
      redis.get("pm:mail-outbox"),
      redis.get("pm:stocks"),
    ]);
    const parse = <T,>(raw: string | null): T | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    };

    // 1. FactSet estimates — ran recently AND resolved most of the book.
    const est = parse<{ lastRunAt?: string; tickerCount?: number; resolvedCount?: number; error?: string }>(estRaw);
    const estAge = hoursAgo(est?.lastRunAt);
    const estCoverageOk =
      est?.tickerCount != null && est?.resolvedCount != null && est.tickerCount > 0
        ? est.resolvedCount >= est.tickerCount * 0.6 // funds/FUNDSERV never resolve — 60% is the realistic floor
        : false;
    checks.push({
      label: "FactSet estimates",
      ok: estAge != null && estAge < 26 && !est?.error && estCoverageOk,
      detail: est
        ? `${est.resolvedCount ?? 0}/${est.tickerCount ?? 0} resolved, ${fmtAge(estAge)}${est.error ? ` — ${est.error}` : ""}`
        : "no status marker",
    });

    // 2. Technicals — ran recently and updated most of what it attempted.
    const tech = parse<{ lastRunAt?: string; considered?: number; updated?: number; earningsUpdated?: number; failed?: number; budgetExhausted?: boolean; error?: string }>(techRaw);
    const techAge = hoursAgo(tech?.lastRunAt);
    checks.push({
      label: "Technicals",
      ok: techAge != null && techAge < 26 && !tech?.error && (tech?.updated ?? 0) > 0,
      detail: tech
        ? `${tech.updated ?? 0}/${tech.considered ?? 0} updated${tech.budgetExhausted ? " (budget cut it short)" : ""}, ${fmtAge(techAge)}${tech.error ? ` — ${tech.error}` : ""}`
        : "no status marker (runs nightly as of this deploy)",
    });

    // 2b. Earnings calendar — the catalyst alerts + the post-earnings
    //     report-request email both key off earningsDate. If Yahoo's crumb dies
    //     this silently returns 0 forever, so check it explicitly.
    if (tech) {
      const eu = tech.earningsUpdated ?? 0;
      checks.push({
        label: "Earnings dates",
        ok: eu > 0,
        detail: eu > 0 ? `${eu} refreshed` : "0 refreshed — Yahoo calendarEvents/crumb may be failing (existing dates preserved)",
      });
    }

    // 3. Market regime — computed within the last day.
    const regime = parse<{ computedAt?: string; composite?: { label?: string } }>(regimeRaw);
    const regimeAge = hoursAgo(regime?.computedAt);
    checks.push({
      label: "Market regime",
      ok: regimeAge != null && regimeAge < 26,
      detail: regime ? `${regime.composite?.label ?? "?"}, computed ${fmtAge(regimeAge)}` : "no snapshot",
    });

    // 4. Thesis health — rebuilt within the last day.
    const thesis = parse<{ builtAt?: string; holdings?: unknown[] }>(thesisRaw);
    const thesisAge = hoursAgo(thesis?.builtAt);
    checks.push({
      label: "Thesis health",
      ok: thesisAge != null && thesisAge < 26,
      detail: thesis ? `${Array.isArray(thesis.holdings) ? thesis.holdings.length : 0} holdings, built ${fmtAge(thesisAge)}` : "no cache",
    });

    // 4b. Factor universe (shadow system) — weekly snapshot should be <8d old.
    //     Informational until the first build exists; only flags staleness
    //     AFTER a universe has been built at least once.
    try {
      const uniRaw = await redis.get("pm:factor-universe");
      if (uniRaw) {
        const uni = JSON.parse(uniRaw) as { builtAt?: string; tickerCount?: number };
        const age = hoursAgo(uni?.builtAt);
        checks.push({
          label: "Factor universe",
          ok: age != null && age < 8 * 24,
          detail: `${uni.tickerCount ?? 0} names, built ${fmtAge(age)}`,
        });
      }
    } catch { /* shadow-system check only */ }

    // 5. Mail outbox — shouldn't be piling up (Apps Script drains every ~5min;
    //    a deep queue means the drain trigger is broken and emails are silently
    //    not going out).
    const outbox = parse<unknown[]>(outboxRaw) ?? [];
    checks.push({
      label: "Mail outbox",
      ok: !Array.isArray(outbox) || outbox.length <= 5,
      detail: `${Array.isArray(outbox) ? outbox.length : 0} queued${Array.isArray(outbox) && outbox.length > 5 ? " — is the Apps Script processOutbox trigger running?" : ""}`,
    });

    // 6. Holdings present at all (a canary for pm:stocks integrity).
    const stocks = parse<unknown[]>(stocksRaw);
    checks.push({
      label: "Holdings",
      ok: Array.isArray(stocks) && stocks.length > 0,
      detail: Array.isArray(stocks) ? `${stocks.length} entries` : "pm:stocks unreadable",
    });
  } catch (e) {
    log.error("failed:", e);
    checks.push({ label: "Sentinel", ok: false, detail: e instanceof Error ? e.message : "check crashed" });
  }

  const problems = checks.filter((c) => !c.ok);
  const lines =
    problems.length === 0
      ? [`All fresh ✓ (${checks.map((c) => c.label.toLowerCase()).join(", ")})`]
      : [
          ...problems.map((c) => `⚠ ${c.label}: ${c.detail}`),
          ...checks.filter((c) => c.ok).map((c) => `✓ ${c.label}: ${c.detail}`),
        ];

  const report: DataHealthReport = {
    checkedAt: new Date().toISOString(),
    ok: problems.length === 0,
    lines,
    problemCount: problems.length,
  };

  // Persist for future UI use — derived marker, best-effort.
  try {
    const redis = await getRedis();
    await redis.set(DATA_HEALTH_KEY, JSON.stringify(report));
  } catch {
    /* marker only */
  }
  return report;
}
