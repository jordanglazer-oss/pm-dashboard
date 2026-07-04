import { NextRequest, NextResponse } from "next/server";
import {
  crossSectional,
  crossSectionalDiagnostic,
  timeSeriesRaw,
  timeSeriesBatch,
  factsetConfigured,
  relayHealthy,
  FACTSET_FORMULAS,
} from "@/app/lib/factset";
import { SCORING_FORMULAS } from "@/app/lib/factset-fundamentals";

/**
 * GET /api/admin/factset-probe?ids=AAPL-US,SPY-US&formulas=P_PRICE,P_BETA
 *
 * Admin-only (gated by the cookie middleware on /api/admin/*). Verifies the
 * dashboard -> relay -> FactSet path end to end WITHOUT wiring FactSet into any
 * user-facing flow. Read-only: touches no Redis and makes no mutations.
 *
 * Returns { configured:false } until FACTSET_RELAY_URL + FACTSET_RELAY_SECRET
 * are set in Vercel (i.e. until the relay is live), so it's safe to deploy now.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Candidate formula sets to VALIDATE (free) before wiring into scoring. Each set
 * lists several plausible FactSet codes for a concept — the probe reports which
 * resolve (error 0) vs. which are unknown (error 107) vs. valid-but-null. We
 * then keep the winners. Comma-bearing formulas are fine here: the diagnostic
 * URL-encodes inner commas (%2C).
 */
