import { NextRequest, NextResponse, after } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { STALE_HOURS, buildSignalFundamentals, readSignalFundamentals } from "@/app/lib/signal-fundamentals";

/**
 * GET /api/signal-fundamentals[?refresh=1] — the FactSet fundamentals behind
 * the signal grid. Returns the saved copy at once; when it is older than 20
 * hours a rebuild runs after the response. `?refresh=1` rebuilds first. With
 * nothing saved it builds once. On failure the saved copy is served with
 * `error` set. Writes only the cache pm:signal-fundamentals.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const log = createLogger("Signal-fundamentals");

export async function GET(req: NextRequest) {
  const refresh = new URL(req.url).searchParams.get("refresh");
  const saved = await readSignalFundamentals();
  const ageH = saved ? (Date.now() - Date.parse(saved.at)) / 3_600_000 : Infinity;
  if (saved && !refresh) {
    if (ageH > STALE_HOURS) after(() => buildSignalFundamentals().catch((e) => log.warn("background rebuild failed:", e instanceof Error ? e.message : e)));
    return NextResponse.json(saved);
  }
  try {
    return NextResponse.json(await buildSignalFundamentals());
  } catch (e) {
    const error = e instanceof Error ? e.message : "failed";
    log.warn("build failed:", error);
    return NextResponse.json(saved ? { ...saved, error } : { at: null, names: {}, sectors: {}, market: { peMedian: null, names: 0 }, notes: [], error });
  }
}
