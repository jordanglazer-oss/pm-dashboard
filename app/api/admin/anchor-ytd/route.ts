import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimPerformanceData,
  PimDailyReturn,
  AppendixData,
  PimProfileType,
} from "@/app/lib/pim-types";

const PERF_KEY = "pm:pim-performance";
const APPENDIX_KEY = "pm:appendix-daily-values";

/**
 * POST /api/admin/anchor-ytd
 *
 * Body (multi-profile, preferred):
 *   profiles: Array<{ profile: PimProfileType; targetYtdPct: number }>
 *   group?: string (default "pim")
 *   fromDate?: string (default current-year start, YYYY-01-01)
 *   anchorDate?: string (default = latest existing entry date)
 *   dryRun?: boolean (default true — safer to require explicit override)
 *
 * Body (legacy single-profile form, still supported):
 *   profile: PimProfileType
 *   targetYtdPct: number
 *   (other fields same as above)
 *
 * Methodology:
 *   The user's existing pm:appendix-daily-values has per-day dailyReturn
 *   values that chain to a different cumulative than they need. We
 *   compute a single scale factor f such that:
 *     product_over_2026_days(1 + f × r_i / 100) ≈ 1 + targetYtdPct/100
 *   Solved as f = log(1+target) / log(1+current) where current is the
 *   existing chained cumulative. Each daily return is then multiplied
 *   by f and the cumulative `value` field is recomputed from the
 *   scaled returns starting at the locked Dec 31 prior-year baseline.
 *
 *   This preserves the SHAPE of the existing daily-return series (days
 *   that were up stay up, days that were down stay down, relative
 *   magnitudes preserved) while adjusting the OVERALL MAGNITUDE so the
 *   YTD lands on the target.
 *
 * Writes (when dryRun=false): updates pm:pim-performance and
 * pm:appendix-daily-values for entries on or after fromDate. Pre-
 * fromDate entries preserved byte-for-byte. Stashes both blobs to
 * *.pre-anchor-<ts> keys first so a botched anchor is reversible.
 */

type AnchorResultPerProfile = {
  profile: PimProfileType;
  fromDate: string;
  anchorDate: string;
  baselineValue: number;
  existingChainedYtdPct: number;
  targetYtdPct: number;
  scaleFactor: number;
  daysScaled: number;
  newAnchorValue: number;
  // First / last entry before vs after (for sanity check in dry run)
  firstEntryBefore: { date: string; value: number; dailyReturn: number } | null;
  firstEntryAfter: { date: string; value: number; dailyReturn: number } | null;
  lastEntryBefore: { date: string; value: number; dailyReturn: number } | null;
  lastEntryAfter: { date: string; value: number; dailyReturn: number } | null;
  warnings: string[];
};

function chainCumulative(entries: Array<{ dailyReturn: number }>): number {
  // Skip first entry (anchor day, dailyReturn typically 0).
  let cum = 1;
  for (let i = 1; i < entries.length; i++) {
    cum *= 1 + (entries[i].dailyReturn ?? 0) / 100;
  }
  return cum;
}

/**
 * Find the exact scale factor f such that
 *   product_over_days(1 + f × dailyReturn_i / 100) = targetCum
 *
 * Closed-form approximation f = log(targetCum) / log(currentCum) is
 * accurate when daily returns are small but DIVERGES when the scale
 * factor is far from 1 (large stretch / compression of the series).
 * For Alpha with scale ~1.9, the approximation under-shoots by ~0.8
 * percentage points on the cumulative. Bisection converges in <50
 * iterations to machine precision.
 *
 * Safety: if any (1 + f × r_i) would be ≤ 0 (impossible portfolio
 * value), the iteration caps f at a level that keeps all days valid.
 * Returns null if no valid f produces the target (extreme cases).
 */
