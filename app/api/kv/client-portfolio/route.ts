import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Persistence for the Client Portfolio Comparison positions on the
 * Client Report page. Stored as a single JSON blob so the user's
 * input survives page refreshes.
 *
 * Shape on disk:
 *   {
 *     positions: [{ id, ticker, name, units, weight, mer? }],
 *     cash: 0,
 *     inputMode: "units" | "weight",
 *     analysis?: ClientReportAnalysis,
 *     metricsOverrides?: {
 *       // keyed by `${groupId}::${profile}`
 *       [key: string]: {
 *         stdDev?: number,           // fraction (0.14 = 14%)
 *         benchmarkStdDev?: number,  // fraction
 *         upsideCapture?: number,    // percent (95 = 95%)
 *         downsideCapture?: number,  // percent
 *       }
 *     }
 *   }
 *
 * Note: a previous revision of this blob included a `clientName`
 * string. That field was removed — client-identifying data should not
 * be stored on the PM's personal device. The PUT below fully replaces
 * the blob on every write, so any existing `clientName` on disk will
 * be dropped on the next save (by design).
 */

const KEY = "pm:client-portfolio";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ data: null });
    return NextResponse.json({ data: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (client-portfolio):", e);
    return NextResponse.json({ data: null });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    // Shape guard: must be an object with a 'positions' array. Body shape
    // is documented at the top of this file. Reject anything else to avoid
    // overwriting hand-entered client data with a malformed blob.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      console.error("[pm:client-portfolio PUT] Rejected non-object body:", typeof body);
      return NextResponse.json(
        { error: "pm:client-portfolio body must be an object with a 'positions' array" },
        { status: 400 },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!Array.isArray((body as any).positions)) {
      console.error("[pm:client-portfolio PUT] Rejected body missing 'positions' array");
      return NextResponse.json(
        { error: "pm:client-portfolio body must include a 'positions' array" },
        { status: 400 },
      );
    }
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(body));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (client-portfolio):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
