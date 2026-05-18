import { NextRequest, NextResponse } from "next/server";
import { extractAnalystReport, VALID_SOURCES, type AnalystSource } from "@/app/lib/analyst-extract";

/**
 * Thin HTTP wrapper around the shared `extractAnalystReport` helper. The
 * manual upload flow on the stock page calls this; the Gmail inbox webhook
 * calls the helper directly without going through HTTP.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.toUpperCase() : "";
    const source = typeof body?.source === "string" ? body.source.toLowerCase() : "";
    const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
    const force = body?.force === true;

    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    if (!(VALID_SOURCES as readonly string[]).includes(source)) {
      return NextResponse.json({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` }, { status: 400 });
    }
    if (!dataUrl.startsWith("data:application/pdf;base64,")) {
      return NextResponse.json({ error: "dataUrl must be a base64-encoded PDF" }, { status: 400 });
    }

    const out = await extractAnalystReport({ ticker, source: source as AnalystSource, dataUrl, force });
    return NextResponse.json(out);
  } catch (e) {
    console.error("analyst-report-extract error:", e);
    const msg = e instanceof Error ? e.message : "Extraction failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
