import { NextRequest, NextResponse } from "next/server";
import { factsetConfigured } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { companySnapshot, formatSnapshotForPrompt } from "@/app/lib/factset-fundamentals";

/**
 * GET /api/admin/factset-score-debug?ticker=MLI
 *
 * Admin-only, READ-ONLY. Replays the EXACT FactSet decision the score route
 * makes — factsetConfigured() -> resolveFactsetId() -> companySnapshot() -> the
 * hasData check — and returns whether FactSet WOULD feed the scoring prompt for
 * this ticker, plus the actual block text Claude would receive. Pinpoints where
 * the pipeline breaks (env not loaded, id mis-resolved, snapshot empty, etc.).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const ticker = (new URL(req.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ error: "ticker query param required" }, { status: 400 });

  const configured = factsetConfigured();
  const resolved = resolveFactsetId(ticker);

  if (!configured) {
    return NextResponse.json({
      ticker,
      configured: false,
      verdict: "FactSet relay NOT configured in this runtime — FACTSET_RELAY_URL / FACTSET_RELAY_SECRET missing.",
    });
  }
  if (resolved.source !== "factset") {
    return NextResponse.json({
      ticker,
      configured,
      resolved,
      wouldUseFactset: false,
      verdict: `Ticker resolves to the existing source (${resolved.reason}), so FactSet is intentionally skipped.`,
    });
  }

  try {
    const snap = await companySnapshot(resolved.id);
    const block = snap.hasData ? formatSnapshotForPrompt(snap) : null;
    return NextResponse.json({
      ticker,
      configured,
      factsetId: resolved.id,
      hasData: snap.hasData,
      factsetName: snap.name,
      wouldUseFactset: snap.hasData,
      verdict: snap.hasData
        ? "FactSet WOULD feed the prompt — block built successfully (see blockPreview). If scores still cite EDGAR/Yahoo, it's a prompt/citation issue."
        : "Snapshot returned no core revenue — FactSet would be skipped here.",
      blockPreview: block,
      values: snap.values,
    });
  } catch (e) {
    return NextResponse.json(
      { ticker, configured, factsetId: resolved.id, error: e instanceof Error ? e.message : String(e), verdict: "Snapshot fetch threw — relay call failed from this runtime." },
      { status: 502 }
    );
  }
}
