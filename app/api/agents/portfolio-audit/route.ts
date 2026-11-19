import { NextResponse } from "next/server";
import { AUDIT_RULES, previewPortfolioAudit, runPortfolioAudit } from "@/app/lib/agents/portfolio-audit";

/**
 * GET  /api/agents/portfolio-audit — what the rule audit finds right now.
 *      Read-only: raises no flag, writes nothing.
 * POST /api/agents/portfolio-audit — run it now (raises each NEW finding as
 *      a flag, exactly as the nightly run does).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ mode: "PREVIEW — nothing raised", rules: AUDIT_RULES, ...(await previewPortfolioAudit()) });
}

export async function POST() {
  return NextResponse.json({ mode: "RUN", ...(await runPortfolioAudit()) });
}
