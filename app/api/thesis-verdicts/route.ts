import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import type { ThesisVerdict } from "@/app/lib/thesis-verdict";

/**
 * GET /api/thesis-verdicts — the thesis verdict of every HELD, underwritten
 * name: intact / challenged / broken, the roll-up of its cached pillar review
 * (app/lib/thesis-review); null until a review exists.
 *
 * Replaces /api/sleeve-verdicts, which covered Thesis-tagged names only (and
 * carried a Tactical-plan leg) before the Thesis/Tactical tags were retired.
 * Read-only, zero model spend — everything comes from loadAlertInputs(), the
 * same loader behind the alerts tile, the digest and the action queue.
 */

const log = createLogger("Thesis-verdicts");

export type ThesisVerdictEntry = { verdict: ThesisVerdict | null; generatedAt?: string };

export async function GET() {
  try {
    const { context, killWatch, thesisVerdicts } = await loadAlertInputs();
    const reviewByTicker = new Map(thesisVerdicts.map((v) => [v.ticker, v]));
    const verdicts: Record<string, ThesisVerdictEntry> = {};
    for (const k of killWatch) {
      if (context[k.ticker]?.bucket !== "Portfolio") continue;
      const r = reviewByTicker.get(k.ticker);
      verdicts[k.ticker] = { verdict: r?.verdict ?? null, generatedAt: r?.generatedAt };
    }
    return NextResponse.json({ verdicts });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ verdicts: {} });
  }
}