const CANDIDATE_SETS: Record<string, { key: string; formula: string; note: string }[]> = {
  // Round 3: FE_ESTIMATE(REPORT_DATE,...) + FE_GUIDANCE(...) are VALID (error 0)
  // but null for AAPL (no populated estimate report date; no formal guidance).
  // Re-probe on a name that reports on schedule AND guides (id=MSFT-US) to see
  // real values. Kept the confirmed FF_EPS_RPT_DATE(QTR,0) as a fallback basis.
  earnings: [
    { key: "feRptDateQtr1", formula: "FE_ESTIMATE(REPORT_DATE,MEAN,QTR_ROLL,1,NOW,'')", note: "Next-quarter expected report date (the 'next earnings date')" },
    { key: "feRptDateQtr0", formula: "FE_ESTIMATE(REPORT_DATE,MEAN,QTR_ROLL,0,NOW,'')", note: "Current-quarter expected report date" },
    { key: "ffRptDateQtr0", formula: "FF_EPS_RPT_DATE(QTR,0)", note: "Last quarterly report date (fallback basis)" },
  ],
  guidance: [
    { key: "guidEpsMeanQ1", formula: "FE_GUIDANCE(EPS,MEAN,QTR_ROLL,1,NOW,'')", note: "EPS guidance mean, next quarter" },
    { key: "guidEpsHighQ1", formula: "FE_GUIDANCE(EPS,HIGH,QTR_ROLL,1,NOW,'')", note: "EPS guidance high, next quarter" },
    { key: "guidEpsLowQ1", formula: "FE_GUIDANCE(EPS,LOW,QTR_ROLL,1,NOW,'')", note: "EPS guidance low, next quarter" },
    { key: "guidSalesMeanQ1", formula: "FE_GUIDANCE(SALES,MEAN,QTR_ROLL,1,NOW,'')", note: "Sales guidance mean, next quarter" },
    { key: "guidEpsMeanA1", formula: "FE_GUIDANCE(EPS,MEAN,ANN_ROLL,1,NOW,'')", note: "EPS guidance mean, FY+1" },
    { key: "guidSalesMeanA1", formula: "FE_GUIDANCE(SALES,MEAN,ANN_ROLL,1,NOW,'')", note: "Sales guidance mean, FY+1" },
  ],
};

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;

  if (!factsetConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      hint: "Set FACTSET_RELAY_URL and FACTSET_RELAY_SECRET in Vercel env once the relay is live, then retry.",
    });
  }

  // ?candidates=earnings|guidance|all[&id=AAPL-US] → validate the candidate
  // formula codes (which resolve vs. error 107 unknown). Free — no rescore.
  const candSet = sp.get("candidates");
  if (candSet) {
    const id = sp.get("id") || "AAPL-US";
    const list =
      candSet === "all" ? [...CANDIDATE_SETS.earnings, ...CANDIDATE_SETS.guidance] : (CANDIDATE_SETS[candSet] || []);
    if (list.length === 0) {
      return NextResponse.json({ ok: false, error: `Unknown set '${candSet}'. Use earnings | guidance | all.` });
    }
    try {
      const diag = await crossSectionalDiagnostic(id, list.map((c) => c.formula));
      const results = list.map((c, i) => ({
        key: c.key,
        note: c.note,
        formula: c.formula,
        value: diag[i]?.value ?? null,
        error: diag[i]?.error ?? -1,
        status:
          diag[i]?.error === 0
            ? diag[i]?.value === null ? "ok-but-null" : "ok"
            : diag[i]?.error === 107 ? "bad-formula-code" : "error",
        errorMessage: diag[i]?.errorMessage,
      }));
      const working = results.filter((r) => r.status === "ok").map((r) => r.key);
      return NextResponse.json({ ok: true, id, set: candSet, working, results });
    } catch (e) {
      return NextResponse.json({ ok: false, id, set: candSet, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // ?timeseries=<factsetId>[&tsFormula=FG_PE&tsFreq=M&tsYears=5] → dump the RAW
  // time-series response so we can confirm the shape before writing a parser.
  // This is how we'll pull a true own-history valuation band (FG_PE over time).
  const tsId = sp.get("timeseries");
  if (tsId) {
    const formula = sp.get("tsFormula") || "FG_PE";
    const frequency = sp.get("tsFreq") || "M";
    const years = Math.max(1, Math.min(10, parseInt(sp.get("tsYears") || "5", 10) || 5));
    const end = new Date();
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - years);
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const startDate = ymd(start);
    const endDate = ymd(end);
    // ?tsRaw=Y → single raw submit (no polling), to inspect one response.
    // Default → run the full batch flow (submit → poll → result).
    const rawOnly = sp.get("tsRaw") === "Y";
    try {
      if (rawOnly) {
        const endpoint = sp.get("tsEndpoint") === "time-series" ? "time-series" : "cross-sectional";
        const batch = sp.get("tsBatch") !== "N";
        const raw = await timeSeriesRaw(tsId, formula, startDate, endDate, frequency, { endpoint, batch });
        return NextResponse.json({ ok: true, mode: "timeseries-raw", id: tsId, formula, frequency, startDate, endDate, endpoint, batch, raw });
      }
      const out = await timeSeriesBatch(tsId, formula, startDate, endDate, frequency);
      return NextResponse.json({ ok: true, mode: "timeseries", id: tsId, formula, frequency, startDate, endDate, ...out });
    } catch (e) {
      return NextResponse.json(
        { ok: false, mode: "timeseries", id: tsId, formula, error: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      );
    }
  }

  // ?snapshot=<factsetId> → validate the full scoring formula set against one
  // company, reporting which formula codes work (error 0) vs. which need
  // correcting (error 107 "Unknown expression") vs. valid-but-no-data (null).
  const snapshotId = sp.get("snapshot");
  if (snapshotId) {
    try {
      const diag = await crossSectionalDiagnostic(
        snapshotId,
        SCORING_FORMULAS.map((f) => f.formula)
      );
      const results = SCORING_FORMULAS.map((f, i) => ({
        key: f.key,
        note: f.note,
        formula: f.formula,
        value: diag[i]?.value ?? null,
        error: diag[i]?.error ?? -1,
        status:
          diag[i]?.error === 0
            ? diag[i]?.value === null
              ? "ok-but-null"
              : "ok"
            : diag[i]?.error === 107
            ? "bad-formula-code"
            : "error",
        errorMessage: diag[i]?.errorMessage,
      }));
      const working = results.filter((r) => r.status === "ok").length;
      const badCodes = results.filter((r) => r.status === "bad-formula-code").map((r) => r.key);
      return NextResponse.json({
        ok: true,
        snapshotId,
        summary: { working, total: results.length, badCodes },
        results,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, snapshotId, error: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      );
    }
  }

  const ids = (sp.get("ids") || "AAPL-US")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Note: this simple probe splits formulas on commas, so pass formulas without
  // inner commas (P_PRICE, P_BETA, FG_PE, ...). For comma-bearing formulas use
  // the lib directly.
  const formulas = (sp.get("formulas") || FACTSET_FORMULAS.price)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const [health, data] = await Promise.all([relayHealthy(), crossSectional(ids, formulas)]);
    return NextResponse.json({ ok: true, configured: true, relayHealthy: health, ids, formulas, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