function findExactScaleFactor(
  entries: Array<{ dailyReturn: number }>,
  targetCum: number,
): number | null {
  if (entries.length < 2) return null;

  // Find an upper bound on f such that no day's (1 + f × r) goes
  // non-positive. For any day with negative dailyReturn r, we need
  // 1 + f × r/100 > 0 → f < -100/r. Take the most restrictive bound.
  let fCap = 1000; // arbitrary large default
  for (let i = 1; i < entries.length; i++) {
    const r = entries[i].dailyReturn;
    if (r < 0) {
      const bound = -100 / r;
      if (bound > 0 && bound < fCap) fCap = bound;
    }
  }
  // Leave a 1% safety margin so we never produce exactly-zero values.
  fCap = fCap * 0.99;

  const chainAt = (f: number): number => {
    let cum = 1;
    for (let i = 1; i < entries.length; i++) {
      cum *= 1 + (f * entries[i].dailyReturn) / 100;
    }
    return cum;
  };

  // Bisect on f in [0, fCap]. chainAt is monotonically increasing in
  // f when targetCum > current (most expected case) and decreasing
  // when targetCum < current. Determine direction first.
  let fLow = 0;
  let fHigh = Math.min(fCap, 100);
  const cumAtHigh = chainAt(fHigh);
  if (cumAtHigh < targetCum) {
    // Even the cap doesn't reach the target — return cap.
    return fHigh;
  }
  // Standard bisection — search for f where chainAt(f) ≈ targetCum.
  for (let iter = 0; iter < 100; iter++) {
    const fMid = (fLow + fHigh) / 2;
    const c = chainAt(fMid);
    if (Math.abs(c - targetCum) < 1e-8) return fMid;
    if (c < targetCum) fLow = fMid;
    else fHigh = fMid;
  }
  return (fLow + fHigh) / 2;
}

function scaleEntries(
  entries: PimDailyReturn[],
  baselineValue: number,
  scaleFactor: number,
): PimDailyReturn[] {
  if (entries.length === 0) return [];
  // First entry: the baseline anchor day — keep its date, set value to
  // baseline, dailyReturn to 0.
  const out: PimDailyReturn[] = [{
    date: entries[0].date,
    value: parseFloat(baselineValue.toFixed(4)),
    dailyReturn: 0,
  }];
  let cum = baselineValue;
  for (let i = 1; i < entries.length; i++) {
    const scaledDr = entries[i].dailyReturn * scaleFactor;
    cum = cum * (1 + scaledDr / 100);
    out.push({
      date: entries[i].date,
      value: parseFloat(cum.toFixed(4)),
      dailyReturn: parseFloat(scaledDr.toFixed(4)),
    });
  }
  return out;
}

