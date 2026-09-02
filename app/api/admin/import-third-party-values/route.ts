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
 * POST /api/admin/import-third-party-values
 *
 * Body:
 *   profile: PimProfileType (required) — e.g. "alpha"
 *   group?: string (default "pim")
 *   values: Array<{ date: string, value: number }> (required) — raw
 *     daily portfolio values from a custodian / third-party tracker.
 *     `value` is in arbitrary units (dollars, percent, anything) —
 *     the endpoint normalizes against the first value so it joins
 *     seamlessly to our existing cumulative-index history.
 *   fromDate?: YYYY-MM-DD (default current-year start) — defines
 *     which entries get replaced. Pre-fromDate entries are preserved.
 *   dryRun?: boolean (default TRUE) — must explicitly pass dryRun:false
 *     to write.
 *
 * Methodology:
 *   1. Find the cumulative-index value at Dec 31 prior year (or the
 *      last entry before fromDate) — call this baseline.
 *   2. Normalize input values so the FIRST value maps to baseline.
 *      Every subsequent input value becomes (input / first) × baseline.
 *   3. Compute dailyReturn between consecutive normalized values.
 *   4. Mark the LATEST entry anchored:true so update-daily-value's
 *      recalc-window pop loop can't overwrite it. The previous YTD-
 *      anchor entry (if any) is replaced with the real value.
 *
 * This is the clean replacement for the scaling-based YTD anchor —
 * uses real per-day data instead of stretching existing daily returns.
 *
 * Stashes both blobs to *.pre-import-<ts> before writing.
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const profile = (typeof body?.profile === "string" ? body.profile : "") as PimProfileType;
    const groupId = typeof body?.group === "string" ? body.group : "pim";
    const valuesRaw = body?.values;
    const dryRun = body?.dryRun !== false; // default TRUE
    const todayIso = new Date().toISOString().slice(0, 10);
    const fromDate = typeof body?.fromDate === "string" ? body.fromDate : `${todayIso.slice(0, 4)}-01-01`;

    if (!profile) {
      return NextResponse.json({ error: "profile is required (e.g. 'alpha')" }, { status: 400 });
    }
    if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) {
      return NextResponse.json({ error: "values must be a non-empty array of {date, value}" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 });
    }

    // Parse + validate values, sort ascending by date.
    const values: Array<{ date: string; value: number }> = [];
    for (const v of valuesRaw) {
      const date = typeof v?.date === "string" ? v.date : "";
      const value = typeof v?.value === "number" ? v.value : NaN;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!isFinite(value) || value <= 0) continue;
      values.push({ date, value });
    }
    values.sort((a, b) => a.date.localeCompare(b.date));
    if (values.length === 0) {
      return NextResponse.json({ error: "no valid values after filtering" }, { status: 400 });
    }
    // Filter to dates on or after fromDate (these get written).
    const inWindow = values.filter((v) => v.date >= fromDate);
    if (inWindow.length === 0) {
      return NextResponse.json({ error: `no values on or after ${fromDate}` }, { status: 400 });
    }
    // PRE-FROMDATE values are used ONLY as anchor candidates. The most
    // recent pre-fromDate value (e.g. Dec 31 prior year) is what we
    // normalize against, so the Jan-2-vs-Dec-31 return is preserved
    // in the cumulative index rather than collapsed to zero.
    const preWindowValues = values.filter((v) => v.date < fromDate);
    const anchorPreValue = preWindowValues.length > 0
      ? preWindowValues[preWindowValues.length - 1]
      : null;

    const redis = await getRedis();
    const [perfRaw, appendixRaw] = await Promise.all([
      redis.get(PERF_KEY),
      redis.get(APPENDIX_KEY),
    ]);
    const perf: PimPerformanceData = perfRaw ? JSON.parse(perfRaw) : { models: [], lastUpdated: new Date().toISOString() };
    const appendix: AppendixData = appendixRaw ? JSON.parse(appendixRaw) : { ledgers: [] };

    const modelIdx = perf.models.findIndex((m) => m.groupId === groupId && m.profile === profile);
    const ledgerIdx = appendix.ledgers.findIndex((l) => l.profile === profile);
    const model = modelIdx >= 0 ? perf.models[modelIdx] : null;
    const ledger = ledgerIdx >= 0 ? appendix.ledgers[ledgerIdx] : null;

    if (!model) return NextResponse.json({ error: `no pim-performance series for ${groupId}/${profile}` }, { status: 404 });
    if (!ledger) return NextResponse.json({ error: `no appendix ledger for ${profile}` }, { status: 404 });

    // Anchor value = last cumulative-index value BEFORE fromDate (in
    // appendix, then perf as fallback). Real-world: Dec 31 prior year
    // value from the locked pre-current-year history. The first
    // imported value will be normalized to this number.
    const ledgerPre = ledger.entries.filter((e) => e.date < fromDate);
    const ledgerInWindow = ledger.entries.filter((e) => e.date >= fromDate);
    const perfPre = model.history.filter((e) => e.date < fromDate);
    const perfInWindow = model.history.filter((e) => e.date >= fromDate);

    const baselineFromLedger = ledgerPre.length > 0 ? ledgerPre[ledgerPre.length - 1].value : null;
    const baselineFromPerf = perfPre.length > 0 ? perfPre[perfPre.length - 1].value : null;
    const baseline = baselineFromLedger ?? baselineFromPerf ?? 100;

    // Normalize: each imported value's cumulative-index =
    //   baseline × (value / anchorValue)
    // where anchorValue is the LAST pre-fromDate input value if
    // present (preserves the boundary-day return like Jan 2's
    // gain vs Dec 31), or else the first in-window value (falls
    // back to the prior "first-value-is-baseline" behavior).
    const anchorValue = anchorPreValue?.value ?? inWindow[0].value;
    if (anchorValue <= 0) {
      return NextResponse.json({ error: "anchor value is non-positive" }, { status: 400 });
    }

    const newEntries: PimDailyReturn[] = [];
    let prevIndex = baseline;
    for (let i = 0; i < inWindow.length; i++) {
      const v = inWindow[i];
      const cumIndex = baseline * (v.value / anchorValue);
      const dailyRet = i === 0 && !anchorPreValue
        ? 0 // no anchor → first day's return collapses to 0
        : ((cumIndex - prevIndex) / prevIndex) * 100;
      // Mark ALL imported entries anchored — they come from a
      // third-party tracker we trust as the source of truth. Any
      // future recompute / update-daily-value pop loop must stop at
      // these entries rather than re-deriving them from price data.
      newEntries.push({
        date: v.date,
        value: parseFloat(cumIndex.toFixed(4)),
        dailyReturn: parseFloat(dailyRet.toFixed(4)),
        anchored: true,
      });
      prevIndex = cumIndex;
    }

    // Sanity check: the new YTD = (last / baseline) - 1 should match
    // what the user expects from their third-party data.
    const newYtdPct = newEntries.length > 0
      ? (newEntries[newEntries.length - 1].value / baseline - 1) * 100
      : 0;
    const existingYtdPct = ledgerInWindow.length > 0
      ? (ledgerInWindow[ledgerInWindow.length - 1].value / baseline - 1) * 100
      : null;

    // ── PRE-FLIGHT WARNINGS ──────────────────────────────────────
    // Non-blocking data-shape checks. The import math is a pure
    // value-ratio chain, so it silently produces a wrong YTD when the
    // input series has (a) no pre-fromDate anchor row, (b) internal
    // date gaps, (c) an external cash flow, or (d) a stale end date
    // that /api/update-daily-value cannot backfill (its Yahoo window is
    // 15 calendar days — roughly 10 trading days — so anything older is
    // skipped, silently dropping those days' returns from the chain).
    // These are surfaced in the dry run so they can be caught BEFORE
    // the write.
    const warnings: string[] = [];

    function tradingDaysBetween(a: string, b: string): number {
      let n = 0;
      const d = new Date(`${a}T12:00:00`);
      const end = new Date(`${b}T12:00:00`);
      d.setDate(d.getDate() + 1);
      while (d <= end) {
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) n++;
        d.setDate(d.getDate() + 1);
      }
      return n;
    }

    if (!anchorPreValue) {
      warnings.push(
        `No row dated before ${fromDate} in the file. The first imported day ` +
        `(${inWindow[0].date}) is pinned to the existing index value, so its return vs the ` +
        `prior year-end is recorded as 0.00% and YTD is understated by that day's move. ` +
        `Re-export starting in December of the prior year.`,
      );
    }

    const staleTradingDays = tradingDaysBetween(inWindow[inWindow.length - 1].date, todayIso);
    if (staleTradingDays > 3) {
      warnings.push(
        `File ends ${inWindow[inWindow.length - 1].date}, ${staleTradingDays} trading days before today ` +
        `(${todayIso}). /api/update-daily-value backfills at most ~10 trading days of prices; ` +
        `anything older is skipped and those days' returns are lost from the index chain. ` +
        `Re-export through the most recent close.`,
      );
    }

    const dupDates = (() => {
      const seen = new Set<string>();
      const dups: string[] = [];
      for (const v of values) {
        if (seen.has(v.date)) dups.push(v.date);
        seen.add(v.date);
      }
      return dups;
    })();
    if (dupDates.length > 0) {
      warnings.push(`Duplicate dates in file (last one wins per date order): ${dupDates.slice(0, 5).join(", ")}${dupDates.length > 5 ? "…" : ""}.`);
    }

    const internalGaps: string[] = [];
    for (let i = 1; i < inWindow.length; i++) {
      const missed = tradingDaysBetween(inWindow[i - 1].date, inWindow[i].date) - 1;
      if (missed >= 3) internalGaps.push(`${inWindow[i - 1].date}→${inWindow[i].date} (${missed} trading days)`);
    }
    if (internalGaps.length > 0) {
      warnings.push(
        `Gaps inside the series — the return across each gap is compressed into one entry: ` +
        `${internalGaps.slice(0, 5).join(", ")}${internalGaps.length > 5 ? "…" : ""}.`,
      );
    }

    const bigMoves = newEntries.filter((e) => Math.abs(e.dailyReturn) > 8);
    if (bigMoves.length > 0) {
      warnings.push(
        `Daily move over ±8% on ${bigMoves.slice(0, 5).map((e) => `${e.date} (${e.dailyReturn.toFixed(2)}%)`).join(", ")}` +
        `${bigMoves.length > 5 ? "…" : ""}. If a deposit/withdrawal hit the SIA account that day, this import ` +
        `will book the cash flow as performance — the endpoint reads the Total column as a pure value ratio.`,
      );
    }

    if (existingYtdPct != null && Math.abs(newYtdPct - existingYtdPct) > 3) {
      warnings.push(
        `New YTD (${newYtdPct.toFixed(2)}%) differs from the stored YTD (${existingYtdPct.toFixed(2)}%) by ` +
        `${Math.abs(newYtdPct - existingYtdPct).toFixed(2)}pp. Confirm this is the correction you expect before applying.`,
      );
    }

    const summary = {
      profile,
      groupId,
      fromDate,
      baselineValue: parseFloat(baseline.toFixed(4)),
      anchorPreValue: anchorPreValue
        ? { date: anchorPreValue.date, value: anchorPreValue.value }
        : null,
      importedValueCount: inWindow.length,
      firstImportedDate: inWindow[0].date,
      lastImportedDate: inWindow[inWindow.length - 1].date,
      firstNormalizedIndex: newEntries[0]?.value,
      lastNormalizedIndex: newEntries[newEntries.length - 1]?.value,
      newYtdPct: parseFloat(newYtdPct.toFixed(2)),
      existingYtdPct: existingYtdPct != null ? parseFloat(existingYtdPct.toFixed(2)) : null,
      anchoredLastEntry: true,
      preFromDateEntriesPreserved: { perf: perfPre.length, appendix: ledgerPre.length },
      entriesBeingReplaced: { perf: perfInWindow.length, appendix: ledgerInWindow.length },
      warnings,
    };

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wrote: false,
        summary,
        sample: {
          first: newEntries[0],
          last: newEntries[newEntries.length - 1],
          midpoint: newEntries[Math.floor(newEntries.length / 2)],
        },
        note: "dryRun=true — no data written. Inspect summary and sample, then re-run with dryRun:false to apply.",
      });
    }

    // ─── WRITE PATH ───
    const ts = Date.now();
    if (perfRaw) await redis.set(`${PERF_KEY}.pre-import-${ts}`, perfRaw);
    if (appendixRaw) await redis.set(`${APPENDIX_KEY}.pre-import-${ts}`, appendixRaw);

    const newPerf: PimPerformanceData = { ...perf, models: [...perf.models], lastUpdated: new Date().toISOString() };
    newPerf.models[modelIdx] = {
      ...model,
      history: [...perfPre, ...newEntries],
      lastUpdated: new Date().toISOString(),
    };

    const newAppendix: AppendixData = { ledgers: [...appendix.ledgers] };
    const now = new Date().toISOString();
    const newLedgerEntries = newEntries.map((e) => ({
      date: e.date,
      value: e.value,
      dailyReturn: e.dailyReturn,
      addedAt: now,
    }));
    newAppendix.ledgers[ledgerIdx] = {
      ...ledger,
      entries: [...ledgerPre, ...newLedgerEntries],
    };

    await redis.set(PERF_KEY, JSON.stringify(newPerf));
    await redis.set(APPENDIX_KEY, JSON.stringify(newAppendix));

    return NextResponse.json({
      ok: true,
      dryRun: false,
      wrote: true,
      stashKeys: {
        perf: perfRaw ? `${PERF_KEY}.pre-import-${ts}` : null,
        appendix: appendixRaw ? `${APPENDIX_KEY}.pre-import-${ts}` : null,
      },
      summary,
    });
  } catch (e) {
    console.error("import-third-party-values error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
