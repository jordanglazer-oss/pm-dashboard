import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { loadRangeAttribution } from "@/app/lib/range-attribution-load";
import { loadSiaRangeAttribution } from "@/app/lib/sia-attribution-load";
import { readSiaStore } from "@/app/lib/sia-store";

/**
 * GET /api/attribution/range?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Contribution by holding for ANY date range — the PIM equity book, by sleeve
 * (Core / Managed Alpha / Individual Stocks), with the top 5 contributors and
 * detractors, names sold inside the range included, and a reconciliation
 * against the recorded performance series. A model-level ESTIMATE: see
 * `method` and `caveats` in the response.
 *
 * Holdings come from the SIA transaction log (pm:sia-transactions, actual
 * units) when one is loaded and switched on; `?source=tradelog` forces the
 * older rebuild from the dashboard's trade log.
 *
 * READ-ONLY. Reads pm:pim-models, pm:stocks, pm:pim-portfolio-state and
 * pm:pim-performance; fetches prices from Yahoo / the FUNDSERV NAV source.
 * Writes nothing and caches nothing. `from` empty = from the start of the
 * series; `to` empty = today. The existing /api/attribution (return
 * decomposition, preset periods) is unchanged.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Attribution-range");
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const from = q.get("from");
    const to = q.get("to");
    if ((from && !isDate(from)) || (to && !isDate(to))) return NextResponse.json({ ok: false, error: "from / to must be YYYY-MM-DD" }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    if (from && to && from > to) return NextResponse.json({ ok: false, error: "The start date is after the end date." }, { status: 400 });
    // Source of the holdings: the SIA transaction log (actual units) when one
    // is on file and switched on, else the dashboard's own trade log.
    // `?source=tradelog` forces the trade-log version — the way back.
    const want = q.get("source");
    const store = want === "tradelog" ? null : await readSiaStore();
    const siaOn = !!store && store.enabled !== false;
    if (siaOn) {
      const sia = await loadSiaRangeAttribution(from || null, to || today, store!);
      // If the SIA version cannot answer, fall back rather than show nothing.
      if (sia.ok) return NextResponse.json(sia);
      log.warn("SIA version failed, falling back to the trade log:", sia.error);
    }
    const out = await loadRangeAttribution(from || null, to || today);
    if (out.ok) {
      const onFile = want === "tradelog" ? await readSiaStore() : store;
      out.siaAvailable = !!onFile && onFile.enabled !== false;
    }
    return NextResponse.json(out, { status: out.ok ? 200 : 409 });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
