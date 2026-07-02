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

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;

  if (!factsetConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      hint: "Set FACTSET_RELAY_URL and FACTSET_RELAY_SECRET in Vercel env once the relay is live, then retry.",
    });
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
