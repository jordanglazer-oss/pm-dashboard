import { NextRequest, NextResponse } from "next/server";
import { POST as scorePOST } from "@/app/api/score/route";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Score-dispersion");

/**
 * GET /api/admin/score-dispersion?ticker=AAPL[&anchor=off][&verify=off]
 *
 * Admin-only DIAGNOSTIC for the scoring dispersion test: runs ONE rescore
 * through the exact same code path as the Score button and returns the raw
 * per-category output as JSON — WITHOUT persisting anything. The score route
 * itself writes nothing to pm:stocks / pm:score-history (the client normally
 * persists), so repeated calls are safe against prod; its only side effect is
 * the idempotent same-day pm:analyst-snapshots FactSet refresh.
 *
 * Params:
 *   ticker  (required)
 *   anchor  "off" → skipPriorAnchor: the PRIOR SCORE block is suppressed so
 *           repeated same-day runs measure intrinsic pipeline variance rather
 *           than dispersion-under-anchoring. Default "on" (production config).
 *   verify  "off" → disable web_search (isolates model sampling noise from
 *           search-result variance). Default "on" (production config).
 *
 * Usage: hit N times per name on the same day, collect the JSON lines, and
 * compute per-category spread / modal-value share across runs.
 */

// No maxDuration override — inherit the same runtime default as /api/score,
// which this route merely wraps (a verified rescore already runs within it).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ error: "ticker query param required" }, { status: 400 });
  const anchorOff = url.searchParams.get("anchor") === "off";
  const verifyOff = url.searchParams.get("verify") === "off";

  const startedAt = new Date().toISOString();
  log.info(`single dispersion run for ${ticker} (anchor ${anchorOff ? "OFF" : "on"}, verify ${verifyOff ? "OFF" : "on"})`);

  const res = await scorePOST(
    new NextRequest("http://internal/api/score", {
      method: "POST",
      body: JSON.stringify({
        ticker,
        verifyWithWebSearch: !verifyOff,
        skipPriorAnchor: anchorOff,
      }),
    })
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return NextResponse.json(
      { ticker, error: `score route ${res.status}`, detail: err?.error ?? null },
      { status: 502 }
    );
  }
  const data = (await res.json()) as {
    scores?: Record<string, number>;
    explanations?: Record<string, { summary?: string; confidence?: string }>;
    verifiedSearch?: boolean;
  };

  // Compact projection: scores + per-category confidence only. Explanation
  // prose is omitted so N runs stay easy to eyeball / diff side by side.
  const confidence: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.explanations ?? {})) {
    if (v && typeof v === "object" && typeof v.confidence === "string") confidence[k] = v.confidence;
  }

  return NextResponse.json({
    ticker,
    anchor: anchorOff ? "off" : "on",
    verify: verifyOff ? "off" : "on",
    startedAt,
    finishedAt: new Date().toISOString(),
    scores: data.scores ?? null,
    confidence,
    persisted: false,
  });
}
