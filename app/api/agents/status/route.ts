import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { WATCHERS } from "@/app/lib/agents/registry";
import { readAgentSettings, modelFor } from "@/app/lib/agents/settings";
import { spendSummary } from "@/app/lib/agents/spend";
import { agentsKeyState } from "@/app/lib/agents/gateway";

/**
 * GET /api/agents/status — read-only: the agents key state (never the key),
 * this month's spend against the $90 stop / $100 cap, and each watcher's
 * model. Feeds the Monitor page.
 */

const log = createLogger("Agents-status");
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [settings, spend] = await Promise.all([readAgentSettings(), spendSummary()]);
    return NextResponse.json({
      key: agentsKeyState(),
      paused: !!settings.paused,
      spend,
      watchers: WATCHERS.map((w) => ({
        id: w.id,
        label: w.label,
        phase: w.phase,
        what: w.what,
        model: modelFor(w.id, settings),
        defaultModel: w.defaultModel,
        shadow: w.shadow ?? null,
      })),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "status unavailable" }, { status: 500 });
  }
}