type AnchorRequest = { profile: PimProfileType; targetYtdPct: number };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const groupId = typeof body?.group === "string" ? body.group : "pim";
    const dryRun = body?.dryRun !== false; // default TRUE

    // Normalize input into a list of {profile, targetYtdPct}.
    let requests: AnchorRequest[] = [];
    if (Array.isArray(body?.profiles)) {
      for (const p of body.profiles) {
        if (typeof p?.profile === "string" && typeof p?.targetYtdPct === "number" && isFinite(p.targetYtdPct)) {
          requests.push({ profile: p.profile as PimProfileType, targetYtdPct: p.targetYtdPct });
        }
      }
    } else if (typeof body?.profile === "string" && typeof body?.targetYtdPct === "number" && isFinite(body.targetYtdPct)) {
      // Legacy single-profile form.
      requests = [{ profile: body.profile as PimProfileType, targetYtdPct: body.targetYtdPct }];
    }
    if (requests.length === 0) {
      return NextResponse.json(
        { error: "Either `profiles: [{profile, targetYtdPct}, ...]` or `profile` + `targetYtdPct` is required." },
        { status: 400 },
      );
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const fromDate = typeof body?.fromDate === "string" ? body.fromDate : `${todayIso.slice(0, 4)}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 });
    const anchorDateInput = typeof body?.anchorDate === "string" ? body.anchorDate : null;
    if (anchorDateInput && !/^\d{4}-\d{2}-\d{2}$/.test(anchorDateInput)) {
      return NextResponse.json({ error: "anchorDate must be YYYY-MM-DD" }, { status: 400 });
    }

    const redis = await getRedis();
    const [perfRaw, appendixRaw] = await Promise.all([
      redis.get(PERF_KEY),
      redis.get(APPENDIX_KEY),
    ]);

    const perf: PimPerformanceData = perfRaw ? JSON.parse(perfRaw) : { models: [], lastUpdated: new Date().toISOString() };
    const appendix: AppendixData = appendixRaw ? JSON.parse(appendixRaw) : { ledgers: [] };

    // Build a shared map of changes-by-profile that we'll either write
    // or return in the dry-run summary. We walk every request once,
    // compute its scaled entries, and assemble a complete plan before
    // touching anything.
    type Plan = {
      profile: PimProfileType;
      result: AnchorResultPerProfile;
      modelIdx: number;
      ledgerIdx: number;
      perfPre: PimDailyReturn[];
      perfAfterAnchor: PimDailyReturn[];
      ledgerPre: Array<{ date: string; value: number; dailyReturn: number; addedAt: string }>;
      ledgerAfterAnchor: Array<{ date: string; value: number; dailyReturn: number; addedAt: string }>;
      scaledPerf: PimDailyReturn[];
      scaledLedger: PimDailyReturn[];
    };

    const plans: Plan[] = [];
    const errors: Array<{ profile: PimProfileType; error: string }> = [];

    for (const r of requests) {
      const profile = r.profile;
      const targetYtdPct = r.targetYtdPct;
      const modelIdx = perf.models.findIndex((m) => m.groupId === groupId && m.profile === profile);
      const ledgerIdx = appendix.ledgers.findIndex((l) => l.profile === profile);
      const model = modelIdx >= 0 ? perf.models[modelIdx] : null;
      const ledger = ledgerIdx >= 0 ? appendix.ledgers[ledgerIdx] : null;

      if (!model) { errors.push({ profile, error: `no pim-performance series for ${groupId}/${profile}` }); continue; }
      if (!ledger) { errors.push({ profile, error: `no appendix ledger for ${profile}` }); continue; }

      const perfPre = model.history.filter((e) => e.date < fromDate);
      const perfWindow = model.history.filter((e) => e.date >= fromDate);
      const ledgerPre = ledger.entries.filter((e) => e.date < fromDate);
      const ledgerWindow = ledger.entries.filter((e) => e.date >= fromDate);

      if (perfWindow.length === 0 && ledgerWindow.length === 0) {
        errors.push({ profile, error: `no entries on/after ${fromDate} to scale` });
        continue;
      }

      const baselineFromPerf = perfPre.length > 0 ? perfPre[perfPre.length - 1].value : null;
      const baselineFromLedger = ledgerPre.length > 0 ? ledgerPre[ledgerPre.length - 1].value : null;
      const baselineValue = baselineFromLedger ?? baselineFromPerf ?? 100;

      const anchorDate = anchorDateInput ?? (ledgerWindow.length > 0
        ? ledgerWindow[ledgerWindow.length - 1].date
        : perfWindow[perfWindow.length - 1].date);

      const ledgerToScale = ledgerWindow.filter((e) => e.date <= anchorDate);
      const ledgerAfterAnchor = ledgerWindow.filter((e) => e.date > anchorDate);
      const perfToScale = perfWindow.filter((e) => e.date <= anchorDate);
      const perfAfterAnchor = perfWindow.filter((e) => e.date > anchorDate);

      const existingChained = chainCumulative(ledgerToScale);
      const existingYtdPct = (existingChained - 1) * 100;

      const targetCum = 1 + targetYtdPct / 100;
      if (existingChained <= 0 || targetCum <= 0) {
        errors.push({ profile, error: "non-positive cumulative — cannot scale" });
        continue;
      }
      // Numerical bisection for exact-target scale factor. Replaces
      // the closed-form `f = ln(target)/ln(current)` approximation,
      // which under-shoots for large scale factors (Alpha was off
      // ~0.8% on the dry run because of this).
      const ledgerForBisection = ledgerToScale.map((e) => ({ dailyReturn: e.dailyReturn ?? 0 }));
      const exactF = findExactScaleFactor(ledgerForBisection, targetCum);
      if (exactF == null) {
        errors.push({ profile, error: "bisection failed to find a valid scale factor" });
        continue;
      }
      const scaleFactor = exactF;

      const ledgerToScaleAsDr: PimDailyReturn[] = ledgerToScale.map((e) => ({
        date: e.date,
        value: e.value,
        dailyReturn: e.dailyReturn ?? 0,
      }));
      const perfToScaleAsDr: PimDailyReturn[] = perfToScale.map((e) => ({
        date: e.date,
        value: e.value,
        dailyReturn: e.dailyReturn ?? 0,
      }));

      const scaledLedger = scaleEntries(ledgerToScaleAsDr, baselineValue, scaleFactor);
      const scaledPerf = scaleEntries(perfToScaleAsDr, baselineValue, scaleFactor);

      const newAnchorValue = scaledLedger.length > 0
        ? scaledLedger[scaledLedger.length - 1].value
        : baselineValue;

      const warnings: string[] = [];
      if (Math.abs(scaleFactor) > 5) {
        warnings.push(`Scale factor ${scaleFactor.toFixed(3)} is unusually large — existing daily returns may have very small magnitude. Result may be brittle.`);
      }
      if (perfAfterAnchor.length > 0 || ledgerAfterAnchor.length > 0) {
        warnings.push(`${perfAfterAnchor.length} perf + ${ledgerAfterAnchor.length} ledger entries dated AFTER anchorDate ${anchorDate} are preserved unchanged.`);
      }

      const result: AnchorResultPerProfile = {
        profile,
        fromDate,
        anchorDate,
        baselineValue: parseFloat(baselineValue.toFixed(4)),
        existingChainedYtdPct: parseFloat(existingYtdPct.toFixed(4)),
        targetYtdPct,
        scaleFactor: parseFloat(scaleFactor.toFixed(4)),
        daysScaled: ledgerToScale.length,
        newAnchorValue: parseFloat(newAnchorValue.toFixed(4)),
        firstEntryBefore: ledgerToScale[0] ? { date: ledgerToScale[0].date, value: ledgerToScale[0].value, dailyReturn: ledgerToScale[0].dailyReturn ?? 0 } : null,
        firstEntryAfter: scaledLedger[0] ?? null,
        lastEntryBefore: ledgerToScale.length > 0 ? { date: ledgerToScale[ledgerToScale.length - 1].date, value: ledgerToScale[ledgerToScale.length - 1].value, dailyReturn: ledgerToScale[ledgerToScale.length - 1].dailyReturn ?? 0 } : null,
        lastEntryAfter: scaledLedger.length > 0 ? scaledLedger[scaledLedger.length - 1] : null,
        warnings,
      };

      plans.push({
        profile,
        result,
        modelIdx,
        ledgerIdx,
        perfPre,
        perfAfterAnchor,
        ledgerPre,
        ledgerAfterAnchor,
        scaledPerf,
        scaledLedger,
      });
    }

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wrote: false,
        groupId,
        results: plans.map((p) => p.result),
        errors,
        note: "dryRun=true — no data written. Inspect results, then re-run with dryRun:false to apply.",
      });
    }

    if (plans.length === 0) {
      return NextResponse.json({ error: "No profiles could be processed", errors }, { status: 400 });
    }

    // ─── WRITE PATH ───
    const ts = Date.now();
    if (perfRaw) await redis.set(`${PERF_KEY}.pre-anchor-${ts}`, perfRaw);
    if (appendixRaw) await redis.set(`${APPENDIX_KEY}.pre-anchor-${ts}`, appendixRaw);

    const newPerf: PimPerformanceData = { ...perf, models: [...perf.models], lastUpdated: new Date().toISOString() };
    const newAppendix: AppendixData = { ledgers: [...appendix.ledgers] };
    const now = new Date().toISOString();

    for (const plan of plans) {
      newPerf.models[plan.modelIdx] = {
        ...perf.models[plan.modelIdx],
        history: [...plan.perfPre, ...plan.scaledPerf, ...plan.perfAfterAnchor],
        lastUpdated: new Date().toISOString(),
      };
      const scaledLedgerEntries = plan.scaledLedger.map((e) => ({
        date: e.date,
        value: e.value,
        dailyReturn: e.dailyReturn,
        addedAt: now,
      }));
      newAppendix.ledgers[plan.ledgerIdx] = {
        ...appendix.ledgers[plan.ledgerIdx],
        entries: [...plan.ledgerPre, ...scaledLedgerEntries, ...plan.ledgerAfterAnchor],
      };
    }

    await redis.set(PERF_KEY, JSON.stringify(newPerf));
    await redis.set(APPENDIX_KEY, JSON.stringify(newAppendix));

    return NextResponse.json({
      ok: true,
      dryRun: false,
      wrote: true,
      groupId,
      stashKeys: {
        perf: perfRaw ? `${PERF_KEY}.pre-anchor-${ts}` : null,
        appendix: appendixRaw ? `${APPENDIX_KEY}.pre-anchor-${ts}` : null,
      },
      results: plans.map((p) => p.result),
      errors,
    });
  } catch (e) {
    console.error("anchor-ytd error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
