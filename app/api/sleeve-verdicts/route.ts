import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { tacticalVerdictOf, type TacticalVerdict } from "@/app/lib/tactical-plan";
import type { ThesisVerdict } from "@/app/lib/thesis-verdict";
import { canonicalTicker } from "@/app/lib/ticker";

/**
 * GET /api/sleeve-verdicts — one verdict per LEG for every held Alpha name.
 *
 *   thesis leg    intact / challenged / broken — roll-up of the cached pillar
 *                 review (app/lib/thesis-review); null until a review exists.
 *   tactical leg  hold-trade / take-profit / exit — deterministic, from the
 *                 position's own tactical plan; `hasPlan: false` when none.
 *
 * Read-only and zero model spend: everything comes from loadAlertInputs() (the
 * same loader behind the alerts tile, the digest and the action queue, so no
 * surface can disagree) plus the synthesis cache for the exit-watch floor.
 * Deliberately does NOT touch the synthesis prompt or its verdict vocabulary —
 * that cache is shared with production.
 */

const log = createLogger("Sleeve-verdicts");

export type LegVerdicts = {
  thesis?: { verdict: ThesisVerdict | null; generatedAt?: string };
  tactical?: { verdict: TacticalVerdict | null; hasPlan: boolean; reasons: string[] };
};

export async function GET() {
  try {
    const { context, tacticalWatch, thesisVerdicts } = await loadAlertInputs();
    let synth: Record<string, { result?: { verdict?: string } }> = {};
    try {
      const raw = await (await getRedis()).get("pm:synthesis-screen-cache");
      synth = raw ? JSON.parse(raw) : {};
    } catch {
      synth = {};
    }
    const planByTicker = new Map(tacticalWatch.map((t) => [t.ticker, t]));
    const reviewByTicker = new Map(thesisVerdicts.map((v) => [v.ticker, v]));

    const verdicts: Record<string, LegVerdicts> = {};
    for (const [tk, c] of Object.entries(context)) {
      if (c.bucket !== "Portfolio" || !c.sleeves || (!c.sleeves.thesis && !c.sleeves.tactical)) continue;
      const out: LegVerdicts = {};
      if (c.sleeves.thesis) {
        const r = reviewByTicker.get(tk);
        out.thesis = { verdict: r?.verdict ?? null, generatedAt: r?.generatedAt };
      }
      if (c.sleeves.tactical) {
        const p = planByTicker.get(tk);
        if (!p) out.tactical = { verdict: null, hasPlan: false, reasons: [] };
        else {
          const sv = (synth[canonicalTicker(tk)] ?? synth[tk])?.result?.verdict ?? null;
          const v = tacticalVerdictOf({ flags: p.flags, synthesisVerdict: sv });
          out.tactical = { verdict: v.verdict, hasPlan: true, reasons: v.reasons };
        }
      }
      verdicts[tk] = out;
    }
    return NextResponse.json({ verdicts });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ verdicts: {} });
  }
}
