import { NextRequest, NextResponse } from "next/server";
import { extractAnalystReport, VALID_SOURCES, type AnalystSource } from "@/app/lib/analyst-extract";
import { tickerDisplayCurrency, convertAnalystTarget } from "@/app/lib/currency";

/**
 * HTTP wrapper around the shared `extractAnalystReport` helper, plus the
 * currency-conversion layer that the inbox webhook also uses.
 *
 * The extraction itself is cached by PDF hash; conversion happens AFTER
 * cache lookup so the same PDF uploaded under different dashboard tickers
 * (e.g. RBC Cameco report under CCJ vs CCO.TO) gets the correct target
 * currency for each context.
 *
 * Response augments the base ExtractResult with a `conversion` block the
 * client merges into the AnalystEntry. When extraction couldn't determine
 * currency or the dashboard ticker's suffix is unknown, the conversion
 * status is set accordingly and the client surfaces a warning in the UI.
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

    // Apply currency conversion (FX rate pinned to the report's asOf date).
    let conversion: {
      target?: number;
      targetCurrency?: string;
      originalTarget?: number;
      originalCurrency?: string;
      fxRateApplied?: number;
      fxRateDate?: string;
      conversionStatus: "converted" | "no-conversion-needed" | "currency-unknown" | "ticker-unknown" | "fx-failed" | "no-target";
    } = { conversionStatus: "no-target" };

    const displayCcy = tickerDisplayCurrency(ticker);
    const extracted = out.result;

    if (extracted.target == null) {
      conversion = { conversionStatus: "no-target" };
    } else if (!displayCcy) {
      conversion = {
        target: extracted.target,
        targetCurrency: extracted.targetCurrency,
        conversionStatus: "ticker-unknown",
      };
    } else if (!extracted.targetCurrency) {
      conversion = { target: extracted.target, conversionStatus: "currency-unknown" };
    } else {
      const conv = await convertAnalystTarget({
        rawTarget: extracted.target,
        reportedCurrency: extracted.targetCurrency,
        displayCurrency: displayCcy.currency,
        asOf: extracted.asOf,
      });
      if (conv) {
        conversion = {
          target: conv.converted,
          targetCurrency: displayCcy.currency,
          originalTarget: conv.originalTarget,
          originalCurrency: conv.originalCurrency,
          fxRateApplied: conv.fxRateApplied,
          fxRateDate: conv.fxRateDate,
          conversionStatus: conv.fxRateApplied === 1 ? "no-conversion-needed" : "converted",
        };
      } else {
        conversion = {
          target: extracted.target,
          targetCurrency: extracted.targetCurrency,
          conversionStatus: "fx-failed",
        };
      }
    }

    return NextResponse.json({ ...out, conversion });
  } catch (e) {
    console.error("analyst-report-extract error:", e);
    const msg = e instanceof Error ? e.message : "Extraction failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
